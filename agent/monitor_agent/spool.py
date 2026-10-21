"""Bounded on-disk spool for telemetry that could not be delivered.

Each batch is one JSON file named by a monotonic sequence. When the spool exceeds its file or
byte limit, the oldest batches are dropped (and counted) — the agent never grows without bound.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any


class Spool:
    def __init__(self, directory: str | Path, max_files: int = 2000, max_bytes: int = 50 * 2**20):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        self.max_files = max_files
        self.max_bytes = max_bytes
        self.dropped = 0

    def _files(self) -> list[Path]:
        return sorted(p for p in self.dir.glob("*.json") if p.is_file())

    def depth(self) -> int:
        return len(self._files())

    def push(self, kind: str, payload: dict[str, Any]) -> None:
        name = f"{time.time_ns():020d}-{kind}.json"
        tmp = self.dir / (name + ".tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, self.dir / name)
        self._enforce()

    def _enforce(self) -> None:
        files = self._files()
        total = sum(f.stat().st_size for f in files)
        while files and (len(files) > self.max_files or total > self.max_bytes):
            victim = files.pop(0)
            try:
                total -= victim.stat().st_size
                victim.unlink()
                self.dropped += 1
            except OSError:
                break

    def peek(self, limit: int = 10) -> list[tuple[Path, str, dict[str, Any]]]:
        out = []
        for f in self._files()[:limit]:
            try:
                kind = f.stem.split("-", 1)[1]
                out.append((f, kind, json.loads(f.read_text(encoding="utf-8"))))
            except (OSError, ValueError, IndexError):
                f.unlink(missing_ok=True)  # corrupt entry
        return out

    @staticmethod
    def ack(path: Path) -> None:
        path.unlink(missing_ok=True)
