"""Minimal JSON-RPC 2.0 server over line-delimited stdio.

One request per line on stdin, one response per line on stdout. Handlers are
registered by method name; analysis steps added later plug in via `register`.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any, TextIO

Handler = Callable[[dict[str, Any]], Any]

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


class RpcServer:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}
        self.register("ping", lambda _params: {"pong": True})

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def handle_line(self, line: str) -> dict[str, Any]:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return _error(None, PARSE_ERROR, "Parse error")
        if not isinstance(request, dict) or not isinstance(request.get("method"), str):
            return _error(_id_of(request), INVALID_REQUEST, "Invalid request")
        req_id = request.get("id")
        handler = self._handlers.get(request["method"])
        if handler is None:
            return _error(req_id, METHOD_NOT_FOUND, f"Method not found: {request['method']}")
        params = request.get("params") or {}
        try:
            return {"jsonrpc": "2.0", "id": req_id, "result": handler(params)}
        except Exception as exc:  # noqa: BLE001 - handler failures must never kill the sidecar
            return _error(req_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
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
