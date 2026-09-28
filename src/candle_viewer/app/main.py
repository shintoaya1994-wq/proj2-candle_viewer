"""The local web application: bars and studies over HTTP, plus the built frontend."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from ..market import store
from .bars import COLUMNS, MAX_COUNT, BarStore, UnknownSeries
from .studies import InvalidStudy, Study, StudyContent, StudyNotFound, StudyStore, Summary

FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "dist"
NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>K 线研究工作台</title>
<body style="font-family: system-ui, sans-serif; padding: 48px; line-height: 1.7">
<h1>界面还没有构建</h1>
<p>请在代码目录里运行下面两条命令，然后刷新本页。</p>
<pre>cd frontend
npm install &amp;&amp; npm run build</pre>
<p>行情和记录的接口已经在运行，见 <a href="/api/docs">/api/docs</a>。</p>
"""


def create_app(workspace: Path, convention: str = "utc", frontend: Path | None = FRONTEND) -> FastAPI:
    workspace = Path(workspace).expanduser()
    bars = BarStore(store.dataset_dir(workspace, convention))
    studies = StudyStore(workspace / "studies")
    app = FastAPI(title="Candle Viewer", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    @app.get("/api/meta")
    def meta() -> dict:
        return bars.meta()

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

    @app.get("/api/studies")
    def list_studies() -> list[Summary]:
        return studies.list()

    @app.post("/api/studies", status_code=201)
    def create_study(content: StudyContent) -> Study:
        try:
            return studies.create(content)
        except InvalidStudy as error:
            raise HTTPException(422, str(error)) from error

    @app.get("/api/studies/{study_id}")
    def get_study(study_id: str) -> Study:
        try:
            return studies.get(study_id)
        except StudyNotFound as error:
            raise HTTPException(404, f"no study {study_id}") from error

    @app.put("/api/studies/{study_id}")
    def update_study(study_id: str, content: StudyContent) -> Study:
        try:
            return studies.update(study_id, content)
        except StudyNotFound as error:
            raise HTTPException(404, f"no study {study_id}") from error
        except InvalidStudy as error:
            raise HTTPException(422, str(error)) from error

    @app.delete("/api/studies/{study_id}", status_code=204)
    def delete_study(study_id: str) -> None:
        try:
            studies.delete(study_id)
        except StudyNotFound as error:
            raise HTTPException(404, f"no study {study_id}") from error

    @app.get("/api/studies/{study_id}/screenshot")
    def screenshot(study_id: str) -> FileResponse:
        try:
            return FileResponse(studies.screenshot(study_id), media_type="image/png")
        except StudyNotFound as error:
            raise HTTPException(404, str(error)) from error

    if frontend is not None and frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    elif frontend is not None:

        @app.get("/", response_class=HTMLResponse)
        def not_built() -> str:
            return NOT_BUILT

    return app


__all__ = ["create_app"]
