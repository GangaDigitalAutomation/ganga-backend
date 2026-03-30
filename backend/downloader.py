from __future__ import annotations

import mimetypes
from pathlib import Path


def detect_mime_type(file_path: Path, fallback: str = "video/mp4") -> str:
    guessed, _ = mimetypes.guess_type(str(file_path))
    return guessed or fallback
