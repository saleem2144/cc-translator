"""Make the pip-installed NVIDIA libraries (cuBLAS, cuDNN) findable on Windows.

Import this before faster_whisper / ctranslate2.
"""
import os
import sys
from pathlib import Path


def add_nvidia_dll_dirs() -> None:
    if sys.platform != "win32":
        return
    nvidia_root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for bin_dir in nvidia_root.glob("*/bin"):
        os.add_dll_directory(str(bin_dir))
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


add_nvidia_dll_dirs()
