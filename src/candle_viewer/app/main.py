"""The local web application: bars, studies and signals over HTTP, plus the built frontend."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from ..ai import chat as chatting
from ..market import store
from ..screen import runner, scripts
from .bars import COLUMNS, MAX_COUNT, BarStore, UnknownSeries
from .signals import Changes, InvalidSignal, NewSignal, NewTouch, NewVersion, SignalNotFound, SignalStore, SignalSummary, Strategy, StrategyText, TouchSummary
from .studies import InvalidStudy, Model, Study, StudyContent, StudyNotFound, StudyStore, Summary

FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "dist"
# What the interface may ask for. It goes up whenever an interface built for it would not work with the program before.
API = 2
NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>K 线研究工作台</title>
<body style="font-family: system-ui, sans-serif; padding: 48px; line-height: 1.7">
<h1>界面还没有构建</h1>
<p>请在代码目录里运行下面两条命令，然后刷新本页。</p>
<pre>cd frontend
npm install &amp;&amp; npm run build</pre>
<p>行情和记录的接口已经在运行，见 <a href="/api/docs">/api/docs</a>。</p>
"""

Kind = Literal["signal", "touch"]


class ScreenInfo(Model):
    name: str
    title: str
    params: dict
    shipped: bool
    source: str


class ScreenRequest(Model):
    symbol: str
    params: dict = {}


class ScreenOutcome(Model):
    found: int
    created: list[str]
    known: int


class ScreenDifference(Model):
    cutoff: int
    kind: str
    key: str
    detail: str


class ScreenReport(Model):
    screen: str
    symbol: str
    found: int
    cutoffs: int
    passed: bool
    differences: list[ScreenDifference]


