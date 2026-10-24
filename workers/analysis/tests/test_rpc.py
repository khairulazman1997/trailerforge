import io
import json
import os
import subprocess
import sys

from tforge_analysis.rpc import RpcServer


def call(server: RpcServer, payload: object) -> dict:
    return server.handle_line(json.dumps(payload))


def test_ping():
    resp = call(RpcServer(), {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp == {"jsonrpc": "2.0", "id": 1, "result": {"pong": True}}


def test_unknown_method():
    resp = call(RpcServer(), {"jsonrpc": "2.0", "id": 2, "method": "nope"})
    assert resp["error"]["code"] == -32601


def test_parse_error():
    resp = RpcServer().handle_line("{not json")
    assert resp["error"]["code"] == -32700


def test_invalid_request():
    resp = call(RpcServer(), {"id": 3})
    assert resp["error"]["code"] == -32600


def test_handler_exception_does_not_crash():
    server = RpcServer()
    server.register("boom", lambda _p: 1 / 0)
    resp = call(server, {"jsonrpc": "2.0", "id": 4, "method": "boom"})
    assert resp["error"]["code"] == -32603
    assert call(server, {"jsonrpc": "2.0", "id": 5, "method": "ping"})["result"] == {"pong": True}


def test_serve_loop():
    out = io.StringIO()
    stdin = io.StringIO(
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    )
    RpcServer().serve(stdin, out)
    lines = out.getvalue().strip().splitlines()
    assert [json.loads(line)["id"] for line in lines] == [1, 2]


def test_sidecar_process_answers_ping():
    proc = subprocess.run(
        [sys.executable, "-m", "tforge_analysis"],
        input='{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
        capture_output=True,
        check=False,
        text=True,
        timeout=20,
    )
    assert json.loads(proc.stdout)["result"] == {"pong": True}


def test_stops_when_the_app_that_asked_is_gone(monkeypatch):
    import pytest

    from tforge_analysis.rpc import ParentGone

    done = subprocess.run([sys.executable, "-c", "pass"], check=True)
    assert done.returncode == 0
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    monkeypatch.setenv("TFORGE_PARENT_PID", str(dead.pid))
    server = RpcServer()
    with pytest.raises(ParentGone):
        server._progress_for(1)(0.5)
    monkeypatch.setenv("TFORGE_PARENT_PID", str(os.getpid()))
    RpcServer()._progress_for(1)(0.5)  # alive: carries on
