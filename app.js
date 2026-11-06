// Handy: a video player for language learners. Touch anywhere on the video to pause.
import { LANGUAGE_NAMES, cuesForDisplay, decodeSubtitleBytes, guessLanguage, parseSubtitles } from './srt.js';

const SPEEDS = [0.5, 0.6, 0.65, 0.7, 0.8, 0.9, 1];
const DEFAULT_SPEED = 0.65;
const SETTINGS_VERSION = 2; // 2: default speed became 0.65×
const SIZES = [['s', 'S'], ['m', 'M'], ['l', 'L']];
const STYLES = [['apple', 'Apple'], ['classic', 'Classic'], ['outline', 'Outline']];
const MODES = ['one', 'two', 'both', 'off'];
const HOLD_SECONDS = 2; // a line stays on screen if you pause up to 2 s after it ended
const RESUME_REWIND = 2; // when continuing a video, start 2 s before where you stopped
const MAX_RECENT = 20;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp)$/i;
const SUBTITLE_EXT = /\.(srt|vtt)$/i;

const $ = (id) => document.getElementById(id);
const home = $('home');
const player = $('player');
const video = $('video');
const seek = $('seek');
const fsBtn = $('fsBtn');
const notice = $('notice');
const speedSheet = $('speedSheet');
const subsSheet = $('subsSheet');
const sheets = [speedSheet, subsSheet];
const lineEls = [$('line1'), $('line2')];

// ---------- storage ----------

const PREFIX = 'handy.v1.';
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // storage unavailable
    }
  },
};

const storedSettings = store.get('settings', {});
const settings = { speed: DEFAULT_SPEED, mode: 'one', size: 'm', style: 'apple', ...storedSettings };
if (!SPEEDS.includes(settings.speed)) settings.speed = DEFAULT_SPEED;
if (!MODES.includes(settings.mode)) settings.mode = 'one';
if (!SIZES.some(([value]) => value === settings.size)) settings.size = 'm';
if (!STYLES.some(([value]) => value === settings.style)) settings.style = 'apple';
const saveSettings = () => store.set('settings', settings);
if (storedSettings.v !== SETTINGS_VERSION) {
  // Settings saved by the first version start at the new default speed.
  settings.speed = DEFAULT_SPEED;
  settings.v = SETTINGS_VERSION;
  saveSettings();
}

function recentVideos() {
  const list = store.get('recent', []);
  return Array.isArray(list) ? list : [];
}

function rememberVideo(entry) {
  const list = recentVideos().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  while (list.length > MAX_RECENT) store.remove(`subs.${list.pop().id}`);
  store.set('recent', list);
}

function forgetVideo(id) {
  store.set('recent', recentVideos().filter((e) => e.id !== id));
  store.remove(`subs.${id}`);
}

function saveSubtitles(id, list) {
  const data = list.map(({ name, text }) => ({ name, text }));
  if (store.set(`subs.${id}`, data)) return;
  // Storage is full: drop the subtitles of the oldest videos until these fit.
  const videos = recentVideos();
  for (let i = videos.length - 1; i >= 0; i--) {
    if (videos[i].id === id) continue;
    store.remove(`subs.${videos[i].id}`);
    if (store.set(`subs.${id}`, data)) return;
  }
}

// ---------- state ----------

let current = null; // the open video: { id, name, size, url, input, known, loaded, resumeAt, ready }
let tracks = []; // up to two subtitle tracks, German first: { name, text, lang, cues, label, code }
let ignoreNextClick = false; // the click that ends the pausing touch must not resume playback
let lockedPointer = null;
let seeking = false;
let seekByPointer = false;
let rafId = 0;
let lastSave = 0;
let wakeLock = null;
let wakeLockPending = false;
const shown = [{ text: '', track: '' }, { text: '', track: '' }];

// ---------- subtitle tracks ----------

const stripExtension = (name) => name.replace(/\.[^.]+$/, '');

function makeTrack(name, text) {
  return { name, text, lang: guessLanguage(text, name), cues: parseSubtitles(text), label: '', code: '' };
}

