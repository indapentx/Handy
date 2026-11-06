// Subtitle files (SRT and WebVTT): turn file bytes into timed cues.
// Pure functions with no dependencies, so they run in the browser and in Node tests.

export const LANGUAGE_NAMES = { de: 'Deutsch', tr: 'Türkçe', en: 'English' };

const TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?`;
const TIMING = new RegExp(String.raw`^\s*${TIME}\s*-->\s*${TIME}`);

/**
 * Decodes a subtitle file's bytes into text. Handles UTF-8 (with or without BOM) and UTF-16.
 * Anything else is treated as an old 8-bit file: Windows-1252 (Western), or Windows-1254
 * when the text looks Turkish.
 */
export function decodeSubtitleBytes(input, fileName = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const utf16 = utf16Kind(bytes);
  if (utf16) return new TextDecoder(utf16).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8, so it is an older 8-bit file.
  }
  const western = new TextDecoder('windows-1252').decode(bytes);
  return looksLikeTurkish(western, fileName) ? new TextDecoder('windows-1254').decode(bytes) : western;
}

function utf16Kind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  // No BOM: mostly-ASCII UTF-16 text has a zero byte in every other position.
  const n = Math.min(bytes.length, 512) & ~1;
  if (n < 8) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const pairs = n / 2;
  if (oddZeros > pairs * 0.3 && evenZeros < pairs * 0.05) return 'utf-16le';
  if (evenZeros > pairs * 0.3 && oddZeros < pairs * 0.05) return 'utf-16be';
  return null;
}

// Read as Windows-1252, the Turkish letters ğ ı ş Ğ İ Ş of Windows-1254 turn into ð ý þ Ð Ý Þ,
// which hardly ever occur in German or English text.
function looksLikeTurkish(text, fileName) {
  const hits = (text.match(/[ðýþÐÝÞ]/g) || []).length;
  return hits >= 3 || (hits > 0 && nameHasCode(fileName, 'tr'));
}

// True when a file name carries a language code, like "video_TR.srt" or "video.de.srt".
function nameHasCode(fileName, code) {
  const base = String(fileName).replace(/\.[^.]*$/, '');
  return new RegExp(String.raw`(^|[._\-\s])${code}([._\-\s]|$)`, 'i').test(base);
}

/** Parses SRT or WebVTT text into cues: [{ start, end, text }] in seconds, sorted by start. */
export function parseSubtitles(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const cues = [];
  let cue = null;

  const finish = () => {
    const clean = cleanText(cue.lines.join('\n'));
    if (clean) cues.push({ start: cue.start, end: Math.max(cue.end, cue.start + 0.3), text: clean });
    cue = null;
  };

  for (const line of lines) {
    const m = TIMING.exec(line);
    if (m) {
      if (cue) {
        // Without a blank line between cues, the next cue's number lands in this cue's text.
        const last = cue.lines[cue.lines.length - 1];
        if (last !== undefined && /^\s*\d+\s*$/.test(last)) cue.lines.pop();
        finish();
      }
      cue = { start: toSeconds(m, 1), end: toSeconds(m, 5), lines: [] };
    } else if (cue) {
      if (line.trim()) cue.lines.push(line);
      else if (cue.lines.length) finish();
    }
  }
  if (cue) finish();
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function toSeconds(m, i) {
  const hours = m[i] ? Number(m[i]) : 0;
  const fraction = m[i + 3] ? Number(`${m[i + 3]}00`.slice(0, 3)) / 1000 : 0;
  const total = hours * 3600 + Number(m[i + 1]) * 60 + Number(m[i + 2]) + fraction;
  return Math.round(total * 1000) / 1000;
}

/** Removes formatting (<i>, <font>, {\an8}, VTT voice/class tags) and tidies whitespace. */
export function cleanText(raw) {
  return String(raw)
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/<\d+:\d+[\d:.]*>/g, '')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Indexes of the cues to show at time `t` (seconds): usually none or one, more when cues overlap.
 * With `holdSeconds` > 0 (used while paused) and nothing else on screen, the line that ended
 * within the last `holdSeconds` stays visible, so a slightly late pause can still read it.
 */
export function cuesForDisplay(cues, t, holdSeconds = 0) {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1; // the last cue that starts at or before t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const active = [];
  let recent = -1;
  for (let i = last; i >= 0 && i > last - 25; i--) {
    if (t < cues[i].end) active.unshift(i);
    else if (recent < 0 || cues[i].end > cues[recent].end) recent = i;
  }
  if (active.length) return active;
  if (holdSeconds > 0 && recent >= 0 && t - cues[recent].end <= holdSeconds) return [recent];
  return [];
}

const WORDS = {
  de: /(?:^|[^\p{L}])(?:und|der|die|das|ist|nicht|ich|wir|ein|eine|mit|auch|aber|sie|zu|es)(?=[^\p{L}]|$)/giu,
  tr: /(?:^|[^\p{L}])(?:ve|bir|bu|için|çok|değil|ama|gibi|daha|ne|ben|sen|var|yok|mı|mi)(?=[^\p{L}]|$)/giu,
  en: /(?:^|[^\p{L}])(?:the|and|is|you|that|it|of|to|what|this|with|for|are)(?=[^\p{L}]|$)/giu,
};
const LETTERS = { de: /[äÄß]/g, tr: /[ığşĞŞİ]/g };

/** Guesses 'de', 'tr' or 'en' from the text and file name, or '' when unsure. */
export function guessLanguage(text, fileName = '') {
  const sample = String(text).slice(0, 30000);
  let best = '';
  let bestScore = 0;
  for (const code of Object.keys(WORDS)) {
    let score = (sample.match(WORDS[code]) || []).length;
    if (LETTERS[code]) score += 2 * (sample.match(LETTERS[code]) || []).length;
    if (nameHasCode(fileName, code)) score += 1000;
    if (score > bestScore) {
      best = code;
      bestScore = score;
    }
  }
  return bestScore >= 5 ? best : '';
}
