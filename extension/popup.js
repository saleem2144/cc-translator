const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const FIELDS = ['show', 'order', 'fontSize', 'position', 'holdSeconds', 'helperUrl'];
const NUMBER_FIELDS = new Set(['fontSize', 'position', 'holdSeconds']);

let settings;
let tab;

init();

async function init() {
  settings = await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  for (const id of FIELDS) {
    const el = document.getElementById(id);
    el.value = settings[id];
    el.addEventListener('change', () => {
      settings[id] = NUMBER_FIELDS.has(id) ? Number(el.value) : el.value;
      saveSettings(settings);
    });
  }
  document.getElementById('timingSettings').hidden = !WAIT_MODE_ENABLED;
  document.getElementById('syncedSettings').hidden = !isCrunchyroll(tab);
  const syncedBox = document.getElementById('syncedCrunchyroll');
  syncedBox.checked = settings.syncedCrunchyroll;
  syncedBox.addEventListener('change', () => { settings.syncedCrunchyroll = syncedBox.checked; saveSettings(settings); });

  // Opening this popup on the copy's window is the click Chrome needs before the
  // extension may listen to that tab. If synced mode is waiting for it, connect now.
  const state = await chrome.runtime.sendMessage({ target: 'background', type: 'get-state' });
  if (state.waitingForClickOn === tab.id) {
    await connectCopy();
    return;
  }
  for (const radio of document.querySelectorAll('input[name=timing]')) {
    radio.checked = radio.value === settings.timing;
    radio.addEventListener('change', () => { settings.timing = radio.value; saveSettings(settings); });
  }

  toggleBtn.addEventListener('click', toggle);
  refresh();
  showDiagnostics();
  setInterval(showDiagnostics, 1000);
}

function isCrunchyroll(t) {
  return /^https:\/\/www\.crunchyroll\.com\//.test(t?.url || '');
}

async function connectCopy() {
  toggleBtn.hidden = true;
  for (const fs of document.querySelectorAll('fieldset')) fs.hidden = true;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'grant', tabId: tab.id, streamId });
    if (!res.ok) throw new Error(res.error);
    setStatus('Connected. This window will go behind your episode, which starts again in about 8 seconds.');
  } catch (err) {
    setStatus(`Couldn't connect to the copy: ${err.message || err}`, true);
  }
}

// What the page has received and is showing, to help track down display problems.
async function showDiagnostics() {
  const diag = document.getElementById('diag');
  let d;
  try { d = await chrome.tabs.sendMessage(tab.id, { type: 'debug' }); } catch { d = null; }
  if (!d || !d.active) { diag.hidden = true; return; }
  diag.hidden = false;
  const video = d.videoTime === null ? 'no video found'
    : `video at ${d.videoTime}s, ${d.videoPaused ? 'paused' : 'playing'} (${d.videos} video element${d.videos === 1 ? '' : 's'})`;
  if (d.mode === 'synced') {
    diag.textContent = `Synced. Copy ahead by ${d.lead ?? '?'}s. Lines received ${d.caption}, replaced ${d.replaced}, `
      + `saved ${d.saved}. Copy had to jump ${d.jumps} time${d.jumps === 1 ? '' : 's'}. Showing: ${d.shown}. ${video}.`;
    return;
  }
  diag.textContent = `Mode: ${d.mode}. Received ${d.partial} in-progress (${d.ignoredPartial} ignored), ${d.caption} final. `
    + `Showing: ${d.shown}. ${video}. Saved lines: ${d.saved}.`;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ target: 'background', type: 'get-state' });
  const onHere = state.activeTabId === tab.id;
  toggleBtn.textContent = onHere ? 'Stop captions' : 'Start captions on this tab';
  toggleBtn.classList.toggle('on', onHere);

  const s = state.status;
  if (!onHere) setStatus(state.activeTabId !== null && state.activeTabId !== undefined
    ? 'Captions are running in another tab. Starting here will move them.' : '');
  else if (!s) setStatus('Starting...');
  else if (s.state === 'connected') setStatus(state.mode === 'synced' ? 'Synced captions running.' : 'Connected to helper. Listening.');
  else if (s.state === 'info') setStatus(s.detail);
  else setStatus(s.detail || 'Helper disconnected.', true);
}

async function toggle() {
  toggleBtn.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ target: 'background', type: 'get-state' });
    if (state.activeTabId === tab.id) {
      await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    } else if (isCrunchyroll(tab) && settings.syncedCrunchyroll) {
      await chrome.runtime.sendMessage({ target: 'background', type: 'start-synced', tab, helperUrl: settings.helperUrl });
      setStatus('A small muted copy is opening. When asked, click the CC Translator icon in that window.');
      toggleBtn.disabled = false;
      return;
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await chrome.runtime.sendMessage({
        target: 'background', type: 'start', tabId: tab.id, streamId, helperUrl: settings.helperUrl,
      });
      if (!res.ok) throw new Error(res.error);
    }
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
  toggleBtn.disabled = false;
  setTimeout(refresh, 600);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}
