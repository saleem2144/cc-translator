"""CC Translator helper: turns streamed Spanish audio into timed Spanish
captions with English translations.

The extension connects over a WebSocket on 127.0.0.1 and sends raw mono
float32 PCM at 16 kHz. The helper replies with JSON messages:
  {"type": "speech_end", "start": s, "end": s}            a sentence just ended
  {"type": "caption", "start": s, "end": s, "es": ..., "en": ...}
Times are seconds since the start of the stream.
"""
import argparse
import asyncio
import json
import logging
import time
from http import HTTPStatus

import gpu_libs  # noqa: F401  (must come before faster_whisper)
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from translator import Translator, split_sentences

SR = 16000
CHECK_EVERY = int(0.15 * SR)       # run voice detection every 0.15 s of new audio
END_SILENCE = int(0.45 * SR)       # this much silence ends a sentence
MAX_SEGMENT = int(4 * SR)          # force a cut so long speeches still get final captions
PAD = int(0.2 * SR)
VAD = VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)
PARTIAL_EVERY = 0.2                # seconds between in-progress (partial) captions
MIN_PARTIAL = int(0.4 * SR)        # don't guess at less audio than this
SHORT_CLIP = int(1.2 * SR)

# Phrases Whisper tends to invent on silence or music in Spanish.
HALLUCINATIONS = ("amara.org", "subtítulos realizados por", "subtitulado por", "suscríbete al canal")
# Whisper also turns short noises into these. Only dropped for clips shorter than SHORT_CLIP.
SHORT_HALLUCINATIONS = {"gracias", "muchas gracias", "gracias por ver"}


def is_hallucination(text: str, clip_samples: int) -> bool:
    lowered = text.lower()
    if any(h in lowered for h in HALLUCINATIONS):
        return True
    bare = lowered.strip(" ¡!¿?.,…")
    return clip_samples < SHORT_CLIP and bare in SHORT_HALLUCINATIONS


def tail_sentences(text: str) -> str:
    """The end of an in-progress transcript: the last sentence, plus the one
    before it if the last is still very short."""
    parts = split_sentences(text)
    if len(parts) > 1 and len(parts[-1]) < 20:
        return f"{parts[-2]} {parts[-1]}"
    return parts[-1] if parts else ""

log = logging.getLogger("cc-translator")


class Engine:
    def __init__(self, model_name: str, device: str):
        compute_type = "float16" if device == "cuda" else "int8"
        start = time.perf_counter()
        self.whisper = WhisperModel(model_name, device=device, compute_type=compute_type)
        self.translator = Translator(device=device)
        self.lock = asyncio.Lock()
        log.info("Loaded %s on %s in %.1fs", model_name, device, time.perf_counter() - start)

    def _transcribe(self, audio: np.ndarray, prompt: str | None):
        segments, _ = self.whisper.transcribe(
            audio, language="es", beam_size=5, vad_filter=False,
            condition_on_previous_text=False, initial_prompt=prompt or None,
        )
        kept = []
        for s in segments:
            text = s.text.strip()
            if not text or (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8):
                continue
            if is_hallucination(text, len(audio)):
                continue
            kept.append((s.start, s.end, text))
        english = self.translator.translate([t for _, _, t in kept])
        return [(start, end, es, en) for (start, end, es), en in zip(kept, english)]

    def _transcribe_partial(self, audio: np.ndarray, prompt: str | None):
        # Greedy decoding: about 3x faster than the beam search used for final captions.
        segments, _ = self.whisper.transcribe(
            audio, language="es", beam_size=1, temperature=0.0, without_timestamps=True,
            vad_filter=False, condition_on_previous_text=False, initial_prompt=prompt or None,
        )
        text = " ".join(
            s.text.strip() for s in segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8)
        ).strip()
        if not text or is_hallucination(text, len(audio)):
            return None
        es = tail_sentences(text)
        return es, self.translator.translate([es])[0]

    async def caption(self, audio: np.ndarray, prompt: str | None):
        async with self.lock:
            return await asyncio.to_thread(self._transcribe, audio, prompt)

    async def partial(self, audio: np.ndarray, prompt: str | None):
        if self.lock.locked():
            return None  # final captions come first; skip this guess
        async with self.lock:
            return await asyncio.to_thread(self._transcribe_partial, audio, prompt)


