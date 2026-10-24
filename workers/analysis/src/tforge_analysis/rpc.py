"""Minimal JSON-RPC 2.0 server over line-delimited stdio.

One request per line on stdin, one response per line on stdout. Handlers are
registered by method name. A handler registered with `progress=True` also gets a
`progress(fraction)` callback; each call writes a `progress` notification line
(`{"method": "progress", "params": {"id": ..., "fraction": ...}}`) before the
response. Handlers raise `AnalysisError` for failures the caller should see by code.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Callable
from typing import Any, TextIO

Handler = Callable[..., Any]
Progress = Callable[[float], None]

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603
ANALYSIS_ERROR = -32000


class AnalysisError(Exception):
    """A failure with a stable code (`decode-failed`, `no-video`, ...) for the caller."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _alive(pid: int) -> bool:
    """Whether process `pid` still runs (POSIX signal 0; on Windows, an exit-code check)."""
    if os.name == "nt":  # pragma: no cover - exercised on Windows only
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ParentGone(SystemExit):
    """The app that asked for this work is gone: stop instead of finishing for nobody."""


def _parent_watch() -> Callable[[], None]:
    raw = os.environ.get("TFORGE_PARENT_PID", "")
    pid = int(raw) if raw.isdigit() else 0
    last = {"at": 0.0}

    def check() -> None:
        if not pid:
            return
        now = time.monotonic()
        if now - last["at"] < 1.0:
            return
        last["at"] = now
        if not _alive(pid):
            raise ParentGone(3)

    return check


class RpcServer:
    def __init__(self) -> None:
        self._handlers: dict[str, tuple[Handler, bool]] = {}
        self._out: TextIO | None = None
        self._parent_alive = _parent_watch()
        self.register("ping", lambda _params: {"pong": True})

    def register(self, method: str, handler: Handler, *, progress: bool = False) -> None:
        self._handlers[method] = (handler, progress)

    def _progress_for(self, req_id: Any) -> Progress:
        last = {"fraction": -1.0, "at": 0.0}

        def progress(fraction: float) -> None:
            self._parent_alive()  # long work reports progress often: a good place to notice
            fraction = min(1.0, max(0.0, float(fraction)))
            now = time.monotonic()
            # Throttle: at most ~10 lines a second unless the value jumped.
            if fraction - last["fraction"] < 0.01 and now - last["at"] < 0.1:
                return
            last["fraction"], last["at"] = fraction, now
            if self._out is not None:
                note = {"method": "progress", "params": {"id": req_id, "fraction": fraction}}
                self._out.write(json.dumps({"jsonrpc": "2.0", **note}) + "\n")
                self._out.flush()

        return progress

    def handle_line(self, line: str) -> dict[str, Any]:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return _error(None, PARSE_ERROR, "Parse error")
        if not isinstance(request, dict) or not isinstance(request.get("method"), str):
            return _error(_id_of(request), INVALID_REQUEST, "Invalid request")
        req_id = request.get("id")
        entry = self._handlers.get(request["method"])
        if entry is None:
            return _error(req_id, METHOD_NOT_FOUND, f"Method not found: {request['method']}")
        handler, wants_progress = entry
        params = request.get("params") or {}
        try:
            result = (
                handler(params, self._progress_for(req_id)) if wants_progress else handler(params)
            )
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except AnalysisError as exc:
            err = _error(req_id, ANALYSIS_ERROR, str(exc))
            err["error"]["data"] = {"code": exc.code}
            return err
        except Exception as exc:  # noqa: BLE001 - handler failures must never kill the sidecar
            return _error(req_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        self._out = stdout
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            stdout.write(json.dumps(self.handle_line(line)) + "\n")
            stdout.flush()


def _id_of(request: Any) -> Any:
    return request.get("id") if isinstance(request, dict) else None


def _error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
