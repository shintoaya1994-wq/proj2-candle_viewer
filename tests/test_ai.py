import asyncio
import json
import os
import stat
from pathlib import Path

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from candle_viewer.ai import chat as chatting
from candle_viewer.ai.mcp_server import build
from candle_viewer.app.main import create_app

from .conftest import ms
from .test_app import content


def sse(body: str) -> list[dict]:
    """The events of a streamed answer."""
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]


class FakeModel:
    """An OpenAI-compatible server that answers with what it was asked."""

    def __init__(self) -> None:
        self.requests: list[dict] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "fake-model"}, {"id": "other"}]})
        body = json.loads(request.content)
        self.requests.append(body)
        question = body["messages"][-1]["content"]
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "想一想。"}}]},
            {"choices": [{"delta": {"content": f"你问的是：{question}"}}]},
            {"choices": [{"delta": {"content": "。"}}]},
        ]
        text = "".join(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=text.encode("utf-8"))


@pytest.fixture
def fake():
    return FakeModel()


@pytest.fixture
def app(tmp_path, fake):
    return TestClient(create_app(tmp_path, frontend=None, ai_transport=httpx.MockTransport(fake.handle))), tmp_path


def fake_command(folder: Path, name: str, script: str) -> str:
    path = folder / name
    path.write_text(f"#!/bin/sh\n{script}\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


class TestSettings:
    def test_defaults_and_saving(self, app):
        client, workspace = app
        settings = client.get("/api/ai/settings").json()
        assert settings["local"]["baseUrl"] == "http://127.0.0.1:8000/v1" and settings["claude"]["enabled"]
        settings["local"]["model"] = "other"
        settings["codex"]["enabled"] = False
        assert client.put("/api/ai/settings", json=settings).json()["local"]["model"] == "other"
        assert json.loads((workspace / "ai.json").read_text(encoding="utf-8"))["codex"]["enabled"] is False
        assert client.get("/api/ai/settings").json() == settings

    def test_status_tells_what_can_be_used(self, app, tmp_path):
        client, workspace = app
        settings = client.get("/api/ai/settings").json()
        settings["claude"]["command"] = fake_command(tmp_path, "claude", "exit 0")
        settings["codex"]["command"] = "/nowhere/codex"
        client.put("/api/ai/settings", json=settings)
        status = {item["provider"]: item for item in client.get("/api/ai/status").json()}
        assert status["local"]["available"] and "fake-model" in status["local"]["detail"]
        assert status["claude"]["available"] and status["claude"]["detail"].endswith("claude")
        assert not status["codex"]["available"] and "找不到" in status["codex"]["detail"]


class TestLocalModel:
    def test_the_answer_streams_with_the_context_in_front(self, app, fake):
        client, _ = app
        signal = client.post("/api/signals", json={"symbol": "testfx", "shape": "point", "timeframe": "d1", "anchors": [{"timestamp": ms("2024-01-10"), "value": 1.2345}], "models": ["模型甲"]}).json()
        client.put(f"/api/signals/{signal['id']}/study", json=content(tag="高点", comment="感觉如此"))
        request = {"provider": "local", "chat": "c1", "messages": [{"role": "user", "content": "这个信号怎么看？"}], "context": {"symbol": "testfx", "timeframe": "d1", "signal": signal["id"]}}
        response = client.post("/api/chat", json=request)
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
        events = sse(response.text)
        assert events[0] == {"type": "thinking", "text": "想一想。"}
        assert "".join(event["text"] for event in events if event["type"] == "text") == "你问的是：这个信号怎么看？。"
        assert events[-1] == {"type": "done", "session": None}
        [sent] = fake.requests
        assert sent["model"] == "fake-model" and sent["stream"] is True
        system = sent["messages"][0]
        assert system["role"] == "system" and "TESTFX" in system["content"] and "模型甲" in system["content"] and "感觉如此" in system["content"] and "高点" in system["content"]

    def test_a_closed_provider_is_refused_gently(self, app):
        client, _ = app
        settings = client.get("/api/ai/settings").json()
        settings["local"]["enabled"] = False
        client.put("/api/ai/settings", json=settings)
        events = sse(client.post("/api/chat", json={"provider": "local", "chat": "c", "messages": [{"role": "user", "content": "hi"}]}).text)
        assert events[0]["type"] == "error" and "关闭" in events[0]["message"]

    def test_the_question_has_to_come_last(self, app):
        client, _ = app
        events = sse(client.post("/api/chat", json={"provider": "local", "chat": "c", "messages": [{"role": "assistant", "content": "hi"}]}).text)
        assert events[0]["type"] == "error"


CLAUDE_SCRIPT = r'''
cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
echo '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__candle-viewer__get_bars"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"看了"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"一下。"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"看了一下。"}'
echo "$@" > "$(dirname "$0")/claude-args"
'''

CODEX_SCRIPT = r'''
cat > "$(dirname "$0")/codex-stdin"
echo '{"type":"thread.started","thread_id":"thread-9"}'
echo '{"type":"item.started","item":{"type":"mcp_tool_call","tool":"list_signals"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"两个信号。"}}'
echo '{"type":"turn.completed"}'
echo "$@" > "$(dirname "$0")/codex-args"
'''


class TestCommands:
    def test_claude_streams_and_keeps_its_session(self, app, tmp_path):
        client, workspace = app
        settings = client.get("/api/ai/settings").json()
        settings["claude"]["command"] = fake_command(tmp_path, "claude", CLAUDE_SCRIPT)
        client.put("/api/ai/settings", json=settings)
        request = {"provider": "claude", "chat": "c1", "messages": [{"role": "user", "content": "看看"}], "context": {"symbol": "testfx"}}
        events = sse(client.post("/api/chat", json=request).text)
        assert [event["type"] for event in events] == ["tool", "text", "text", "done"]
        assert events[0]["name"] == "mcp__candle-viewer__get_bars" and events[-1]["session"] == "sess-1"
        args = (tmp_path / "claude-args").read_text(encoding="utf-8")
        assert "--mcp-config" in args and "mcp__candle-viewer__*" in args and "--resume" not in args
        assert "TESTFX" in args, "the context goes with the system prompt"
        sse(client.post("/api/chat", json=request).text)
        assert "--resume sess-1" in (tmp_path / "claude-args").read_text(encoding="utf-8")

    def test_codex_gets_the_context_once_and_resumes(self, app, tmp_path):
        client, workspace = app
        settings = client.get("/api/ai/settings").json()
        settings["codex"]["command"] = fake_command(tmp_path, "codex", CODEX_SCRIPT)
        client.put("/api/ai/settings", json=settings)
        request = {"provider": "codex", "chat": "c2", "messages": [{"role": "user", "content": "有几个信号？"}], "context": {"symbol": "testfx"}}
        events = sse(client.post("/api/chat", json=request).text)
        assert [event["type"] for event in events] == ["tool", "text", "done"]
        assert events[1]["text"].startswith("两个信号。") and events[-1]["session"] == "thread-9"
        first = (tmp_path / "codex-stdin").read_text(encoding="utf-8")
        assert "TESTFX" in first and first.rstrip().endswith("有几个信号？")
        assert "mcp_servers.candle-viewer.command=" in (tmp_path / "codex-args").read_text(encoding="utf-8")
        sse(client.post("/api/chat", json=request).text)
        assert (tmp_path / "codex-args").read_text(encoding="utf-8").startswith("exec resume thread-9")
        assert "TESTFX" not in (tmp_path / "codex-stdin").read_text(encoding="utf-8"), "the context is given once"

    def test_a_failing_command_is_reported(self, app, tmp_path):
        client, _ = app
        settings = client.get("/api/ai/settings").json()
        settings["claude"]["command"] = fake_command(tmp_path, "claude", "cat > /dev/null; echo boom >&2; exit 3")
        client.put("/api/ai/settings", json=settings)
        events = sse(client.post("/api/chat", json={"provider": "claude", "chat": "c", "messages": [{"role": "user", "content": "hi"}]}).text)
        assert events[0]["type"] == "error" and "exited with 3" in events[0]["message"] and "boom" in events[0]["message"]


class TestMcpServer:
    def test_tools_work_on_the_records(self, tmp_path):
        from candle_viewer.market import store
        from candle_viewer.market.rebuild import RebuildConfig, rebuild_symbol

        from .conftest import random_walk, trading_weeks

        result = rebuild_symbol("testfx", random_walk(trading_weeks("2024-01-07", 4), seed=5, start_price=1.25, volumes=True), None, RebuildConfig())
        folder = store.dataset_dir(tmp_path, "utc")
        store.write_bars(folder, "testfx", result.bars)
        store.write_manifest(folder, {"convention": "utc", "symbols": {"testfx": {"pip": 0.0001}}})
        server = build(tmp_path)

        async def scenario():
            names = [tool.name for tool in await server.list_tools()]
            assert {"get_bars", "create_signal", "run_screen", "check_screen", "save_screen"} <= set(names)
            text = lambda result: result.content[0].text  # noqa: E731
            bars = text(await server.call_tool("get_bars", {"symbol": "testfx", "timeframe": "h1", "around": "2024-01-10 13:00", "count": 5}))
            assert bars.startswith("time,open,high,low,close,volume") and len(bars.splitlines()) == 6
            signal_id = text(await server.call_tool("create_signal", {"symbol": "testfx", "shape": "point", "timeframe": "h1", "anchors": [{"time": "2024-01-10 13:00", "value": 1.25}], "models": ["模型甲"], "note": "试"}))
            listed = json.loads(text(await server.call_tool("list_signals", {"symbol": "testfx"})))
            assert listed[0]["id"] == signal_id and listed[0]["status"] == "candidate" and listed[0]["origin"] == "assistant"
            assert text(await server.call_tool("change_signal", {"signal_id": signal_id, "status": "confirmed"})) == "confirmed"
            touch = text(await server.call_tool("add_touch", {"signal_id": signal_id, "time": "2024-01-20 10:00", "value": 1.251, "timeframe": "h1", "rule": "5 点以内"}))
            assert touch.startswith("t")
            saved = text(await server.call_tool("save_screen", {"name": "mine", "source": "from candle_viewer.screens.local_extremes import run\nNAME='mine'\nPARAMS={'timeframe':'d1','window':3}\n"}))
            assert "saved" in saved and (tmp_path / "screens" / "mine.py").is_file()
            assert "passed" in text(await server.call_tool("check_screen", {"name": "mine", "symbol": "testfx"}))
            assert "new candidates" in text(await server.call_tool("run_screen", {"name": "mine", "symbol": "testfx"}))
            with pytest.raises(Exception):
                await server.call_tool("save_screen", {"name": "bad", "source": "NAME = 'bad'\n"})
            assert not (tmp_path / "screens" / "bad.py").exists()

        asyncio.run(scenario())
