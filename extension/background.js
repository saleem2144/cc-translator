// Service worker: starts/stops captioning and relays messages between
// the offscreen document (audio + helper connection) and the tab.

const OFFSCREEN_URL = 'offscreen.html';

async function getActiveTabId() {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId ?? null;
}

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

async function start(tabId, streamId, helperUrl) {
  await stop();
  await ensureContentScript(tabId);
  await ensureOffscreen();
  await chrome.storage.session.set({ activeTabId: tabId });
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, helperUrl });
  await sendToTab(tabId, { type: 'captions-on' });
}

async function stop() {
  const tabId = await getActiveTabId();
  await chrome.storage.session.remove(['activeTabId', 'status']);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
  if (tabId !== null) await sendToTab(tabId, { type: 'captions-off' });
}

async function sendToTab(tabId, message) {
  try { await chrome.tabs.sendMessage(tabId, message); } catch { /* tab gone or no content script */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  (async () => {
    switch (msg.type) {
      case 'start':
        await start(msg.tabId, msg.streamId, msg.helperUrl);
        return { ok: true };
      case 'stop':
        await stop();
        return { ok: true };
      case 'get-state':
        return { activeTabId: await getActiveTabId(), ...(await chrome.storage.session.get('status')) };
      case 'from-offscreen': {
        // Captions and status updates from the offscreen document.
        if (msg.payload.type === 'status') await chrome.storage.session.set({ status: msg.payload });
        const tabId = await getActiveTabId();
        if (tabId !== null) await sendToTab(tabId, msg.payload);
        return { ok: true };
      }
    }
  })().then(sendResponse, err => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId === await getActiveTabId()) await stop();
});
