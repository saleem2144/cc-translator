// Service worker: starts/stops captioning and relays messages between
// the offscreen document (audio + helper connection) and the tabs.
//
// Two modes:
// - live:   capture the episode tab itself; captions trail the speech slightly.
// - synced: (Crunchyroll) a muted copy of the episode plays LEAD_SECONDS ahead in
//           a small window; its audio is captioned and each line is shown on the
//           episode at exactly the video time it's spoken.

const OFFSCREEN_URL = 'offscreen.html';
const LEAD_SECONDS = 8;
const SCOUT_LOAD_TIMEOUT_MS = 45000;
const GET_AHEAD_TIMEOUT_MS = 25000;

// Session state: activeTabId, mode, status, scout {tabId, windowId, mainWindowId, helperUrl}, waitingForClickOn
const session = () => chrome.storage.session.get(null);

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio to generate closed captions.',
  });
}

// Tabs opened before the extension was installed (or reloaded) don't have the
// content script yet, so inject it on demand.
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (res?.pong) return;
  } catch { /* not injected yet */ }
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['settings.js', 'content.js'] });
}

async function sendToTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; /* tab gone or no content script */ }
}

// Ask a tab's content script to read or control its own video.
const videoCmd = (tabId, cmd, value) => sendToTab(tabId, { type: 'video-cmd', cmd, value });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(500);
  }
  return false;
}

async function setStatus(tabId, state, detail = '') {
  const status = { type: 'status', state, detail };
  await chrome.storage.session.set({ status });
  if (tabId !== null && tabId !== undefined) await sendToTab(tabId, status);
}

// --- Live mode -------------------------------------------------------------

async function start(tabId, streamId, helperUrl) {
  await stop();
  await ensureContentScript(tabId);
  await ensureOffscreen();
  await chrome.storage.session.set({ activeTabId: tabId, mode: 'live' });
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, helperUrl, playback: true });
  await sendToTab(tabId, { type: 'captions-on', mode: 'live' });
}

// --- Synced mode -----------------------------------------------------------

async function startSynced(tab, helperUrl) {
  await stop();
  await ensureContentScript(tab.id);
  await chrome.storage.session.set({ activeTabId: tab.id, mode: 'synced' });
  await sendToTab(tab.id, { type: 'captions-on', mode: 'synced' });
  await setStatus(tab.id, 'info', 'Pausing your episode while a muted copy opens...');
  await videoCmd(tab.id, 'pause');

  // Crunchyroll only builds its player on a visible page, so the copy opens in front.
  const win = await chrome.windows.create({ url: tab.url, focused: true, width: 480, height: 300, left: 20, top: 20 });
  const scoutTabId = win.tabs[0].id;
  await chrome.tabs.update(scoutTabId, { muted: true });
  await chrome.storage.session.set({ scout: { tabId: scoutTabId, windowId: win.id, mainWindowId: tab.windowId, helperUrl } });

  const loaded = await waitFor(async () => (await videoCmd(scoutTabId, 'time'))?.ready, SCOUT_LOAD_TIMEOUT_MS);
  if (!loaded) return fail(tab.id, "The copy didn't load. Your Crunchyroll plan may only allow one stream at a time.");
  await videoCmd(scoutTabId, 'pause');

  // Chrome only lets the extension listen to a tab after the user clicks its
  // icon on that tab. The popup sends us the stream id when that happens.
  await chrome.storage.session.set({ waitingForClickOn: scoutTabId });
  await setStatus(tab.id, 'info', 'Click the CC Translator icon in the small window (top-left) to connect.');
}

