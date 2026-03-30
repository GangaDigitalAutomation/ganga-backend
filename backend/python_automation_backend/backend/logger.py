import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AutomationLogger:
    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def _timestamp(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _write_file(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def log(self, level: str, message: str, **fields: Any) -> None:
        payload = {
            "ts": self._timestamp(),
            "level": level.upper(),
            "message": message,
            **fields,
        }
        human = f"[{payload['ts']}] [{payload['level']}] {message}"
        if fields:
            human += f" | {json.dumps(fields, ensure_ascii=True)}"
        print(human, flush=True)
        self._write_file(payload)

    def info(self, message: str, **fields: Any) -> None:
        self.log("INFO", message, **fields)

    def warning(self, message: str, **fields: Any) -> None:
        self.log("WARNING", message, **fields)

    def error(self, message: str, **fields: Any) -> None:
        self.log("ERROR", message, **fields)