// Keeps at most two tracks, German first (the language being learned), and names them.
function arrangeTracks(list) {
  const sorted = list.slice(0, 2).sort((a, b) => (b.lang === 'de') - (a.lang === 'de') || a.name.localeCompare(b.name));
  const sameLanguage = sorted.length === 2 && sorted[0].lang === sorted[1].lang;
  sorted.forEach((track, i) => {
    const named = Boolean(track.lang) && !sameLanguage;
    track.label = named ? LANGUAGE_NAMES[track.lang] : stripExtension(track.name);
    track.code = named ? track.lang.toUpperCase() : String(i + 1);
  });
  return sorted;
}

async function readSubtitleFiles(files) {
  const result = [];
  for (const file of files) {
    try {
      const text = decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      const track = makeTrack(file.name, text);
      if (track.cues.length) result.push(track);
      else toast(`No subtitles found in ${file.name}`);
    } catch {
      toast(`Couldn't read ${file.name}`);
    }
  }
  return result;
}

function addTracks(newTracks) {
  if (!current || !newTracks.length) return;
  // Up to two in total: add to what's loaded, or replace it when there's no room.
  const keep = tracks.length + newTracks.length > 2 ? [] : tracks.filter((t) => !newTracks.some((n) => n.name === t.name));
  tracks = arrangeTracks([...keep, ...newTracks]);
  afterTracksChanged();
  toast(`Subtitles: ${tracks.map((t) => t.label).join(' + ')}`);
}

function removeTrack(index) {
  tracks = arrangeTracks(tracks.filter((_, i) => i !== index));
  afterTracksChanged();
}

function afterTracksChanged() {
  if (current) saveSubtitles(current.id, tracks);
  renderSubtitleButton();
  renderSubs();
  if (!subsSheet.hidden) renderSubsSheet();
}

// ---------- opening files ----------

const isVideoFile = (f) => VIDEO_EXT.test(f.name) || (f.type || '').startsWith('video/');
const isSubtitleFile = (f) => SUBTITLE_EXT.test(f.name);

// Opens the system file picker with a fresh <input>. The input that delivered the open video
// stays in the page until that video is closed, so iOS keeps the picked file readable.
function chooseFiles(onPicked) {
  for (const old of document.querySelectorAll('input.picker:not([data-in-use])')) old.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'picker';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.addEventListener('change', () => onPicked(Array.from(input.files || []), input));
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

async function openFiles(files, input) {
  const videos = files.filter(isVideoFile);
  const subtitleFiles = files.filter((f) => !isVideoFile(f) && isSubtitleFile(f));
  if (!videos.length && !subtitleFiles.length) {
    if (files.length) toast('Pick a video and its .srt subtitle file.');
    input?.remove();
    return;
  }
  const newTracks = await readSubtitleFiles(subtitleFiles);
  if (videos.length) {
    openVideo(videos[0], newTracks, input);
    if (videos.length > 1) toast(`Opened ${videos[0].name}. Pick one video at a time.`);
    return;
  }
  input?.remove();
  if (current) addTracks(newTracks);
  else if (newTracks.length) toast('Open the video too: pick it together with the .srt file.');
}

async function loadSubtitleFiles(files, input) {
  const subtitleFiles = files.filter(isSubtitleFile);
  const newTracks = await readSubtitleFiles(subtitleFiles);
  input?.remove();
  if (files.length && !subtitleFiles.length) toast('Pick .srt or .vtt files here.');
  else addTracks(newTracks);
}

function openVideo(file, newTracks, input) {
  closeVideo();
  const id = `${file.name}|${file.size}`;
  const saved = recentVideos().find((e) => e.id === id);
  const finished = saved && saved.duration && saved.position > saved.duration - 10;
  const resumeAt = saved && saved.position > 5 && !finished ? Math.max(0, saved.position - RESUME_REWIND) : 0;
  if (input) input.dataset.inUse = '';
  current = {
    id,
    name: file.name,
    size: file.size,
    url: URL.createObjectURL(file),
    input,
    known: Boolean(saved),
    loaded: false,
    resumeAt,
    ready: !resumeAt,
  };

  if (newTracks.length) {
    tracks = arrangeTracks(newTracks);
    saveSubtitles(id, tracks);
  } else {
    const stored = store.get(`subs.${id}`, []);
    const list = Array.isArray(stored) ? stored : [];
    tracks = arrangeTracks(list.map((s) => makeTrack(s.name, s.text)).filter((t) => t.cues.length));
  }
  rememberVideo({ id, name: file.name, size: file.size, position: saved?.position || 0, duration: saved?.duration || 0, updated: Date.now() });

  $('title').textContent = stripExtension(file.name);
  hideNotice();
  closeSheets();
  video.defaultPlaybackRate = settings.speed;
  video.playbackRate = settings.speed;
  video.src = current.url;
  video.load();

  home.hidden = true;
  player.hidden = false;
  document.body.classList.add('watching');
  player.classList.add('paused', 'fresh');
  renderSubtitleButton();
  renderSubs();
  updateControls();
  keepScreenOn(true);

  if (newTracks.length > 2) toast('Only two subtitle files fit, so the first two are used.');
  else if (resumeAt) toast(`Continuing at ${formatTime(resumeAt)}`);
  else if (!tracks.length) toast('No subtitles yet: tap CC to load an .srt file.');
}

function closeVideo() {
  if (!current) return;
  savePosition();
  video.pause();
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(current.url);
  current.input?.remove();
  current = null;
  tracks = [];
}

function goHome() {
  closeVideo();
  closeSheets();
  hideNotice();
  setLocked(false);
  exitFullscreen();
  keepScreenOn(false);
  player.hidden = true;
  home.hidden = false;
  document.body.classList.remove('watching');
  renderRecent();
}

function savePosition() {
  if (!current || !current.ready) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) return;
  lastSave = Date.now();
  rememberVideo({ id: current.id, name: current.name, size: current.size, position: video.currentTime, duration, updated: lastSave });
}

