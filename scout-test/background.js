// Scout tab feasibility test, run from the service worker so clicking the page
// or a new window opening can't interrupt it. Progress and results are kept in
// storage; the popup just displays them.

const LEAD_SECONDS = 8;
const WINDOW_LOAD_TIMEOUT_MS = 30000;
const CAPTURE_SECONDS = 5;
const DRIFT_WAIT_MS = 10000;
const GRANT_TIMEOUT_MS = 60000;

let state = { running: false, status: '', results: [] };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'run' && !state.running) {
    run(msg.tab);
    sendResponse({ ok: true });
  } else if (msg.type === 'grant' && msg.tabId === state.waitingForClickOn) {
    state.grantedStreamId = msg.streamId;
    sendResponse({ ok: true });
  }
});

async function save() {
  await chrome.storage.local.set({ scoutTest: state });
}

async function setStatus(text) {
  state.status = text;
  await save();
}

async function add(name, cls, detail = '') {
  const verdict = { ok: 'Works', bad: 'No', warn: 'Partly', info: 'Info' }[cls];
  state.results.push({ name, cls, verdict, detail });
  await save();
}

async function run(main) {
  state = { running: true, status: 'Starting...', results: [] };
  await save();
  let scout = null; // { tabId, windowId?, how }
  try {
    const mainVideo = await readVideo(main.id);
    if (!mainVideo?.found) { await add('Episode tab', 'bad', 'No video found on this page.'); return; }
    await add('Episode tab', 'ok', `video at ${mainVideo.time.toFixed(1)}s, ${mainVideo.paused ? 'paused' : 'playing'}`);

    // Crunchyroll only builds its player on a visible page (background tabs and
    // covered windows never get one), so open the copy in a small window in front.
    await setStatus('Opening a muted copy in a small window in front (up to 30 s)...');
    const win = await chrome.windows.create({ url: main.url, focused: true, width: 480, height: 300, left: 20, top: 20 });
    const winTab = win.tabs[0];
    await chrome.tabs.update(winTab.id, { muted: true });
    scout = { tabId: winTab.id, windowId: win.id, how: 'small window' };
    const loaded = await waitForScout(winTab.id, WINDOW_LOAD_TIMEOUT_MS);
    await add('Copy loads in a visible window', loaded.ready ? 'ok' : 'bad', describe(loaded));

    if (loaded.streamLimit) {
      await add('Two streams at once', 'bad', `Crunchyroll showed: "${loaded.streamLimit}"`);
      return;
    }
    if (!loaded.ready) return;

    const mainAfter = await readVideo(main.id);
    const bothOk = mainAfter?.found && !mainAfter.error;
    await add('Two streams at once', bothOk ? 'ok' : 'bad', bothOk ? 'both players working' : 'your episode stopped or errored');

    // Chrome only lets an extension listen to a tab after the user clicks its
    // icon on that tab. Wait for that click (the popup sends us the stream id).
    state.waitingForClickOn = scout.tabId;
    state.grantedStreamId = null;
    await setStatus('YOUR TURN: click the Scout Test icon now, while the small window is in front (60 s).');
    const end = Date.now() + GRANT_TIMEOUT_MS;
    while (!state.grantedStreamId && Date.now() < end) await sleep(500);
    state.waitingForClickOn = null;
    if (!state.grantedStreamId) {
      await add('Extension can listen to the copy', 'bad', 'no click on the small window within 60 s');
      return;
    }

    // Start listening while it's still visible: Chrome keeps a tab that's being
    // listened to rendering and playing even once it's covered.
    await setStatus('Connecting to the copy\'s audio...');
    const holding = await startListening(state.grantedStreamId);
    await add('Extension can listen to the copy', holding.error ? 'bad' : 'ok', holding.error || 'connected after one click');
    if (holding.error) return;

    await setStatus('Bringing your episode back to the front...');
    await chrome.windows.update(main.windowId, { focused: true }).catch(() => {});
    await sleep(4000);
    const behind = await inPage(scout.tabId, () => ({ found: true, hidden: document.hidden, videos: document.querySelectorAll('video').length })).catch(() => null);
    const sb = await readVideo(scout.tabId);
    await add('Copy keeps its player behind your window', sb?.found ? 'ok' : 'bad',
      `videos=${behind?.videos}, hidden=${behind?.hidden}, playing=${sb?.found ? !sb.paused : 'n/a'}`);
    if (!sb?.found) return;

    await setStatus(`Moving the copy ${LEAD_SECONDS} s ahead and starting it...`);
    const now = await readVideo(main.id);
    const startRes = await seekAndPlay(scout.tabId, now.time + LEAD_SECONDS);
    await sleep(3000);
    const s1 = await readVideo(scout.tabId);
    const plays = s1?.found && !s1.paused && s1.time > now.time + LEAD_SECONDS - 1;
    await add(`Copy plays ahead (${scout.how})`, plays ? 'ok' : 'bad',
      plays ? `playing at ${s1.time.toFixed(1)}s` : `paused=${s1?.paused}, time=${s1?.time?.toFixed(1)}, play(): ${startRes?.playError || 'ok'}`);

    await setStatus(`Listening to the copy for ${CAPTURE_SECONDS} s...`);
    const capture = await offscreen('measure', { seconds: CAPTURE_SECONDS });
    if (capture.error) {
      await add('Extension can hear the copy', 'bad', capture.error);
    } else {
      const cls = capture.percentWithSound >= 20 ? 'ok' : capture.peakDb < -60 ? 'bad' : 'warn';
      await add('Extension can hear the copy', cls, `${capture.percentWithSound}% of the time with sound, peak ${capture.peakDb} dB (muted for you)`);
    }

    await setStatus('Measuring whether the two copies stay in step (10 s)...');
    const d1 = await lead(main.id, scout.tabId);
    await sleep(DRIFT_WAIT_MS);
    const d2 = await lead(main.id, scout.tabId);
    if (d1 === null || d2 === null) {
      await add('Stays in step', 'bad', 'could not read both players');
    } else {
      const drift = d2 - d1;
      const cls = Math.abs(d2 - LEAD_SECONDS) < 1 && Math.abs(drift) < 0.5 ? 'ok' : Math.abs(drift) < 1.5 ? 'warn' : 'bad';
      await add('Stays in step', cls, `ahead by ${d1.toFixed(2)}s, then ${d2.toFixed(2)}s 10 s later (drift ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s)`);
    }

    await setStatus('Checking that the copy follows a pause...');
    await setPaused(main.id, true);
    await setPaused(scout.tabId, true);
    await sleep(800);
    const ps = await readVideo(scout.tabId);
    await setPaused(main.id, false);
    await add('Copy can be paused', ps?.paused ? 'ok' : 'bad', ps?.paused ? '' : 'copy kept playing');
  } catch (err) {
    await add('Test error', 'bad', String(err.message || err));
  } finally {
    await offscreen('release').catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    if (scout?.windowId) await chrome.windows.remove(scout.windowId).catch(() => {});
    else if (scout) await chrome.tabs.remove(scout.tabId).catch(() => {});
    state.running = false;
    await setStatus('Done. The copy has been closed.');
  }
}

