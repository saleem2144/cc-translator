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
  for (const radio of document.querySelectorAll('input[name=timing]')) {
    radio.checked = radio.value === settings.timing;
    radio.addEventListener('change', () => { settings.timing = radio.value; saveSettings(settings); });
  }

  toggleBtn.addEventListener('click', toggle);
  refresh();
  showDiagnostics();
  setInterval(showDiagnostics, 1000);
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
  diag.textContent = `Received ${d.partial} in-progress (${d.ignoredPartial} ignored), ${d.caption} final. `
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
  else if (s.state === 'connected') setStatus('Connected to helper. Listening.');
  else setStatus(s.detail || 'Helper disconnected.', true);
}

async function toggle() {
  toggleBtn.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ target: 'background', type: 'get-state' });
    if (state.activeTabId === tab.id) {
      await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
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
