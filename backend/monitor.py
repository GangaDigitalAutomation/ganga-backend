from __future__ import annotations

import asyncio
import json
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class MonitorState:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "updated_at": None,
            "quota": {},
            "channels": {},
            "logs": [],
            "notifications": [],
            "automation_panel": {"channels": []},
        }
        self._write_snapshot()

    def _write_snapshot(self) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text(json.dumps(self._state, indent=2), encoding="utf-8")

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._state)

    def set_channel_status(self, channel_id: str, status: str, detail: str = "") -> None:
        with self._lock:
            self._state["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._state.setdefault("channels", {})[channel_id] = {
                "status": status,
                "detail": detail,
                "updated_at": self._state["updated_at"],
            }
            self._write_snapshot()

    def set_quota(self, channel_id: str, total: int, used: int, remaining: int) -> None:
        with self._lock:
            self._state["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._state.setdefault("quota", {})[channel_id] = {
                "total": total,
                "used": used,
                "remaining": remaining,
                "updated_at": self._state["updated_at"],
            }
            self._write_snapshot()

    def log(self, message: str, level: str = "info") -> None:
        with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            entry = {"at": now, "level": level, "message": message}
            logs = self._state.setdefault("logs", [])
            logs.append(entry)
            if len(logs) > 1000:
                del logs[:-1000]
            self._state["updated_at"] = now
            self._write_snapshot()

    def notify(self, message: str) -> None:
        with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            notices = self._state.setdefault("notifications", [])
            notices.append({"at": now, "message": message})
            if len(notices) > 200:
                del notices[:-200]
            self._state["updated_at"] = now
            self._write_snapshot()

    def set_automation_panel(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self._state["automation_panel"] = payload
            self._state["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._write_snapshot()


def create_fastapi_app(monitor: MonitorState):
    try:
        from fastapi import FastAPI, WebSocket
        from fastapi.responses import JSONResponse
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("fastapi is required for monitoring API") from exc

    app = FastAPI(title="GDA Monitor", version="1.0.0")

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/status")
    async def status():
        return JSONResponse(monitor.snapshot())

    @app.websocket("/ws")
    async def ws_status(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                await websocket.send_json(monitor.snapshot())
                await asyncio.sleep(1)
        except Exception:
            await websocket.close()

    return app
