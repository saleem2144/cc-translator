// Content script: draws the Spanish + English captions over the video,
// hides the site's own subtitles, and (when enabled) "wait for each line" mode.

(() => {
  const LIVE_EXTRA_MS = 1500;     // keep a live line up this long past its spoken length
  const MIN_LIVE_MS = 2500;
  const MAX_LIVE_MS = 5000;
  const PARTIAL_STALE_MS = 3000;  // drop an in-progress guess if no update arrives
  const WAIT_SAFETY_MS = 8000;    // never keep the video paused longer than this
  const REPLAY_MARGIN_S = 2;      // video this far behind the newest caption = the user rewound

  // Counters shown in the popup's diagnostics line.
  const debug = { partial: 0, caption: 0, ignoredPartial: 0, shown: 'nothing' };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let overlay = null;
  let tickTimer = null;
  let saved = [];                 // captions keyed by video time: {start, end, es, en}
  let live = null;                // latest final caption {es, en, until}
  let partial = null;             // in-progress guess for the sentence being spoken {id, es, en, at}
  let lastFinalId = -1;
  let statusText = '';
  let clockSamples = [];          // [{wall, vt, rate, paused}] to map wall-clock time to video time
  let waitPause = null;           // {timer} while paused in 'wait' mode

  loadSettings().then(s => { settings = s; });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') { sendResponse({ pong: true }); return; }
    if (msg.type === 'debug') { sendResponse(debugInfo()); return; }
    if (msg.type === 'captions-off') { turnOff(); return; }
    turnOn(); // any other message means captions are running for this tab
    if (msg.es) console.debug(`[CC Translator] ${msg.type} #${msg.id}: ${msg.es} | ${msg.en}`);
    switch (msg.type) {
      case 'status': onStatus(msg); break;
      case 'speech_end': onSpeechEnd(); break;
      case 'partial': onPartial(msg); break;
      case 'caption': onCaption(msg); break;
      case 'no_speech': onNoSpeech(msg); break;
    }
  });

  function timing() {
    return WAIT_MODE_ENABLED ? settings.timing : 'live';
  }

  function turnOn() {
    if (active) return;
    active = true;
    saved = [];
    live = null;
    partial = null;
    lastFinalId = -1;
    statusText = 'Connecting to CC Translator helper...';
    document.documentElement.classList.add('cc-tr-active');
    tickTimer = setInterval(tick, 100);
  }

  function turnOff() {
    active = false;
    clearInterval(tickTimer);
    endWaitPause();
    document.documentElement.classList.remove('cc-tr-active');
    overlay?.remove();
    overlay = null;
  }

  function onStatus({ state, detail }) {
    if (state === 'connected') statusText = 'Listening...';
    else if (state === 'error') statusText = detail || 'Helper error';
    else if (state === 'disconnected') statusText = detail || 'Helper disconnected';
  }

  // --- Video and clock -----------------------------------------------------

  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function recordClock(video) {
    const now = Date.now();
    clockSamples.push({ wall: now, vt: video.currentTime, rate: video.playbackRate, paused: video.paused });
    while (clockSamples.length && now - clockSamples[0].wall > 120000) clockSamples.shift();
  }

  // Video time that was playing at a given wall-clock moment.
  function videoTimeAt(wall) {
    let s = null;
    for (let i = clockSamples.length - 1; i >= 0; i--) {
      if (clockSamples[i].wall <= wall) { s = clockSamples[i]; break; }
    }
    s = s || clockSamples[0];
    if (!s) return null;
    return s.paused ? s.vt : s.vt + ((wall - s.wall) / 1000) * s.rate;
  }

  // --- Captions ------------------------------------------------------------

  function debugInfo() {
    const video = findVideo();
    return {
      ...debug,
      active,
      videos: document.querySelectorAll('video').length,
      videoTime: video ? Math.round(video.currentTime * 10) / 10 : null,
      videoPaused: video ? video.paused : null,
      saved: saved.length,
    };
  }

  function onPartial({ id, es, en }) {
    debug.partial++;
    if (id <= lastFinalId) { debug.ignoredPartial++; return; } // that sentence is already final
    statusText = '';
    if (!partial || partial.id !== id) {
      partial = { id, at: 0, es: newReveal(), en: newReveal() };
    }
    partial.at = Date.now();
    setRevealTarget(partial.es, es);
    setRevealTarget(partial.en, en);
  }

  // Word-by-word reveal for in-progress captions.
  // - A word is only shown once two guesses in a row agree on it, so one-off
  //   wrong guesses never flicker onto the screen.
  // - Words on screen only change when two guesses agree on the correction.
  // - New words are added one per tick instead of all at once.
  function newReveal() {
    return { words: [], prev: [], shown: 0 };
  }

  const normWord = w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  function agreedPrefix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && normWord(a[n]) === normWord(b[n])) n++;
    return a.slice(0, n);
  }

  function setRevealTarget(r, text) {
    const guess = text.split(/\s+/).filter(Boolean);
    const agreed = agreedPrefix(guess, r.prev);
    r.prev = guess;
    if (!agreed.length) return;
    const consistent = agreedPrefix(agreed, r.words).length === Math.min(agreed.length, r.words.length);
    if (!consistent) r.words = agreed;                       // two guesses agree on a correction
    else if (agreed.length >= r.words.length) r.words = agreed; // extend with newly agreed words
    else r.words = [...agreed, ...r.words.slice(agreed.length)]; // refresh spelling, keep the rest
    r.shown = Math.min(r.shown, r.words.length);
  }

  function stepReveal(r) {
    const behind = r.words.length - r.shown;
    if (behind > 0) r.shown += behind > 4 ? 2 : 1; // catch up faster if far behind
    return r.words.slice(0, r.shown).join(' ');
  }

  function onNoSpeech({ id }) {
    lastFinalId = Math.max(lastFinalId, id);
    if (partial && partial.id <= id) partial = null;
  }

  function onCaption({ id, es, en, startMs, endMs }) {
    debug.caption++;
    statusText = '';
    lastFinalId = Math.max(lastFinalId, id);
    if (partial && partial.id <= id) partial = null;
    const start = videoTimeAt(startMs);
    const end = videoTimeAt(endMs);
    if (start !== null && end !== null && end >= start) {
      // Replace anything we already had for the same moment (e.g. after rewinding).
      saved = saved.filter(c => c.end < start - 0.3 || c.start > end + 0.3);
      saved.push({ start, end, es, en });
      saved.sort((a, b) => a.start - b.start);
    }
    // Earlier lines of a long stretch were already seen as partials, so the
    // final version replaces whatever is on screen straight away.
    const now = Date.now();
    live = { es, en, until: now + Math.min(MAX_LIVE_MS, Math.max(MIN_LIVE_MS, endMs - startMs + LIVE_EXTRA_MS)) };

    if (waitPause) {
      clearTimeout(waitPause.timer);
      waitPause.timer = setTimeout(endWaitPause, settings.holdSeconds * 1000);
      live.until = now + settings.holdSeconds * 1000 + MIN_LIVE_MS;
    }
  }

  // "Wait for each line" mode. Hidden from users for now (WAIT_MODE_ENABLED in settings.js).
  function onSpeechEnd() {
    if (timing() !== 'wait' || waitPause) return;
    const video = findVideo();
    if (!video || video.paused) return;
    video.pause();
    waitPause = { video, timer: setTimeout(endWaitPause, WAIT_SAFETY_MS) };
  }

  function endWaitPause() {
    if (!waitPause) return;
    clearTimeout(waitPause.timer);
    const { video } = waitPause;
    waitPause = null;
    if (video.paused) video.play().catch(() => {});
  }

  function captionToShow(video) {
    // After a rewind the video is behind the newest caption, and saved captions
    // can be shown perfectly in sync. Only then: during normal playback the
    // in-progress and latest captions always win.
    const t = video.currentTime;
    const liveEdge = saved.length ? saved[saved.length - 1].end : -Infinity;
    if (t < liveEdge - REPLAY_MARGIN_S) {
      const synced = saved.find(c => t >= c.start - 0.1 && t <= c.end + 0.4);
      if (synced) { debug.shown = 'replay'; return synced; }
    }
    const now = Date.now();
    if (partial && !waitPause && now - partial.at < PARTIAL_STALE_MS) {
      debug.shown = 'in-progress';
      return { es: stepReveal(partial.es), en: stepReveal(partial.en), inProgress: true };
    }
    if (live && now < live.until) { debug.shown = 'final'; return live; }
    debug.shown = 'nothing';
    return null;
  }

  // --- Drawing -------------------------------------------------------------

  function tick() {
    const video = findVideo();
    if (!video) { overlay?.replaceChildren(); return; }
    recordClock(video);

    const host = document.fullscreenElement || document.body;
    if (!overlay || overlay.parentElement !== host) {
      overlay?.remove();
      overlay = document.createElement('div');
      overlay.id = 'cc-tr-overlay';
      host.appendChild(overlay);
    }

    const r = video.getBoundingClientRect();
    overlay.style.left = `${r.left + r.width / 2}px`;
    overlay.style.top = `${r.top + (r.height * settings.position) / 100}px`;
    overlay.style.maxWidth = `${r.width * 0.9}px`;
    overlay.style.fontSize = `${settings.fontSize}px`;

    const caption = captionToShow(video);
    const lines = [];
    if (caption) {
      const style = caption.inProgress ? ' cc-tr-partial' : '';
      const es = settings.show !== 'en' && caption.es ? [`cc-tr-es${style}`, caption.es] : null;
      const en = settings.show !== 'es' && caption.en ? [`cc-tr-en${style}`, caption.en] : null;
      lines.push(...(settings.order === 'en-first' ? [en, es] : [es, en]).filter(Boolean));
    } else if (statusText) {
      lines.push(['cc-tr-status', statusText]);
    }
    render(lines);
  }

  function render(lines) {
    const key = JSON.stringify(lines);
    if (overlay.dataset.key === key) return;
    overlay.dataset.key = key;
    overlay.replaceChildren(...lines.map(([cls, text]) => {
      const div = document.createElement('div');
      div.className = `cc-tr-line ${cls}`;
      div.textContent = text;
      return div;
    }));
  }
})();
