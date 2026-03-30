"""
Safe integration wrapper.

Runs the isolated Python automation backend from:
F:/Ganga Digital Automation/backend/python_automation_backend

This file intentionally keeps `python backend/main.py` command compatibility.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    isolated_root = root / "python_automation_backend"
    venv_python = isolated_root / ".venv" / "Scripts" / "python.exe"
    module_target = "backend.main"

    if not isolated_root.exists():
        print("Isolated backend folder not found:", isolated_root)
        return 1
    if not venv_python.exists():
        print("Backend virtual environment not found:", venv_python)
        return 1

    cmd = [str(venv_python), "-m", module_target]
    completed = subprocess.run(cmd, cwd=str(isolated_root), check=False)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