function describe(r) {
  if (r.streamLimit) return `stream limit message: "${r.streamLimit}"`;
  if (r.ready) return 'video ready';
  if (!r.diag) return 'page did not respond';
  const d = r.diag;
  return `videos=${d.videos}, readyState=${d.readyState}, networkState=${d.networkState}, paused=${d.paused}, `
    + `hidden=${d.hidden}, page="${d.title}"`;
}

// --- Helpers that run inside the Crunchyroll page -------------------------

async function inPage(tabId, func, args = []) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  // The player may live in an iframe: prefer the frame that has a video.
  const results = frames.map(f => f.result).filter(Boolean);
  return results.find(r => r.found || r.videos) || results[0] || null;
}

function readVideo(tabId) {
  return inPage(tabId, () => {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return { found: false };
    const v = vids.reduce((a, b) => (b.videoWidth * b.videoHeight > a.videoWidth * a.videoHeight ? b : a));
    return { found: true, time: v.currentTime, paused: v.paused, error: v.error ? v.error.code : null };
  }).catch(() => null);
}

function seekAndPlay(tabId, time) {
  return inPage(tabId, async t => {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    const v = vids.reduce((a, b) => (b.videoWidth * b.videoHeight > a.videoWidth * a.videoHeight ? b : a));
    v.currentTime = t;
    let playError = null;
    try { await v.play(); } catch (e) { playError = String(e); }
    return { found: true, playError };
  }, [time]).catch(e => ({ playError: String(e) }));
}

function setPaused(tabId, paused) {
  return inPage(tabId, p => {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    const v = vids.reduce((a, b) => (b.videoWidth * b.videoHeight > a.videoWidth * a.videoHeight ? b : a));
    if (p) v.pause(); else v.play().catch(() => {});
    return { found: true };
  }, [paused]).catch(() => null);
}

async function waitForScout(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    await sleep(1500);
    last = await inPage(tabId, () => {
      const text = document.body?.innerText || '';
      const limit = text.match(/[^\n]*(stream|transmisi|reproducci|dispositivo|device)[^\n]*(limit|máximo|maximum|too many|demasiad|al mismo tiempo|at the same time|at once|otro)[^\n]*/i);
      const vids = [...document.querySelectorAll('video')];
      const v = vids[0];
      return {
        found: !!v,
        ready: !!(v && v.readyState >= 2),
        streamLimit: limit ? limit[0].trim().slice(0, 160) : null,
        diag: {
          videos: vids.length,
          readyState: v ? v.readyState : null,
          networkState: v ? v.networkState : null,
          paused: v ? v.paused : null,
          hidden: document.hidden,
          title: document.title.slice(0, 60),
        },
      };
    }).catch(() => null);
    if (last?.streamLimit || last?.ready) return last;
  }
  return last || { ready: false };
}

async function lead(mainId, scoutId) {
  const [m, s] = await Promise.all([readVideo(mainId), readVideo(scoutId)]);
  return m?.found && s?.found ? s.time - m.time : null;
}

// --- Listening (via an offscreen document, which can use audio APIs) -------

async function startListening(streamId) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Listen to the scout tab audio.' });
  }
  return offscreen('hold', { streamId });
}

function offscreen(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
}

// Sleeps in 1 s steps with a cheap API call each time, so Chrome doesn't stop
// the service worker for being idle during long waits.
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, Math.min(1000, end - Date.now())));
    await chrome.runtime.getPlatformInfo();
  }
}
