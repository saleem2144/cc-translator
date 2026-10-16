// Offscreen document: captures the tab's audio, keeps it audible, streams
// 16 kHz mono audio to the local helper and forwards its captions.

const SAMPLE_RATE = 16000;
let session = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg.streamId, msg.helperUrl, msg.playback !== false).then(() => sendResponse({ ok: true }),
      err => { report('error', String(err.message || err)); sendResponse({ ok: false }); });
    return true;
  }
});

function forward(payload) {
  chrome.runtime.sendMessage({ target: 'background', type: 'from-offscreen', payload });
}

function report(state, detail = '') {
  forward({ type: 'status', state, detail });
}

async function start(streamId, helperUrl, playback) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // Capturing mutes the tab, so play the audio back at its original quality.
  // Synced mode turns this off: the copy playing ahead must stay silent.
  const playCtx = new AudioContext();
  if (playback) playCtx.createMediaStreamSource(stream).connect(playCtx.destination);

  // A second context at 16 kHz feeds the speech recogniser.
  const capCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await capCtx.audioWorklet.addModule('capture-worklet.js');
  const worklet = new AudioWorkletNode(capCtx, 'pcm-capture');
  const mute = capCtx.createGain();
  mute.gain.value = 0;
  capCtx.createMediaStreamSource(stream).connect(worklet).connect(mute).connect(capCtx.destination);

  const ws = new WebSocket(helperUrl);
  ws.binaryType = 'arraybuffer';
  session = { stream, playCtx, capCtx, ws, startMs: null };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'start', sampleRate: SAMPLE_RATE }));
    report('connected');
  };
  ws.onerror = () => report('error', `Can't reach the helper at ${helperUrl}. Is it running?`);
  ws.onclose = () => report('disconnected');
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (['speech_end', 'partial', 'caption', 'no_speech'].includes(msg.type)) {
      // Helper times are seconds from the start of the stream; convert to wall-clock ms.
      forward({ ...msg, startMs: session.startMs + msg.start * 1000, endMs: session.startMs + msg.end * 1000 });
    }
  };

  worklet.port.onmessage = ({ data }) => {
    if (session.startMs === null) session.startMs = Date.now() - (data.length / SAMPLE_RATE) * 1000;
    if (ws.readyState === WebSocket.OPEN) ws.send(data.buffer);
  };

  stream.getAudioTracks()[0].onended = () => report('disconnected', 'Tab audio capture ended.');
}
