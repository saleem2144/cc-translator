// Holds an audio connection to the scout tab for the whole test (a tab being
// listened to stays "visible" to Chrome, so it keeps playing), and measures
// how loud it is on request. Not connected to the speakers, so the copy stays
// silent for the viewer.

const SILENCE_RMS = 0.003;
let held = null; // { stream, ctx, analyser }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const handlers = { hold, measure, release };
  const handler = handlers[msg.type];
  if (!handler) return;
  handler(msg).then(sendResponse, err => sendResponse({ error: String(err.message || err) }));
  return true;
});

async function hold({ streamId }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  held = { stream, ctx, analyser };
  return { ok: true };
}

async function measure({ seconds }) {
  if (!held) return { error: 'not listening' };
  const buf = new Float32Array(held.analyser.fftSize);
  let checks = 0, loud = 0, peak = 0;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    held.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const rms = Math.sqrt(sum / buf.length);
    peak = Math.max(peak, rms);
    checks++;
    if (rms > SILENCE_RMS) loud++;
    await new Promise(r => setTimeout(r, 100));
  }
  return { percentWithSound: Math.round((loud / checks) * 100), peakDb: peak > 0 ? Math.round(20 * Math.log10(peak)) : -999 };
}

async function release() {
  if (held) {
    held.stream.getTracks().forEach(t => t.stop());
    await held.ctx.close();
    held = null;
  }
  return { ok: true };
}
