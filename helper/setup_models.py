"""One-time setup: download the Spanish->English Opus-MT model and convert it
for CTranslate2 (the same fast engine faster-whisper uses).

Run with:  uv run --group convert python setup_models.py
"""
from pathlib import Path

from ctranslate2.converters import TransformersConverter

MODEL = "Helsinki-NLP/opus-mt-es-en"
OUT = Path(__file__).parent / "models" / "opus-mt-es-en"

if (OUT / "model.bin").exists():
    print(f"Already converted: {OUT}")
else:
    TransformersConverter(MODEL, copy_files=["source.spm", "target.spm"]).convert(str(OUT), quantization="int8_float16")
    print(f"Converted {MODEL} -> {OUT}")