def create_app(workspace: Path, convention: str = "utc", frontend: Path | None = FRONTEND, ai_transport=None) -> FastAPI:
    workspace = Path(workspace).expanduser()
    bars = BarStore(store.dataset_dir(workspace, convention))
    studies = StudyStore(workspace / "studies")
    signals = SignalStore(workspace / "signals")
    chat = chatting.Chat(workspace, bars, signals, convention, transport=ai_transport)
    app = FastAPI(title="Candle Viewer", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    @app.exception_handler(StudyNotFound)
    @app.exception_handler(SignalNotFound)
    def not_found(_, error: LookupError) -> JSONResponse:
        return JSONResponse({"detail": f"not found: {error}"}, status_code=404)

    @app.exception_handler(InvalidStudy)
    @app.exception_handler(InvalidSignal)
    @app.exception_handler(scripts.BadScreen)
    def invalid(_, error: ValueError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=422)

    @app.exception_handler(scripts.UnknownScreen)
    def unknown_screen(_, error: LookupError) -> JSONResponse:
        return JSONResponse({"detail": f"no screen named {error}"}, status_code=404)

    # -- bars ------------------------------------------------------------------

    @app.get("/api/meta")
    def meta() -> dict:
        return {**bars.meta(), "api": API}

    @app.get("/api/bars")
    def window(
        symbol: str,
        timeframe: str,
        before: int | None = None,
        after: int | None = None,
        around: int | None = None,
        since: int | None = None,
        count: int = Query(1000, ge=1, le=MAX_COUNT),
    ) -> dict:
        try:
            found = bars.window(symbol, timeframe, before=before, after=after, around=around, since=since, count=count)
        except UnknownSeries as error:
            raise HTTPException(404, f"no bars for {error}") from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        frame = found.bars
        # JSON has no NaN; an unknown volume travels as null.
        rows = frame.astype(object).where(frame.notna(), None).to_numpy().tolist() if len(frame) else []
        return {"columns": list(COLUMNS), "bars": rows, "older": found.older, "newer": found.newer}

    # -- studies that stand on their own ---------------------------------------

    @app.get("/api/studies")
    def list_studies() -> list[Summary]:
        return studies.list()

    @app.post("/api/studies", status_code=201)
    def create_study(content: StudyContent) -> Study:
        return studies.create(content)

    @app.get("/api/studies/{study_id}")
    def get_study(study_id: str) -> Study:
        return studies.get(study_id)

    @app.put("/api/studies/{study_id}")
    def update_study(study_id: str, content: StudyContent) -> Study:
        return studies.update(study_id, content)

    @app.delete("/api/studies/{study_id}", status_code=204)
    def delete_study(study_id: str) -> None:
        studies.delete(study_id)

    @app.get("/api/studies/{study_id}/screenshot")
    def screenshot(study_id: str) -> FileResponse:
        return FileResponse(studies.screenshot(study_id), media_type="image/png")

    # -- signals ---------------------------------------------------------------

    @app.get("/api/signals")
    def list_signals(symbol: str | None = None) -> list[SignalSummary]:
        return signals.list(symbol)

    @app.post("/api/signals", status_code=201)
    def create_signal(new: NewSignal) -> SignalSummary:
        return signals.get(signals.create(new).id)

    @app.get("/api/signals/{signal_id}")
    def get_signal(signal_id: str) -> SignalSummary:
        return signals.get(signal_id)

    @app.patch("/api/signals/{signal_id}")
    def change_signal(signal_id: str, changes: Changes) -> SignalSummary:
        return signals.change(signal_id, changes)

    @app.post("/api/signals/{signal_id}/versions", status_code=201)
    def add_version(signal_id: str, new: NewVersion) -> SignalSummary:
        return signals.add_version(signal_id, new)

    @app.delete("/api/signals/{signal_id}", status_code=204)
    def delete_signal(signal_id: str) -> None:
        signals.delete(signal_id)

    # -- touches and their strategies ------------------------------------------

    @app.post("/api/signals/{signal_id}/touches", status_code=201)
    def add_touch(signal_id: str, new: NewTouch) -> TouchSummary:
        return signals.add_touch(signal_id, new)

    @app.get("/api/touches/{touch_id}")
    def get_touch(touch_id: str) -> TouchSummary:
        return signals.touch(touch_id)

    @app.delete("/api/touches/{touch_id}", status_code=204)
    def delete_touch(touch_id: str) -> None:
        signals.delete_touch(touch_id)

    @app.get("/api/touches/{touch_id}/strategies")
    def get_strategies(touch_id: str) -> list[Strategy]:
        return signals.strategies(touch_id)

    @app.put("/api/touches/{touch_id}/strategies")
    def save_strategies(touch_id: str, texts: list[StrategyText]) -> list[Strategy]:
        return signals.save_strategies(touch_id, texts)

    # -- the study of a signal or a touch --------------------------------------

    def studied(kind: Kind, plural: str) -> None:
        @app.get(f"/api/{plural}/{{subject_id}}/study")
        def get_subject_study(subject_id: str) -> Study | None:
            return signals.study(kind, subject_id)

        @app.put(f"/api/{plural}/{{subject_id}}/study")
        def save_subject_study(subject_id: str, content: StudyContent) -> Study:
            return signals.save_study(kind, subject_id, content)

        @app.get(f"/api/{plural}/{{subject_id}}/screenshot")
        def subject_screenshot(subject_id: str) -> FileResponse:
            return FileResponse(signals.screenshot(kind, subject_id), media_type="image/png")

    studied("signal", "signals")
    studied("touch", "touches")

    # -- screens: scripts that look for signals -------------------------------

    def screen_info(screen: scripts.Screen) -> ScreenInfo:
        return ScreenInfo(name=screen.name, title=screen.title, params=screen.params, shipped=screen.shipped, source="" if screen.shipped else str(screen.source))

    @app.get("/api/screens")
    def list_screens() -> list[ScreenInfo]:
        return [screen_info(screen) for screen in scripts.discover(workspace).values()]

    @app.post("/api/screens/{name}/run")
    def run_screen(name: str, request: ScreenRequest) -> ScreenOutcome:
        screen = scripts.get(workspace, name)
        try:
            found = runner.run(screen, bars.dataset, request.symbol, request.params)
        except FileNotFoundError as error:
            raise HTTPException(404, f"no bars for {request.symbol}") from error
        outcome = runner.publish(found, signals, screen, request.symbol)
        return ScreenOutcome(found=outcome.found, created=outcome.created, known=outcome.known)

    @app.post("/api/screens/{name}/check")
    def check_screen(name: str, request: ScreenRequest) -> ScreenReport:
        screen = scripts.get(workspace, name)
        try:
            report = runner.check(screen, bars.dataset, request.symbol, request.params)
        except FileNotFoundError as error:
            raise HTTPException(404, f"no bars for {request.symbol}") from error
        return ScreenReport(
            screen=report.screen, symbol=report.symbol, found=report.found, cutoffs=report.cutoffs, passed=report.passed,
            differences=[ScreenDifference(cutoff=item.cutoff, kind=item.kind, key=item.key, detail=item.detail) for item in report.differences],
        )

    # -- AI ----------------------------------------------------------------------

    @app.get("/api/ai/settings")
    def ai_settings() -> chatting.Settings:
        return chat.settings

    @app.put("/api/ai/settings")
    def save_ai_settings(settings: chatting.Settings) -> chatting.Settings:
        return chatting.write_settings(workspace, settings)

    @app.get("/api/ai/status")
    async def ai_status() -> list[chatting.Availability]:
        return await chat.status()

    @app.post("/api/chat")
    async def chat_answer(request: chatting.Request) -> StreamingResponse:
        async def events():
            try:
                async for event in chat.answer(request):
                    yield event
            except chatting.ChatError as error:
                yield chatting._event("error", message=str(error))
                yield chatting._event("done", session=None)
            except Exception as error:  # noqa: BLE001 - the page shows what went wrong
                yield chatting._event("error", message=f"{type(error).__name__}: {error}")
                yield chatting._event("done", session=None)

        return StreamingResponse(events(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    # -- the interface ---------------------------------------------------------

    if frontend is not None and frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    elif frontend is not None:

        @app.get("/", response_class=HTMLResponse)
        def not_built() -> str:
            return NOT_BUILT

    return app


__all__ = ["create_app"]
