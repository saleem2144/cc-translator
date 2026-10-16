"""Spanish -> English translation with Opus-MT running on CTranslate2."""
import re
from pathlib import Path

import ctranslate2
import sentencepiece as spm

MODEL_DIR = Path(__file__).parent / "models" / "opus-mt-es-en"
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def split_sentences(text: str) -> list[str]:
    return [s for s in SENTENCE_END.split(text.strip()) if s]


class Translator:
    def __init__(self, device: str = "cuda"):
        if not (MODEL_DIR / "model.bin").exists():
            raise FileNotFoundError(f"Translation model missing. Run setup_models.py first ({MODEL_DIR}).")
        compute_type = "int8_float16" if device == "cuda" else "int8"
        self.model = ctranslate2.Translator(str(MODEL_DIR), device=device, compute_type=compute_type)
        self.source = spm.SentencePieceProcessor(model_file=str(MODEL_DIR / "source.spm"))
        self.target = spm.SentencePieceProcessor(model_file=str(MODEL_DIR / "target.spm"))

    def translate(self, texts: list[str]) -> list[str]:
        """Translate each text. Multi-sentence texts are split first, because
        Opus-MT tends to drop a sentence when given several at once."""
        if not texts:
            return []
        pieces = [split_sentences(t) or [t] for t in texts]
        flat = [s for p in pieces for s in p]
        batch = [self.source.encode(s, out_type=str) + ["</s>"] for s in flat]
        results = self.model.translate_batch(batch, beam_size=4, max_decoding_length=256)
        english = iter(self.target.decode(r.hypotheses[0]) for r in results)
        return [" ".join(next(english) for _ in p) for p in pieces]