// ---------- playback ----------

function pauseNow() {
  video.pause();
  player.classList.add('paused');
  renderSubs();
  fitSubs(); // the controls take room while paused
  updateControls();
}

async function playNow() {
  if (!current) return;
  closeSheets();
  keepScreenOn(true);
  try {
    await video.play();
  } catch (err) {
    if (err?.name === 'NotAllowedError') toast('Tap again to play.');
  }
}

const togglePlay = () => (video.paused || video.ended ? playNow() : pauseNow());

function seekBy(delta) {
  if (!current || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, video.duration - 0.05));
  renderSubs();
  updateControls();
}

function setSpeed(value) {
  settings.speed = value;
  saveSettings();
  video.defaultPlaybackRate = value;
  video.playbackRate = value;
  updateControls();
}

function stepSpeed(step) {
  const i = SPEEDS.indexOf(settings.speed);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + step))];
  if (next !== settings.speed) setSpeed(next);
  toast(`Speed ${next}×`);
}

video.preservesPitch = true;
if ('webkitPreservesPitch' in video) video.webkitPreservesPitch = true;

video.addEventListener('play', () => {
  player.classList.remove('paused', 'fresh');
  closeSheets();
  fitSubs();
  startLoop();
});
video.addEventListener('pause', () => {
  player.classList.add('paused');
  renderSubs();
  fitSubs();
  updateControls();
  savePosition();
});
video.addEventListener('ended', () => {
  player.classList.add('paused');
  updateControls();
});
video.addEventListener('seeked', () => {
  renderSubs();
  updateControls();
});
video.addEventListener('timeupdate', () => {
  if (video.paused) {
    renderSubs();
    updateControls();
  }
  if (Date.now() - lastSave > 3000) savePosition();
});
video.addEventListener('durationchange', updateControls);
video.addEventListener('ratechange', updateControls);
video.addEventListener('loadedmetadata', () => {
  if (!current) return;
  current.loaded = true;
  if (!current.ready) {
    video.currentTime = Math.min(current.resumeAt, Math.max(0, video.duration - 1));
    current.ready = true;
  }
  video.playbackRate = settings.speed;
  renderSubs();
  updateControls();
  if (!video.videoWidth && !video.videoHeight) {
    showNotice('This device can’t show the picture of this video, so you may only hear the sound. It’s probably encoded as AV1 or VP9.', true);
  }
});
video.addEventListener('error', () => {
  if (!current || !video.getAttribute('src')) return;
  if (video.error?.code === 2) {
    // MEDIA_ERR_NETWORK: the picked file can't be read any more (iOS can drop access to it).
    showNotice('The video file can’t be read any more. Open it again: your place is saved.', false, false);
    return;
  }
  // A file that never played shouldn't show up under "Continue watching".
  if (!current.loaded && !current.known) forgetVideo(current.id);
  const ext = (current.name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  const reason = ['mkv', 'webm', 'avi'].includes(ext)
    ? `.${ext} videos don’t play in Safari on iPhone.`
    : 'It’s probably encoded as AV1 or VP9, which this device can’t decode.';
  showNotice(`This video can’t be played here. ${reason}`, false);
});

// ---------- drawing ----------

function frame() {
  rafId = 0;
  renderSubs();
  renderProgress();
  if (!video.paused && !video.ended) rafId = requestAnimationFrame(frame);
}

function startLoop() {
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function effectiveMode() {
  if (!tracks.length) return 'off';
  if (tracks.length === 1) return settings.mode === 'off' ? 'off' : 'one';
  return settings.mode;
}

const visibleTracks = () => ({ one: [0], two: [1], both: [0, 1], off: [] })[effectiveMode()];

function renderSubs() {
  const t = video.currentTime || 0;
  const hold = video.paused ? HOLD_SECONDS : 0;
  const order = visibleTracks();
  let changed = false;
  for (let slot = 0; slot < 2; slot++) {
    const index = order[slot];
    const track = tracks[index];
    const text = track ? cuesForDisplay(track.cues, t, hold).map((i) => track.cues[i].text).join('\n') : '';
    const key = track ? String(index) : '';
    if (text === shown[slot].text && key === shown[slot].track) continue;
    shown[slot] = { text, track: key };
    changed = true;
    const el = lineEls[slot];
    el.dataset.track = key;
    el.firstElementChild.textContent = text;
    el.hidden = !text;
    el.classList.toggle('long', text.length > 140);
    el.classList.toggle('xlong', text.length > 240);
  }
  if (changed) fitSubs();
}

// Very long cues at big sizes could run off the screen. Only those get shrunk, just enough to
// fit between the top of the screen (or the top bar while paused) and the bottom controls.
const subsEl = $('subs');
const portrait = matchMedia('(orientation: portrait)');

function linesBox() {
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of lineEls) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return top < bottom ? { top, bottom } : null;
}

function roomFor(box) {
  if (portrait.matches) {
    // Subtitles hang below the video and must stay above the space kept for the controls.
    const stage = $('stage');
    return stage.getBoundingClientRect().bottom - parseFloat(getComputedStyle(stage).paddingBottom) - box.top;
  }
  // Subtitles sit on the bottom of the video and grow upwards.
  const topBarShown = player.classList.contains('paused') && !player.classList.contains('locked');
  const limit = topBarShown ? document.querySelector('.controls.top').getBoundingClientRect().bottom - 16 : 8;
  return box.bottom - limit;
}

function fitSubs() {
  subsEl.style.setProperty('--fit', '1');
  for (let pass = 0; pass < 2; pass++) {
    const box = linesBox();
    if (!box) return;
    const needed = box.bottom - box.top;
    const room = roomFor(box);
    if (needed <= room) return;
    const fit = Number(subsEl.style.getPropertyValue('--fit')) || 1;
    subsEl.style.setProperty('--fit', Math.max(0.4, fit * Math.sqrt(room / needed) * 0.97).toFixed(3));
  }
}
window.addEventListener('resize', fitSubs);

function renderProgress() {
  const d = video.duration;
  const p = Number.isFinite(d) && d > 0 ? Math.min(1, video.currentTime / d) : 0;
  $('progressFill').style.transform = `scaleX(${p})`;
}

function updateControls() {
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  const t = video.currentTime || 0;
  seek.disabled = !d;
  seek.max = String(d);
  if (!seeking) seek.value = String(t);
  seek.style.setProperty('--p', `${d ? Math.min(100, (t / d) * 100) : 0}%`);
  $('timeNow').textContent = formatTime(t);
  $('timeTotal').textContent = d ? formatTime(d) : '--:--';
  $('speedBtn').textContent = `${settings.speed}×`;
  renderProgress();
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------- subtitle choice and menus ----------

function availableModes() {
  if (tracks.length >= 2) return MODES;
  return tracks.length ? ['one', 'off'] : [];
}

function modeLabel(mode) {
  if (mode === 'off') return 'Off';
  if (mode === 'both') return 'Both';
  return tracks[mode === 'one' ? 0 : 1].label;
}

function setMode(mode) {
  settings.mode = mode;
  saveSettings();
  renderSubtitleButton();
  renderSubs();
  if (!subsSheet.hidden) renderSubsSheet();
}

function cycleSubtitles() {
  const modes = availableModes();
  if (!modes.length) {
    toast('No subtitles loaded. Tap CC to add an .srt file.');
    return;
  }
  const next = modes[(modes.indexOf(effectiveMode()) + 1) % modes.length];
  setMode(next);
  if (next === 'off') toast('Subtitles off');
  else if (next === 'both') toast(`${tracks[0].label} + ${tracks[1].label}`);
  else toast(modeLabel(next));
}

function renderSubtitleButton() {
  const mode = effectiveMode();
  const code = (i) => tracks[i].code;
  let label = 'CC';
  if (tracks.length) label = mode === 'off' ? 'Off' : mode === 'both' ? `${code(0)}+${code(1)}` : code(mode === 'one' ? 0 : 1);
  $('ccLabel').textContent = label;
  $('ccBtn').classList.toggle('dim', mode === 'off');
  player.dataset.size = settings.size;
  player.dataset.style = settings.style;
}

function choiceButton(label, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  button.textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function renderSpeedSheet() {
  $('speedChoices').replaceChildren(
    ...SPEEDS.map((s) => choiceButton(`${s}×`, s === settings.speed, () => {
      setSpeed(s);
      closeSheets();
    })),
  );
}

function renderSubsSheet() {
  const mode = effectiveMode();
  $('noSubs').hidden = tracks.length > 0;
  $('modeChoices').replaceChildren(...availableModes().map((m) => choiceButton(modeLabel(m), m === mode, () => setMode(m))));
  $('trackList').replaceChildren(
    ...tracks.map((track, i) => {
      const item = document.createElement('li');
      item.dataset.track = String(i);
      const dot = document.createElement('span');
      dot.className = 'dot';
      const name = document.createElement('span');
      name.className = 'track-name';
      name.textContent = track.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${track.name}`);
      remove.addEventListener('click', () => removeTrack(i));
      item.append(dot, name, remove);
      return item;
    }),
  );
  $('addSubsBtn').textContent = tracks.length >= 2 ? 'Replace subtitle files…' : tracks.length ? 'Add a second subtitle file…' : 'Load subtitle file…';
  $('styleChoices').replaceChildren(
    ...STYLES.map(([value, label]) => choiceButton(label, settings.style === value, () => {
      settings.style = value;
      saveSettings();
      renderSubtitleButton();
      fitSubs();
      renderSubsSheet();
    })),
  );
  $('sizeChoices').replaceChildren(
    ...SIZES.map(([value, label]) => choiceButton(label, settings.size === value, () => {
      settings.size = value;
      saveSettings();
      renderSubtitleButton();
      fitSubs();
      renderSubsSheet();
    })),
  );
}

const sheetOpen = () => sheets.some((s) => !s.hidden);

function toggleSheet(sheet) {
  const opening = sheet.hidden;
  closeSheets();
  if (!opening) return;
  if (sheet === speedSheet) renderSpeedSheet();
  else renderSubsSheet();
  sheet.hidden = false;
  player.classList.add('sheet-open');
}

function closeSheets() {
  for (const sheet of sheets) sheet.hidden = true;
  player.classList.remove('sheet-open');
}

function showNotice(text, canKeepWatching, formatProblem = true) {
  $('noticeText').textContent = text;
  $('noticeHelp').hidden = !formatProblem;
  $('noticeClose').hidden = !canKeepWatching;
  closeSheets();
  notice.hidden = false;
  player.classList.add('has-notice');
}

function hideNotice() {
  notice.hidden = true;
  player.classList.remove('has-notice');
}

// ---------- touch anywhere to pause ----------

const isControl = (el) => el instanceof Element && Boolean(el.closest('button, input, .sheet, #notice'));

// Pausing happens the moment a finger (or mouse button) goes down. Playing waits for the tap's
// click, because browsers only let a page start sound from a completed tap.
player.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (isControl(e.target) || !notice.hidden || !current) return;
  if (sheetOpen()) {
    closeSheets();
    ignoreNextClick = true;
    return;
  }
  if (!video.paused && !video.ended) {
    pauseNow();
    ignoreNextClick = true;
    lockedPointer = e.pointerId;
    player.classList.add('ui-locked');
  } else {
    ignoreNextClick = false;
  }
});

function releaseLock(e) {
  if (e.pointerId !== lockedPointer) return;
  lockedPointer = null;
  // iOS picks the target of a tap's click after the finger lifts, so the buttons that just
  // appeared stay inert a little longer and can't catch the pausing tap.
  setTimeout(() => {
    if (lockedPointer === null) player.classList.remove('ui-locked');
  }, 350);
}
window.addEventListener('pointerup', releaseLock);
window.addEventListener('pointercancel', releaseLock);

player.addEventListener('click', (e) => {
  if (isControl(e.target)) return;
  if (ignoreNextClick) {
    ignoreNextClick = false;
    return;
  }
  if (!notice.hidden || !current) return;
  if (video.paused || video.ended) playNow();
});

// A mouse click leaves focus on the button; drop it so Space keeps meaning pause/play.
player.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('button') : null;
  if (button && e.detail > 0) button.blur();
}, true);

player.addEventListener('contextmenu', (e) => {
  if (!isControl(e.target) || e.target.closest('#lockBtn')) e.preventDefault();
});

// ---------- hide-controls lock ----------
// Tap the eye button to hide every control, even while paused. Tapping anywhere still pauses and
// plays, the lock button included. Holding the lock button for 0.6 s brings the controls back.

const lockBtn = $('lockBtn');
const HOLD_TO_UNLOCK_MS = 600;
let holdTimer = 0;
let unlockedByHold = false;
let lockDownWasPaused = false;
const isLocked = () => player.classList.contains('locked');

function setLocked(on, announce = true) {
  player.classList.toggle('locked', on);
  lockBtn.setAttribute('aria-label', on ? 'Hold to show controls' : 'Hide controls');
  closeSheets();
  fitSubs();
  if (on && announce) toast('Controls hidden. Hold the lock button to bring them back.');
}

lockBtn.addEventListener('pointerdown', (e) => {
  if (!isLocked() || !e.isPrimary) return;
  lockDownWasPaused = video.paused || video.ended;
  if (!lockDownWasPaused) pauseNow(); // same instant pause as anywhere else
  lockBtn.classList.add('holding');
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    unlockedByHold = true;
    lockBtn.classList.remove('holding');
    setLocked(false);
  }, HOLD_TO_UNLOCK_MS);
});

const endHold = () => {
  clearTimeout(holdTimer);
  lockBtn.classList.remove('holding');
};
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) lockBtn.addEventListener(type, endHold);

lockBtn.addEventListener('click', () => {
  if (unlockedByHold) {
    unlockedByHold = false;
    return;
  }
  if (!isLocked()) setLocked(true);
  else if (lockDownWasPaused) playNow();
});

// ---------- buttons, slider and keys ----------

$('openBtn').addEventListener('click', () => chooseFiles(openFiles));
$('backBtn').addEventListener('click', goHome);
$('back5').addEventListener('click', () => seekBy(-5));
$('fwd5').addEventListener('click', () => seekBy(5));
$('speedBtn').addEventListener('click', () => toggleSheet(speedSheet));
$('ccBtn').addEventListener('click', () => toggleSheet(subsSheet));
$('addSubsBtn').addEventListener('click', () => chooseFiles(loadSubtitleFiles));
$('noticeOpen').addEventListener('click', () => chooseFiles(openFiles));
$('noticeBack').addEventListener('click', goHome);
$('noticeClose').addEventListener('click', hideNotice);
$('iosTipClose').addEventListener('click', () => {
  store.set('tipHidden', true);
  $('iosTip').hidden = true;
});
fsBtn.addEventListener('click', toggleFullscreen);

seek.addEventListener('pointerdown', () => {
  seekByPointer = true;
});
seek.addEventListener('input', () => {
  seeking = true;
  video.currentTime = Number(seek.value);
  renderSubs();
  updateControls();
});
seek.addEventListener('change', () => {
  seeking = false;
  if (seekByPointer) seek.blur();
  seekByPointer = false;
  updateControls();
});

document.addEventListener('keydown', (e) => {
  if (player.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const onButton = e.target instanceof Element && e.target.matches('button');
  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      if (e.key === ' ' && onButton) return; // Space presses the focused button
      e.preventDefault();
      if (!e.repeat && notice.hidden) togglePlay();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (e.target === seek) return; // the focused slider moves by itself
      e.preventDefault();
      seekBy(e.key === 'ArrowLeft' ? -5 : 5);
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 's':
    case 'S':
      cycleSubtitles();
      break;
    case ',':
    case '<':
      stepSpeed(-1);
      break;
    case '.':
    case '>':
      stepSpeed(1);
      break;
    case 'l':
    case 'L':
      setLocked(!isLocked());
      break;
    case 'Escape':
      closeSheets();
      break;
    default:
  }
});

// ---------- full screen and screen wake ----------

const canFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function toggleFullscreen() {
  if (!canFullscreen) return;
  if (fullscreenElement()) {
    exitFullscreen();
    return;
  }
  const request = player.requestFullscreen || player.webkitRequestFullscreen;
  try {
    request.call(player)?.catch?.(() => {});
  } catch {
    // not allowed right now
  }
}

function exitFullscreen() {
  if (!fullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  try {
    exit.call(document)?.catch?.(() => {});
  } catch {
    // already left full screen
  }
}

const updateFullscreenButton = () => fsBtn.classList.toggle('active', Boolean(fullscreenElement()));
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
fsBtn.hidden = !canFullscreen;

// Keeps the screen on while a video is open, so long pauses don't lock the phone.
async function keepScreenOn(on) {
  if (!('wakeLock' in navigator)) return;
  if (!on) {
    const lock = wakeLock;
    wakeLock = null;
    try {
      await lock?.release();
    } catch {
      // already released
    }
    return;
  }
  if (wakeLock || wakeLockPending || document.visibilityState !== 'visible') return;
  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (current) {
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } else {
      lock.release();
    }
  } catch {
    // not allowed (for example in Low Power Mode); the screen locks as usual
  } finally {
    wakeLockPending = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePosition();
  else if (current) keepScreenOn(true);
});
window.addEventListener('pagehide', savePosition);

// ---------- start screen ----------

function renderRecent() {
  const list = recentVideos().slice(0, 5);
  $('recent').hidden = !list.length;
  $('recentList').replaceChildren(
    ...list.map((entry) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-item';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = stripExtension(entry.name);
      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = entry.duration ? `${formatTime(entry.position)} / ${formatTime(entry.duration)}` : 'Not started';
      const bar = document.createElement('span');
      bar.className = 'recent-bar';
      const fill = document.createElement('i');
      fill.style.width = `${entry.duration ? Math.min(100, (entry.position / entry.duration) * 100) : 0}%`;
      bar.append(fill);
      button.append(name, meta, bar);
      button.addEventListener('click', () => {
        toast(`Pick “${entry.name}” to continue`);
        chooseFiles(openFiles);
      });
      item.append(button);
      return item;
    }),
  );
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Drag and drop on a computer.
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFiles(Array.from(e.dataTransfer.files), null);
});

// ---------- start ----------

const iphoneSafariTab = 'standalone' in navigator && !navigator.standalone && !canFullscreen;
$('iosTip').hidden = !iphoneSafariTab || store.get('tipHidden', false);
renderRecent();
renderSubtitleButton();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
