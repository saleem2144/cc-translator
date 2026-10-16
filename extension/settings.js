// Shared by the popup and the content script. `var` so re-injecting this file doesn't throw.

// "Wait for each line" mode is built but hidden while live captions are the focus.
// Set to true to bring back the Caption timing setting.
var WAIT_MODE_ENABLED = false;

var DEFAULT_SETTINGS = {
  helperUrl: 'ws://127.0.0.1:8765',
  show: 'both',          // 'both' | 'es' | 'en'
  order: 'es-first',     // 'es-first' | 'en-first'
  fontSize: 26,          // px
  position: 88,          // % from the top of the video
  timing: 'live',        // 'live' | 'wait'
  holdSeconds: 2,        // 'wait' mode: how long to show a line before resuming
  syncedCrunchyroll: false, // Crunchyroll: caption a muted copy playing ahead, for perfectly timed lines
};

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}
