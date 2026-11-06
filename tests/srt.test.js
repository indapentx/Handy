import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, cuesForDisplay, decodeSubtitleBytes, guessLanguage, parseSubtitles } from '../srt.js';

const SRT = `1
00:00:00,660 --> 00:00:05,380
Wie macht man eigentlich einen Führerschein in Deutschland?

2
00:00:05,980 --> 00:00:12,500
Das wollen wir heute herausfinden.
Zweite Zeile.
`;

test('parses cues with times in seconds', () => {
  const cues = parseSubtitles(SRT);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0.66, end: 5.38, text: 'Wie macht man eigentlich einen Führerschein in Deutschland?' });
  assert.equal(cues[1].text, 'Das wollen wir heute herausfinden.\nZweite Zeile.');
});

test('handles CRLF, a BOM and extra blank lines', () => {
  const cues = parseSubtitles(`﻿${SRT.replace(/\n/g, '\r\n')}\r\n\r\n`);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].end, 12.5);
});

test('copes with missing blank lines between cues', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nHallo\n2\n00:00:02,500 --> 00:00:03,000\nWelt\n');
  assert.deepEqual(cues.map((c) => c.text), ['Hallo', 'Welt']);
});

test('keeps a cue whose text is only a number', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n42\n\n2\n00:00:03,000 --> 00:00:04,000\nZweiundvierzig\n');
  assert.deepEqual(cues.map((c) => c.text), ['42', 'Zweiundvierzig']);
});

test('strips formatting tags', () => {
  assert.equal(cleanText('{\\an8}<i>Hallo</i> <font color="#fff">du</font>'), 'Hallo du');
  assert.equal(cleanText('Zeile eins\\NZeile zwei'), 'Zeile eins\nZeile zwei');
  assert.equal(cleanText('Tom &amp; Jerry &lt;3'), 'Tom & Jerry <3');
});

test('parses WebVTT with a header, notes, ids and cue settings', () => {
  const vtt = 'WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.500 --> 00:03.000 align:start position:10%\n<v Anna>Guten Morgen</v>\n\n01:00:00.000 --> 01:00:01.250\n<c.yellow>Ende</c>\n';
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 1.5, end: 3, text: 'Guten Morgen' },
    { start: 3600, end: 3601.25, text: 'Ende' },
  ]);
});

test('reads short fractions and dot separators', () => {
  const [cue] = parseSubtitles('1\n0:00:01.5 --> 0:00:02.25\nKurz\n');
  assert.equal(cue.start, 1.5);
  assert.equal(cue.end, 2.25);
});

test('sorts cues and drops empty ones', () => {
  const cues = parseSubtitles('2\n00:00:05,000 --> 00:00:06,000\nB\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:07,000 --> 00:00:08,000\n<i></i>\n');
  assert.deepEqual(cues.map((c) => c.text), ['A', 'B']);
});

test('gives zero-length cues a short duration', () => {
  const [cue] = parseSubtitles('1\n00:00:04,000 --> 00:00:04,000\nBlitz\n');
  assert.ok(cue.end > cue.start);
});

test('returns nothing for text without timings', () => {
  assert.deepEqual(parseSubtitles('hello\nworld'), []);
  assert.deepEqual(parseSubtitles(''), []);
});

const bytes = (...parts) => new Uint8Array(parts.flat());
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const utf16le = (s) => [...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
const utf16be = (s) => [...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]);

test('decodes UTF-8 with and without a BOM', () => {
  const utf8 = [...new TextEncoder().encode('Grüße')];
  assert.equal(decodeSubtitleBytes(bytes(utf8)), 'Grüße');
  assert.equal(decodeSubtitleBytes(bytes([0xef, 0xbb, 0xbf], utf8)), 'Grüße');
});

test('decodes old Windows-1252 German files', () => {
  const western = bytes(ascii('Gr'), 0xfc, 0xdf, ascii('e, sch'), 0xf6, ascii('n'));
  assert.equal(decodeSubtitleBytes(western), 'Grüße, schön');
});

test('decodes old Windows-1254 Turkish files', () => {
  const turkish = bytes(ascii('I'), 0xf0, ascii('d'), 0xfd, ascii("r'da k"), 0xfd, 0xfe);
  assert.equal(decodeSubtitleBytes(turkish), "Iğdır'da kış");
});

test('uses the file name to spot Turkish when the text gives few clues', () => {
  const b = bytes(ascii('ba'), 0xfe);
  assert.equal(decodeSubtitleBytes(b, 'video_TR.srt'), 'baş');
  assert.equal(decodeSubtitleBytes(b, 'video.srt'), 'baþ');
});

test('decodes UTF-16 with and without a BOM', () => {
  const text = '1\n00:00:01,000 --> 00:00:02,000\nÄpfel\n';
  assert.equal(decodeSubtitleBytes(bytes([0xff, 0xfe], utf16le(text))), text);
  assert.equal(decodeSubtitleBytes(bytes([0xfe, 0xff], utf16be(text))), text);
  assert.equal(decodeSubtitleBytes(bytes(utf16le(text))), text);
});

test('finds the cue on screen, with an optional hold after it ends', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:03,000\nA\n\n2\n00:00:10,000 --> 00:00:12,000\nB\n');
  assert.deepEqual(cuesForDisplay(cues, 0.5), []);
  assert.deepEqual(cuesForDisplay(cues, 1), [0]);
  assert.deepEqual(cuesForDisplay(cues, 2.999), [0]);
  assert.deepEqual(cuesForDisplay(cues, 3), []); // playing: gone when it ends
  assert.deepEqual(cuesForDisplay(cues, 4.5, 2), [0]); // paused 1.5 s late: still shown
  assert.deepEqual(cuesForDisplay(cues, 5.5, 2), []); // more than 2 s late: gone
  assert.deepEqual(cuesForDisplay(cues, 11, 2), [1]);
  assert.deepEqual(cuesForDisplay([], 1, 2), []);
});

test('shows overlapping cues together', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:10,000\nLang\n\n2\n00:00:02,000 --> 00:00:03,000\nKurz\n');
  assert.deepEqual(cuesForDisplay(cues, 2.5), [0, 1]);
  assert.deepEqual(cuesForDisplay(cues, 5), [0]);
});

test('guesses German, Turkish and English', () => {
  assert.equal(guessLanguage('Das ist nicht so schwer, aber wir müssen die Prüfung bestehen und das Gefühl ist gut. Ich weiß es.'), 'de');
  assert.equal(guessLanguage("Almanya'da ehliyet aslında nasıl alınır? Bu çok zor değil ama biraz zaman alıyor."), 'tr');
  assert.equal(guessLanguage('What is this? You know that it is one of the best.'), 'en');
  assert.equal(guessLanguage('Merhaba', 'video_TR.srt'), 'tr');
  assert.equal(guessLanguage('12345'), '');
});
