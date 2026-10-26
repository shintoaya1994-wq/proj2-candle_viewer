"""The chat behind the interface: a local model, Claude Code, or Codex, chosen by the user.

The local model speaks the OpenAI chat API and gets what it needs as text:
the records of the signal in question and the latest bars. Claude Code and
Codex run as commands with the MCP server of this application attached, so
they can read bars, mark signals and write screens themselves.

Every answer streams back as server-sent events: ``text`` pieces, ``tool``
calls as they happen, and ``done`` with the id of the session to continue.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

import httpx2 as httpx
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from ..app.bars import BarStore
from ..app.projects import Projects, Space
from .mcp_server import build as build_tools
from ..app.studies import write_json

Provider = Literal["local", "claude", "codex"]
SETTINGS_FILE = "ai.json"
TOOL_PATTERN = "mcp__candle-viewer__*"
RECENT_BARS = 80
MAX_ROUNDS = 16
MAX_TOOL_TEXT = 60_000


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class LocalSettings(Model):
    enabled: bool = True
    base_url: str = "http://127.0.0.1:8000/v1"
    model: str = ""              # empty: the first model the server lists
    api_key: str = ""
    label: str = "本地模型"


class CommandSettings(Model):
    enabled: bool = True
    command: str = ""            # empty: found on the PATH
    label: str = ""


class Settings(Model):
    local: LocalSettings = Field(default_factory=LocalSettings)
    claude: CommandSettings = Field(default_factory=lambda: CommandSettings(label="Claude Code"))
    codex: CommandSettings = Field(default_factory=lambda: CommandSettings(label="Codex"))


class Availability(Model):
    provider: Provider
    label: str
    enabled: bool
    available: bool
    detail: str = ""


class Message(Model):
    role: Literal["user", "assistant"]
    content: str


class Context(Model):
    """What the user is looking at while they ask."""

    symbol: str | None = None
    timeframe: str | None = None
    signal: str | None = None
    project: str = ""


class Request(Model):
    provider: Provider
    chat: str                    # names the conversation, so that a command continues its session
    messages: list[Message]      # the whole conversation for the local model; the last one is the question
    context: Context = Field(default_factory=Context)


class ChatError(RuntimeError):
    pass


def read_settings(workspace: Path) -> Settings:
    path = Path(workspace) / SETTINGS_FILE
    if path.is_file():
        return Settings.model_validate(json.loads(path.read_text(encoding="utf-8")))
    return Settings()


def write_settings(workspace: Path, settings: Settings) -> Settings:
    Path(workspace).mkdir(parents=True, exist_ok=True)
    write_json(Path(workspace) / SETTINGS_FILE, settings.model_dump(by_alias=True))
    return settings


def _event(kind: str, **data) -> str:
    return f"data: {json.dumps({'type': kind, **data}, ensure_ascii=False)}\n\n"


ABOUT = (
    "你在一个外汇交易研究软件里回答问题。用户是自主判断的交易者，用中文交流。"
    "软件里有三种分开的记录：信号（行情给出的点、水平位、线、框，可以有多个版本）、触及（价格某次来到信号）、触及后的策略。"
    "筛选脚本自动找信号，找到的先是候选，由用户确认或否定。时间一律 UTC。回答要简短、具体，不要客套。"
)


class Chat:
    def __init__(self, workspace: Path, bars: BarStore, projects: Projects, convention: str = "utc", transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        self.bars = bars
        self.projects = projects
        self.convention = convention
        self.transport = transport
        self.sessions: dict[tuple[str, str], str] = {}
        self._tools: dict[str, object] = {}

    @property
    def settings(self) -> Settings:
        return read_settings(self.workspace)

    # -- what is available ----------------------------------------------------

    def _command(self, provider: str) -> str | None:
        wanted = getattr(self.settings, provider).command or provider
        return wanted if Path(wanted).is_file() else shutil.which(wanted)

    async def status(self) -> list[Availability]:
        settings = self.settings
        found: list[Availability] = []
        local = Availability(provider="local", label=settings.local.label, enabled=settings.local.enabled, available=False)
        if settings.local.enabled:
            try:
                models = await self._models(settings.local)
                local.available = len(models) > 0
                local.detail = f"模型：{settings.local.model or models[0]}" if models else "服务没有列出模型"
            except Exception as error:  # noqa: BLE001 - whatever is wrong, the user just sees that it is not there
                local.detail = f"连不上 {settings.local.base_url}：{type(error).__name__}"
        found.append(local)
        for provider in ("claude", "codex"):
            command = getattr(settings, provider)
            item = Availability(provider=provider, label=command.label or provider, enabled=command.enabled, available=False)
            if command.enabled:
                path = self._command(provider)
                item.available = path is not None
                item.detail = path or f"找不到命令 {command.command or provider}"
            found.append(item)
        return found

    async def _models(self, local: LocalSettings) -> list[str]:
        async with httpx.AsyncClient(transport=self.transport, timeout=5) as client:
            response = await client.get(f"{local.base_url.rstrip('/')}/models", headers=self._headers(local))
            response.raise_for_status()
            return [item["id"] for item in response.json().get("data", [])]

    @staticmethod
    def _headers(local: LocalSettings) -> dict:
        return {"authorization": f"Bearer {local.api_key}"} if local.api_key else {}

    # -- what the assistant is told -------------------------------------------

    def briefing(self, context: Context, with_bars: bool) -> str:
        parts = [ABOUT]
        space = self.projects.get(context.project)
        parts.append(f"记录属于项目“{space.label}”。" if context.project else "记录是用户的主记录。")
        if context.symbol:
            parts.append(f"用户正在看 {context.symbol.upper()}，周期 {context.timeframe or '?'}。")
        if context.signal:
            try:
                signal = space.signals.get(context.signal)
                current = signal.current
                study = space.signals.study("signal", context.signal)
                parts.append(
                    f"选中的信号 {signal.id}：{current.shape}，周期 {current.timeframe}，锚点 {[(a.timestamp, a.value) for a in current.anchors]}，"
                    f"状态 {signal.status}，来源 {signal.origin}，模型 {signal.models}，快评“{signal.note.tag}”，说明“{current.note}”，"
                    f"触及 {len(signal.touches)} 次。评论：{(study.comment if study else '')[:2000]}"
                )
            except LookupError:
                pass
        if with_bars and context.symbol and context.timeframe:
            try:
                window = self.bars.window(context.symbol, context.timeframe, count=RECENT_BARS)
                rows = ["time,open,high,low,close"]
                for row in window.bars.itertuples(index=False):
                    rows.append(f"{int(row.timestamp)},{row.open},{row.high},{row.low},{row.close}")
                parts.append(f"最近 {len(rows) - 1} 根 K 线（time 为 UTC 毫秒）：\n" + "\n".join(rows))
            except Exception:  # noqa: BLE001
                pass
        return "\n".join(parts)

    # -- answering ---------------------------------------------------------------

    async def answer(self, request: Request) -> AsyncIterator[str]:
        if not request.messages or request.messages[-1].role != "user":
            raise ChatError("the last message has to be the question")
        settings = self.settings
        if request.provider == "local":
            if not settings.local.enabled:
                raise ChatError("本地模型已关闭")
            async for event in self._local(settings.local, request):
                yield event
        else:
            command = getattr(settings, request.provider)
            if not command.enabled:
                raise ChatError(f"{command.label or request.provider} 已关闭")
            path = self._command(request.provider)
            if path is None:
                raise ChatError(f"找不到命令 {command.command or request.provider}")
            async for event in (self._claude if request.provider == "claude" else self._codex)(path, request):
                yield event

    def _server(self, project: str):
        """The tools of this application for the project, the same ones Claude Code and Codex get, held in process."""
        if project not in self._tools:
            self._tools[project] = build_tools(self.workspace, self.convention, project)
        return self._tools[project]

    async def _local(self, local: LocalSettings, request: Request) -> AsyncIterator[str]:
        """The local model, with the tools of the application: it calls them, gets the results, and answers in the end."""
        model = local.model or (await self._models(local))[0]
        server = self._server(request.context.project)
        tools = [{"type": "function", "function": {"name": tool.name, "description": tool.description or "", "parameters": tool.input_schema}} for tool in await server.list_tools()]
        messages: list[dict] = [{"role": "system", "content": self.briefing(request.context, with_bars=False) + "\n你可以调用工具读行情、查记录、运行 Python、标记候选信号。查全部数据或找特征点时用 run_python。"}]
        messages += [{"role": m.role, "content": m.content} for m in request.messages]
        url = f"{local.base_url.rstrip('/')}/chat/completions"
        async with httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(600, connect=10)) as client:
            for _ in range(MAX_ROUNDS):
                content = ""
                calls: dict[int, dict] = {}
                body = {"model": model, "messages": messages, "stream": True, "tools": tools, "tool_choice": "auto"}
                async with client.stream("POST", url, json=body, headers=self._headers(local)) as response:
                    if response.status_code >= 400:
                        raise ChatError(f"模型服务回答 {response.status_code}: {(await response.aread())[:300].decode('utf-8', 'replace')}")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        for choice in chunk.get("choices", []):
                            delta = choice.get("delta", {})
                            if delta.get("reasoning_content"):
                                yield _event("thinking", text=delta["reasoning_content"])
                            if delta.get("content"):
                                content += delta["content"]
                                yield _event("text", text=delta["content"])
                            for piece in delta.get("tool_calls") or []:
                                call = calls.setdefault(piece.get("index", 0), {"id": "", "name": "", "arguments": ""})
                                call["id"] = piece.get("id") or call["id"]
                                function = piece.get("function", {})
                                call["name"] = function.get("name") or call["name"]
                                call["arguments"] += function.get("arguments") or ""
                if not calls:
                    break
                ordered = [calls[index] for index in sorted(calls)]
                messages.append({"role": "assistant", "content": content or None, "tool_calls": [
                    {"id": call["id"] or f"call-{index}", "type": "function", "function": {"name": call["name"], "arguments": call["arguments"] or "{}"}} for index, call in enumerate(ordered)]})
                for index, call in enumerate(ordered):
                    yield _event("tool", name=call["name"])
                    messages.append({"role": "tool", "tool_call_id": call["id"] or f"call-{index}", "content": await self._call(server, call["name"], call["arguments"])})
                if content:
                    yield _event("text", text="\n")
        yield _event("done", session=None)

    @staticmethod
    async def _call(server, name: str, arguments: str) -> str:
        try:
            result = await server.call_tool(name, json.loads(arguments or "{}"))
        except Exception as error:  # noqa: BLE001 - the model gets to see what went wrong
            return f"error: {type(error).__name__}: {error}"
        text = "\n".join(getattr(part, "text", "") for part in getattr(result, "content", []) if getattr(part, "text", ""))
        return text[:MAX_TOOL_TEXT] if text else "(no output)"

    # -- the commands --------------------------------------------------------------

    def _mcp_config(self, project: str) -> dict:
        return {"command": sys.executable, "args": ["-m", "candle_viewer.ai.mcp_server", "--workspace", str(self.workspace), "--convention", self.convention, "--project", project]}

    def _cwd(self, project: str) -> Path:
        """The commands work in the folder of the project, where its screens go."""
        space = self.projects.get(project)
        (space.root / "screens").mkdir(parents=True, exist_ok=True)
        return space.root

    async def _claude(self, path: str, request: Request) -> AsyncIterator[str]:
        question = request.messages[-1].content
        key = (request.chat, "claude")
        with tempfile.NamedTemporaryFile("w", suffix=".json", prefix="candle-mcp-", delete=False) as handle:
            json.dump({"mcpServers": {"candle-viewer": self._mcp_config(request.context.project)}}, handle)
            config = handle.name
        args = [path, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--mcp-config", config, "--allowedTools", TOOL_PATTERN, "--permission-mode", "acceptEdits",
                "--append-system-prompt", self.briefing(request.context, with_bars=False)]
        if key in self.sessions:
            args += ["--resume", self.sessions[key]]
        try:
            async for line in self._run(args, question, request.context.project):
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind == "system" and event.get("session_id"):
                    self.sessions[key] = event["session_id"]
                elif kind == "stream_event":
                    inner = event.get("event", {})
                    delta = inner.get("delta", {})
                    if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                        yield _event("text", text=delta.get("text", ""))
                    elif inner.get("type") == "content_block_start" and inner.get("content_block", {}).get("type") == "tool_use":
                        yield _event("tool", name=inner["content_block"].get("name", ""))
                elif kind == "result":
                    if event.get("session_id"):
                        self.sessions[key] = event["session_id"]
                    if event.get("is_error"):
                        yield _event("error", message=str(event.get("result", ""))[:1000])
                elif kind == "error":
                    yield _event("error", message=str(event.get("message", ""))[:1000])
        finally:
            Path(config).unlink(missing_ok=True)
        yield _event("done", session=self.sessions.get(key))

    async def _codex(self, path: str, request: Request) -> AsyncIterator[str]:
        key = (request.chat, "codex")
        mcp = self._mcp_config(request.context.project)
        prompt = request.messages[-1].content
        if key not in self.sessions:
            prompt = f"{self.briefing(request.context, with_bars=False)}\n\n{prompt}"
        # Nobody is there to approve while the answer streams, so the tools of this application run without asking.
        common = ["--json", "--skip-git-repo-check", "-C", str(self._cwd(request.context.project)), "--approve-for-me",
                  "-c", f"mcp_servers.candle-viewer.command={json.dumps(mcp['command'], ensure_ascii=False)}",
                  "-c", f"mcp_servers.candle-viewer.args={json.dumps(mcp['args'], ensure_ascii=False)}"]
        args = [path, "exec", "resume", self.sessions[key], *common, "-"] if key in self.sessions else [path, "exec", *common, "-"]
        async for line in self._run(args, prompt, request.context.project):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get("type", "")
            if kind == "thread.started" and event.get("thread_id"):
                self.sessions[key] = event["thread_id"]
            elif kind == "item.completed":
                item = event.get("item", {})
                if item.get("type") == "agent_message" and item.get("text"):
                    yield _event("text", text=item["text"] + "\n")
            elif kind == "item.started":
                item = event.get("item", {})
                if item.get("type") in ("mcp_tool_call", "command_execution"):
                    yield _event("tool", name=item.get("tool") or item.get("command") or item.get("type"))
            elif kind == "error" or kind == "turn.failed":
                yield _event("error", message=str(event.get("message") or event.get("error") or event)[:1000])
        yield _event("done", session=self.sessions.get(key))

    async def _run(self, args: list[str], stdin: str, project: str) -> AsyncIterator[str]:
        """Lines a command prints while it works; the command is stopped if the reader goes away."""
        env = {**os.environ, "CANDLE_WORKSPACE": str(self.workspace)}
        process = await asyncio.create_subprocess_exec(
            *args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self._cwd(project), env=env,
        )
        assert process.stdin and process.stdout and process.stderr
        process.stdin.write(stdin.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                yield line.decode("utf-8", "replace").rstrip("\n")
            code = await process.wait()
            if code != 0:
                error = (await process.stderr.read()).decode("utf-8", "replace").strip()
                yield json.dumps({"type": "error", "message": f"{Path(args[0]).name} exited with {code}: {error[-800:]}"})
        finally:
            if process.returncode is None:
                process.kill()
