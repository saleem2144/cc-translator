"""Pretend to be the extension: stream a WAV file to the helper and print the captions.

Usage: python test_client.py audio.wav [--url ws://127.0.0.1:8765]
The WAV must be 16 kHz mono 16-bit.
"""
import argparse
import asyncio
import json
import wave

import numpy as np
from websockets.asyncio.client import connect

CHUNK = 4000  # 0.25 s, same as the extension


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wav")
    parser.add_argument("--url", default="ws://127.0.0.1:8765")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    args = parser.parse_args()

    with wave.open(args.wav) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono 16-bit"
        audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    audio = np.concatenate([audio, np.zeros(16000 * 2, np.float32)])  # trailing silence ends the last sentence

    async with connect(args.url, origin="chrome-extension://test-client") as ws:
        await ws.send(json.dumps({"type": "start", "sampleRate": 16000}))

        sent = 0  # seconds of audio sent so far, i.e. "now" in the audio

        async def receive():
            async for message in ws:
                msg = json.loads(message)
                lag = sent - msg["end"]
                if msg["type"] in ("caption", "partial"):
                    tag = "FINAL  " if msg["type"] == "caption" else "partial"
                    print(f"{tag} at {sent:6.2f}s (lag {lag:4.2f}s)  ES: {msg['es']}\n{'':33}EN: {msg['en']}")
                else:
                    print(f"  ({msg['type']} at {sent:.2f}s)")

        receiver = asyncio.create_task(receive())
        for i in range(0, len(audio), CHUNK):
            await ws.send(audio[i:i + CHUNK].tobytes())
            sent = (i + CHUNK) / 16000
            await asyncio.sleep(0.25 / args.speed)
        await asyncio.sleep(3)
        receiver.cancel()


if __name__ == "__main__":
    asyncio.run(main())
