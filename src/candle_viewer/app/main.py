"""The local web application: bars and studies over HTTP, plus the built frontend."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..market import store
from .bars import COLUMNS, MAX_COUNT, BarStore, UnknownSeries
from .studies import InvalidStudy, Study, StudyContent, StudyNotFound, StudyStore, Summary

FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "dist"


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
        count: int = Query(1000, ge=1, le=MAX_COUNT),
    ) -> dict:
        try:
            found = bars.window(symbol, timeframe, before=before, after=after, around=around, count=count)
        except UnknownSeries as error:
            raise HTTPException(404, f"no bars for {error}") from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        frame = found.bars
        # JSON has no NaN; an unknown volume travels as null.
        rows = frame.astype(object).where(frame.notna(), None).to_numpy().tolist() if len(frame) else []
        return {"columns": list(COLUMNS), "bars": rows, "more": {"backward": found.older, "forward": found.newer}}

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
    return app


__all__ = ["create_app"]