async function onGrant(streamId) {
  const { scout, activeTabId } = await session();
  if (!scout) return;
  await chrome.storage.session.remove('waitingForClickOn');
  await ensureOffscreen();
  // playback: false keeps the copy silent for the viewer.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, helperUrl: scout.helperUrl, playback: false });
  await videoCmd(scout.tabId, 'scout-init');
  await chrome.windows.update(scout.mainWindowId, { focused: true }).catch(() => {});

  // Start the copy where the episode is paused and let it get ahead before the
  // episode resumes, so even the first lines have captions.
  const main = await videoCmd(activeTabId, 'time');
  if (!main?.found) return fail(activeTabId, 'Lost track of your episode.');
  await setStatus(activeTabId, 'info', `Getting ${LEAD_SECONDS} seconds ahead...`);
  await videoCmd(scout.tabId, 'rate', 1);
  await videoCmd(scout.tabId, 'seek', main.time);
  await videoCmd(scout.tabId, 'play');
  const ahead = await waitFor(async () => {
    const s = await videoCmd(scout.tabId, 'time');
    return s?.found && s.time >= main.time + LEAD_SECONDS;
  }, GET_AHEAD_TIMEOUT_MS);
  if (!ahead) return fail(activeTabId, "The copy didn't start playing.");

  await setStatus(activeTabId, 'connected');
  await sendToTab(activeTabId, { type: 'synced-ready', lead: LEAD_SECONDS });
  await videoCmd(activeTabId, 'play');
}

// Show the problem on the episode and tidy up the copy, but leave the message up.
async function fail(tabId, detail) {
  await setStatus(tabId, 'error', detail);
  await closeScout();
}

async function closeScout() {
  const { scout } = await session();
  await chrome.storage.session.remove(['scout', 'waitingForClickOn']);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
  if (scout) await chrome.windows.remove(scout.windowId).catch(() => {});
}

// Captions from the helper carry wall-clock times. In synced mode, convert them
// to the copy's video time (the copy's page knows its own clock), then hand them
// to the episode.
async function relaySynced(payload, s) {
  if (payload.type === 'status') return sendToTab(s.activeTabId, payload);
  if (payload.type !== 'caption') return; // in-progress guesses aren't needed when synced
  const times = await sendToTab(s.scout.tabId, { type: 'to-video-time', startMs: payload.startMs, endMs: payload.endMs });
  if (times?.start === null || times?.start === undefined) return;
  await sendToTab(s.activeTabId, { type: 'synced-caption', start: times.start, end: times.end, es: payload.es, en: payload.en });
}

// --- Common ----------------------------------------------------------------

async function stop() {
  const { activeTabId } = await session();
  await closeScout();
  await chrome.storage.session.remove(['activeTabId', 'status', 'mode']);
  if (activeTabId !== null && activeTabId !== undefined) await sendToTab(activeTabId, { type: 'captions-off' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  (async () => {
    switch (msg.type) {
      case 'start':
        await start(msg.tabId, msg.streamId, msg.helperUrl);
        return { ok: true };
      case 'start-synced':
        startSynced(msg.tab, msg.helperUrl); // long-running; progress is shown on the page
        return { ok: true };
      case 'grant': {
        const { waitingForClickOn } = await session();
        if (msg.tabId !== waitingForClickOn) return { ok: false, error: 'Not waiting for this tab.' };
        onGrant(msg.streamId);
        return { ok: true };
      }
      case 'stop':
        await stop();
        return { ok: true };
      case 'get-state': {
        const s = await session();
        return { activeTabId: s.activeTabId ?? null, mode: s.mode, status: s.status, waitingForClickOn: s.waitingForClickOn ?? null };
      }
      case 'scout-cmd': {
        // The episode's page drives the copy (drift correction, pause, seek).
        const { scout } = await session();
        return scout ? videoCmd(scout.tabId, msg.cmd, msg.value) : null;
      }
      case 'from-offscreen': {
        const s = await session();
        if (msg.payload.type === 'status') await chrome.storage.session.set({ status: msg.payload });
        if (s.mode === 'synced' && s.scout) await relaySynced(msg.payload, s);
        else if (s.activeTabId !== null && s.activeTabId !== undefined) await sendToTab(s.activeTabId, msg.payload);
        return { ok: true };
      }
    }
  })().then(sendResponse, err => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const s = await session();
  if (tabId === s.activeTabId) await stop();
});

chrome.windows.onRemoved.addListener(async windowId => {
  const s = await session();
  if (s.scout?.windowId === windowId) {
    await chrome.storage.session.remove('scout');
    await stop();
  }
});
