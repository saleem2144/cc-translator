// Starts the test (which runs in the background) and shows its progress.
// The popup can be closed and reopened at any time.

const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const table = document.getElementById('results');

runBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/crunchyroll\.com/.test(tab.url || '')) {
    statusEl.textContent = 'Open a Crunchyroll episode in this tab first.';
    return;
  }
  await chrome.runtime.sendMessage({ target: 'background', type: 'run', tab });
});

document.getElementById('copy').addEventListener('click', async () => {
  const { scoutTest } = await chrome.storage.local.get('scoutTest');
  const text = (scoutTest?.results || []).map(r => `${r.name}: ${r.verdict} ${r.detail}`.trim()).join('\n');
  await navigator.clipboard.writeText(text || 'No results');
  statusEl.textContent = 'Results copied. Paste them into the chat.';
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scoutTest) render(changes.scoutTest.newValue);
});
chrome.storage.local.get('scoutTest').then(({ scoutTest }) => {
  render(scoutTest);
  grantIfAsked(scoutTest);
});

// Opening this popup on the copy window is the click Chrome requires before the
// extension may listen to that tab. If the test is waiting for it, connect now.
async function grantIfAsked(s) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!s?.running || !tab) return;
  const { scoutTest } = await chrome.storage.local.get('scoutTest');
  if (scoutTest?.waitingForClickOn !== tab.id) return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await chrome.runtime.sendMessage({ target: 'background', type: 'grant', tabId: tab.id, streamId });
    statusEl.textContent = 'Connected to the copy. You can close this popup; the test continues.';
  } catch (err) {
    statusEl.textContent = `Couldn't connect: ${err.message || err}`;
  }
}

function render(s) {
  if (!s) return;
  runBtn.disabled = s.running;
  statusEl.textContent = s.status;
  table.replaceChildren(...s.results.map(r => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = r.name;
    const b = document.createElement('td');
    const v = document.createElement('span');
    v.className = r.cls;
    v.textContent = r.verdict;
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = ` ${r.detail}`;
    b.append(v, d);
    tr.append(a, b);
    return tr;
  }));
}
