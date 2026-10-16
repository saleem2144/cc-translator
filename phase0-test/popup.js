// Phase 0 feasibility test: can an extension capture this tab's audio and video,
// and can it control the page's video player?

const CAPTURE_SECONDS = 6;
const SILENCE_RMS = 0.003; // roughly -50 dB; anything quieter counts as silence

const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

runBtn.addEventListener('click', runTest);
document.getElementById('copy').addEventListener('click', copyResults);
document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ results: [] });
  render();
});
render();

async function runTest() {
  runBtn.disabled = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = { site: siteName(tab.url), time: new Date().toLocaleString() };

  try {
    setStatus(`Capturing audio and video for ${CAPTURE_SECONDS} seconds. Keep the video playing...`);
    result.capture = await captureTab(tab.id);
  } catch (err) {
    result.capture = { error: String(err.message || err) };
  }

  try {
    setStatus('Testing pause, play and rewind on the video player...');
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: testPlayer,
    });
    result.player = injection.result;
  } catch (err) {
    result.player = { error: String(err.message || err) };
  }

  const { results = [] } = await chrome.storage.local.get('results');
  results.unshift(result);
  await chrome.storage.local.set({ results: results.slice(0, 20) });
  setStatus('Done.');
  runBtn.disabled = false;
  render();
}

async function captureTab(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: { mandatory: { ...source, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } },
  });

  // Capturing a tab mutes it, so play the captured audio back to keep it audible.
  const audioCtx = new AudioContext();
  const audioSource = audioCtx.createMediaStreamSource(stream);
  audioSource.connect(audioCtx.destination);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  audioSource.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  let frames = 0;
  const countFrame = () => { frames++; video.requestVideoFrameCallback(countFrame); };
  video.requestVideoFrameCallback(countFrame);

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let audioChecks = 0, audioLoud = 0, peakRms = 0;
  let maxBrightness = 0, maxDetail = 0, thumbnail = null;
  const end = performance.now() + CAPTURE_SECONDS * 1000;
  let nextVideoCheck = 0;

  while (performance.now() < end) {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    peakRms = Math.max(peakRms, rms);
    audioChecks++;
    if (rms > SILENCE_RMS) audioLoud++;

    if (performance.now() >= nextVideoCheck) {
      nextVideoCheck = performance.now() + 500;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { brightness, detail } = measureFrame(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      maxBrightness = Math.max(maxBrightness, brightness);
      if (detail >= maxDetail) {
        maxDetail = detail;
        thumbnail = canvas.toDataURL('image/jpeg', 0.7);
      }
    }
    await sleep(100);
  }

  const settings = stream.getVideoTracks()[0]?.getSettings() || {};
  stream.getTracks().forEach(t => t.stop());
  await audioCtx.close();

  return {
    audio: {
      peakDb: peakRms > 0 ? Math.round(20 * Math.log10(peakRms)) : -Infinity,
      percentWithSound: Math.round((audioLoud / audioChecks) * 100),
    },
    video: {
      width: settings.width,
      height: settings.height,
      fps: Math.round(frames / CAPTURE_SECONDS),
      maxBrightness: Math.round(maxBrightness),
      maxDetail: Math.round(maxDetail),
      thumbnail,
    },
  };
}

// Average brightness and its spread (0 spread = a flat colour, e.g. a black frame).
function measureFrame(pixels) {
  let sum = 0, sumSq = 0;
  const n = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const y = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  return { brightness: mean, detail: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

// Runs inside the web page. Must be self-contained.
async function testPlayer() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return { found: false };

  const v = videos.reduce((a, b) => (b.videoWidth * b.videoHeight > a.videoWidth * a.videoHeight ? b : a));
  const res = { found: true, videoCount: videos.length, wasPlaying: !v.paused };

  try {
    v.pause();
    await wait(800);
    res.pause = v.paused;
  } catch (e) { res.pause = false; res.pauseError = String(e); }

  try {
    await v.play();
    await wait(1200);
    res.play = !v.paused;
  } catch (e) { res.play = false; res.playError = String(e); }

  try {
    const before = v.currentTime;
    v.currentTime = Math.max(0, before - 3);
    await wait(1500);
    res.rewind = v.currentTime < before;
  } catch (e) { res.rewind = false; res.rewindError = String(e); }

  return res;
}

function verdicts(r) {
  const c = r.capture || {};
  const p = r.player || {};
  const audio = c.error ? ['bad', 'Error']
    : c.audio.percentWithSound >= 20 ? ['ok', 'Works']
    : c.audio.peakDb < -60 ? ['bad', 'Silent']
    : ['warn', 'Very quiet'];
  const video = c.error ? ['bad', 'Error']
    : c.video.maxBrightness < 10 && c.video.maxDetail < 3 ? ['bad', 'Black']
    : c.video.fps < 20 ? ['warn', `${c.video.fps} fps`]
    : ['ok', 'Works'];
  const player = p.error ? ['bad', 'Error']
    : !p.found ? ['bad', 'No video']
    : p.pause && p.play ? ['ok', 'Works']
    : ['bad', 'Blocked'];
  const rewind = p.error || !p.found ? ['bad', '-']
    : p.rewind ? ['ok', 'Works'] : ['bad', 'Blocked'];
  return { audio, video, player, rewind };
}

async function render() {
  const { results = [] } = await chrome.storage.local.get('results');
  if (!results.length) {
    resultsEl.innerHTML = '<p class="hint">No results yet.</p>';
    return;
  }
  const cell = ([cls, text]) => `<td class="${cls}">${text}</td>`;
  resultsEl.innerHTML = `
    <table>
      <tr><th>Site</th><th>Audio</th><th>Video</th><th>Pause/play</th><th>Rewind</th></tr>
      ${results.map(r => {
        const v = verdicts(r);
        return `<tr><td>${escapeHtml(r.site)}</td>${cell(v.audio)}${cell(v.video)}${cell(v.player)}${cell(v.rewind)}</tr>`;
      }).join('')}
    </table>
    ${results.map(r => `
      <details>
        <summary>Details: ${escapeHtml(r.site)} (${escapeHtml(r.time)})</summary>
        ${r.capture?.video?.thumbnail ? `<img src="${r.capture.video.thumbnail}" alt="Captured frame">` : ''}
        <pre>${escapeHtml(JSON.stringify(withoutThumbnail(r), null, 2))}</pre>
      </details>`).join('')}
  `;
}

async function copyResults() {
  const { results = [] } = await chrome.storage.local.get('results');
  const lines = results.map(r => {
    const v = verdicts(r);
    return `${r.site}: audio ${v.audio[1]}, video ${v.video[1]}, pause/play ${v.player[1]}, rewind ${v.rewind[1]}\n`
      + JSON.stringify(withoutThumbnail(r));
  });
  await navigator.clipboard.writeText(lines.join('\n\n') || 'No results');
  setStatus('Results copied. Paste them into the chat.');
}

function withoutThumbnail(r) {
  const copy = structuredClone(r);
  if (copy.capture?.video) delete copy.capture.video.thumbnail;
  return copy;
}

function siteName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function setStatus(text) { statusEl.textContent = text; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
