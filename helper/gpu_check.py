"""Check that Whisper runs on the GPU and measure its speed.

Usage: python gpu_check.py [audio_file]
Without a file it transcribes 30 seconds of generated noise (speed check only).
"""
import sys
import time

import gpu_libs  # noqa: F401  (must come before faster_whisper)
import ctranslate2
import numpy as np
from faster_whisper import WhisperModel

MODEL = "large-v3"

print("CUDA devices:", ctranslate2.get_cuda_device_count())
print("Supported compute types:", ctranslate2.get_supported_compute_types("cuda"))

start = time.perf_counter()
model = WhisperModel(MODEL, device="cuda", compute_type="float16")
print(f"Loaded {MODEL} in {time.perf_counter() - start:.1f}s")

if len(sys.argv) > 1:
    audio = sys.argv[1]
    duration = None
else:
    audio = (np.random.randn(16000 * 30) * 0.01).astype(np.float32)
    duration = 30.0

start = time.perf_counter()
segments, info = model.transcribe(audio, language="es", beam_size=5, vad_filter=False)
segments = list(segments)
elapsed = time.perf_counter() - start
duration = duration or info.duration

for s in segments:
    print(f"[{s.start:6.2f} -> {s.end:6.2f}] {s.text.strip()}")
print(f"Transcribed {duration:.1f}s of audio in {elapsed:.2f}s ({duration / elapsed:.1f}x real time)")