class CaptionSession:
    def __init__(self, ws, engine: Engine):
        self.ws = ws
        self.engine = engine
        self.buffer = np.zeros(0, np.float32)
        self.offset = 0                 # stream sample index of buffer[0]
        self.since_check = 0
        self.prev_text = ""
        self.queue: asyncio.Queue = asyncio.Queue()
        self.seg_id = 0                 # id of the sentence currently being spoken
        self.last_partial = 0.0
        self.partial_task: asyncio.Task | None = None

    async def send(self, msg: dict):
        try:
            await self.ws.send(json.dumps(msg, ensure_ascii=False))
        except ConnectionClosed:
            pass

    async def add_audio(self, data: bytes):
        chunk = np.frombuffer(data, np.float32)
        self.buffer = np.concatenate([self.buffer, chunk])
        self.since_check += len(chunk)
        if self.since_check >= CHECK_EVERY:
            self.since_check = 0
            await self.find_sentence()

    async def find_sentence(self):
        speech = await asyncio.to_thread(get_speech_timestamps, self.buffer, VAD)
        n = len(self.buffer)
        if not speech:
            drop = max(0, n - PAD)
            self.buffer = self.buffer[drop:]
            self.offset += drop
            return

        seg_start = max(0, speech[0]["start"] - PAD)
        if n - speech[-1]["end"] >= END_SILENCE:
            cut = speech[-1]["end"]
        elif n >= MAX_SEGMENT:
            # Cut in the gap before the last stretch of speech if there is one.
            cut = (speech[-2]["end"] + speech[-1]["start"]) // 2 if len(speech) > 1 else n
        else:
            self.maybe_partial(seg_start)
            return

        seg_end = min(n, cut + PAD)
        audio = self.buffer[seg_start:seg_end].copy()
        t0, t1 = (self.offset + seg_start) / SR, (self.offset + seg_end) / SR
        self.buffer = self.buffer[cut:]
        self.offset += cut

        seg_id = self.seg_id
        self.seg_id += 1  # any partial still in flight for this sentence is now stale
        await self.send({"type": "speech_end", "id": seg_id, "start": t0, "end": t1})
        self.queue.put_nowait((seg_id, audio, t0))

    def maybe_partial(self, seg_start: int):
        """While someone is still talking, send a quick guess at what they've said so far."""
        if self.partial_task and not self.partial_task.done():
            return
        if time.monotonic() - self.last_partial < PARTIAL_EVERY or len(self.buffer) - seg_start < MIN_PARTIAL:
            return
        self.last_partial = time.monotonic()
        audio = self.buffer[seg_start:].copy()
        t0 = (self.offset + seg_start) / SR
        self.partial_task = asyncio.create_task(self.send_partial(self.seg_id, audio, t0))

    async def send_partial(self, seg_id: int, audio: np.ndarray, t0: float):
        result = await self.engine.partial(audio, self.prev_text[-200:])
        if result is None:
            log.info("   … #%d %.1fs of speech: no partial (%s)", seg_id, len(audio) / SR,
                     "busy" if self.engine.lock.locked() else "nothing recognised")
        elif seg_id == self.seg_id:
            es, en = result
            log.info("   … #%d %.1fs of speech: %s  |  %s", seg_id, len(audio) / SR, es, en)
            await self.send({"type": "partial", "id": seg_id, "start": t0, "end": t0 + len(audio) / SR, "es": es, "en": en})

    async def run_worker(self):
        while True:
            seg_id, audio, t0 = await self.queue.get()
            started = time.perf_counter()
            lines = await self.engine.caption(audio, self.prev_text[-200:])
            for start, end, es, en in lines:
                log.info("FINAL #%d [%7.2f] %s  |  %s", seg_id, t0 + start, es, en)
                await self.send({"type": "caption", "id": seg_id, "start": t0 + start, "end": t0 + end, "es": es, "en": en})
            if not lines:
                await self.send({"type": "no_speech", "id": seg_id, "start": t0, "end": t0 + len(audio) / SR})
            if lines:
                self.prev_text = " ".join(es for _, _, es, _ in lines)
            log.debug("Captioned %.1fs of audio in %.2fs", len(audio) / SR, time.perf_counter() - started)


def only_extensions(connection, request):
    """Refuse connections from web pages; only the browser extension may connect."""
    origin = request.headers.get("Origin", "")
    if not origin.startswith("chrome-extension://"):
        return connection.respond(HTTPStatus.FORBIDDEN, "Only the CC Translator extension may connect.\n")
    return None


async def main():
    parser = argparse.ArgumentParser(description="CC Translator helper")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s.%(msecs)03d %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    engine = Engine(args.model, args.device)

    async def handler(ws):
        log.info("Extension connected")
        session = CaptionSession(ws, engine)
        worker = asyncio.create_task(session.run_worker())
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    await session.add_audio(message)
                elif json.loads(message).get("type") == "hello":
                    await session.send({"type": "hello", "model": args.model})
        except ConnectionClosed:
            pass
        finally:
            worker.cancel()
            if session.partial_task:
                session.partial_task.cancel()
            log.info("Extension disconnected")

    async with serve(handler, "127.0.0.1", args.port, process_request=only_extensions, max_size=2**20):
        log.info("Listening on ws://127.0.0.1:%d  (Ctrl+C to stop)", args.port)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
