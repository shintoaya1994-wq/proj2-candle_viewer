# proj2-candle_viewer

A local trading research workbench: multi-timeframe candle charts, annotation of signals and their touches, saved research records, and AI-assisted screening. Research only; the software never trades.

The user communicates in Chinese. Reply in Chinese. Code, comments and commit messages are in English; user-facing text (UI, reports) is in Chinese.

## Working agreement

Commit every completed change and push it to GitHub (`origin`, `main`) without asking, unless the user says to hold back. One topic per commit, message in English. Run the tests before committing.

The user runs the application from the main working copy, often while development goes on. Work that leaves the application unusable between its commits is done in a git worktree on a branch of its own, pushed as well, and merged into `main` when its tests pass. After a merge the interface has to be built in the main working copy and the user has to start the application again.

## Privacy

The repository is public. Market data, research records, screenshots and private screening scripts live in a workspace outside the repository (default `~/candle_workspace`). Never commit them, and never put real data into tests or docs. Tests use synthetic data only.

## Environment

- Develop and run on Linux, with the working copy on a local disk.
- Never keep the working copy, `.venv`, `node_modules` or a database on a network share: files on an SMB mount cannot be executed and SQLite cannot open databases there. Raw downloads may be read from a share, and plain files may be written to one.
- Notes that apply to one machine only belong in `CLAUDE.local.md`, which is not part of the repository. Read it if it exists.

## Commands

```bash
uv sync                                        # install Python dependencies
uv run pytest                                  # backend and data pipeline tests
uv run candle-viewer                           # serve the application on http://127.0.0.1:8765
uv run candle-data rebuild --source ~/candle_workspace/raw/dukascopy   # rebuild all timeframes
uv run candle-data check                       # verify a rebuilt dataset

cd frontend
npm install
npm run dev                                    # Vite on port 5173, passes /api on to port 8765
npm run build                                  # type check and build into frontend/dist, which the backend serves
npm test                                       # vitest: logic that needs no browser
npm run e2e                                    # headless Chrome against the real application, needs a build

node tools/dukascopy/fetch.mjs --symbols eurusd --to 2026-09-26      # download d1, h1 and m1, resumable
node tools/dukascopy/repair.mjs --symbols eurusd                     # fill holes from ticks, then rebuild again
```

## Layout

- `src/candle_viewer/app/` – the local web application (FastAPI)
  - `bars.py` windows of bars read from the Parquet files by row group
  - `studies.py` studies as plain files: panes, drawings, tag, comment, screenshot, history
  - `signals.py` signals with their versions, touches, strategies; each signal and touch has a study in its folder
  - `main.py` HTTP API under `/api`, serves the built frontend
- `src/candle_viewer/market/` – market data pipeline
  - `timeframes.py` timeframe definitions
  - `sessions.py` session calendar: assigns instants to bars under a convention (`utc`, `nyclose`)
  - `rawdata.py` discovery and loading of raw CSV files
  - `clean.py` filler detection, small OHLC repairs
  - `rebuild.py` aggregation, splice with original daily bars, `Flag` bits
  - `gaps.py` periods without usable 1-minute data
  - `quality.py`, `report.py` comparison with the original files, Chinese report
  - `verify.py` independent check of a stored dataset
  - `store.py` dataset layout on disk
- `frontend/` – the interface (React, TypeScript, Vite, klinecharts 10.0.3)
  - `src/App.tsx` chooses the window by the address: `#/` is the main window, `#/study/<kind>/<id>` a study
  - `src/windows/MainWindow.tsx` one chart with the signals of a symbol; marks signals and touches
  - `src/windows/StudyWindow.tsx` the study of a signal, a touch, or a study on its own: several charts, one board
  - `src/chart/Pane.tsx` one chart: owns the klinecharts instance and the view, shows drawings and marks
  - `src/chart/board.ts` the drawings of a window, shared by its charts
  - `src/chart/marks.ts` signals and touches as overlays; they are records, a chart only shows them
  - `src/chart/placement.ts` where anchors go on a timeframe; free of the chart library and unit tested
  - `src/chart/drawings.ts` drawing tools, the custom overlays, conversion to and from stored state
  - `src/chart/loader.ts` feeds the chart from `/api/bars` window by window
  - `src/chart/picture.ts` one picture of all charts of a window
  - `src/route.ts`, `src/channel.ts` addresses of windows; what windows tell each other after saving
  - `src/timeframes.ts` `barStart` mirrors `SessionCalendar.bar_start` of the backend; keep the two in step
  - `e2e/run.mjs` acceptance test; `SHOTS=<folder>` keeps pictures of the windows along the way
  - `e2e/debug.mjs` opens the application on a workspace and runs a script against the page
- `tools/dukascopy/` – Node.js tools built on dukascopy-node: `fetch.mjs` downloads, `repair.mjs` fills holes from ticks, `client.mjs` paces and caches requests
- `tests/` – pytest, synthetic data
- `docs/data-conventions.md` – data rules, in Chinese

## Things to know about klinecharts 10

- Trust `node_modules/klinecharts/dist/index.d.ts` over memory of version 9.
- The data loader is asked "forward" for bars before the first one the chart holds and "backward" for bars after the last one.
- A drawing can only be placed inside the bars the chart holds; outside them the position is estimated from the calendar. The first window of bars is therefore stretched back to the earliest anchor (`since`).
- Clicks are told from drags and double clicks by timing. Automated clicks need pauses: about 60 ms down, 450 ms between clicks, two clicks within 500 ms for a double click.
- `lock: true` on an overlay switches off all its events. A figure that must not be dragged but can be clicked lists the three `onPressedMove…` events in its `ignoreEvent`.
- The library has no rectangle; `box`, `note`, `levelSegment`, `levelRay` and `spot` are registered by the application.
- `overrideOverlay` merges `extendData` into the object the overlay holds, arrays index by index. Data that has to be replaced as a whole travels as a function (see `marks.ts`).
- The price axis fits itself to the prices in view and never shrinks again, so the width of a chart depends on where it has been. The application gives the axis a width of its own.
- A crosshair set through `executeAction('onCrosshairChange', {x, paneId})` with a `paneId` that names no pane shows the vertical line only; passing nothing takes it away.
- `window.open` from a click on the chart works, because the click is still in progress. A menu that closes on `mousedown` outside must ignore the press that opened it.

## Concepts the user insists on

Signal (and its updates), touch of a signal, and the strategy after a touch are three separate things. Do not merge them into one object. Every signal has a time at which it became knowable, distinct from the time of its anchor on the chart.

A signal that changes gets a new version; the earlier shape stays, and a touch points to the version it met. About half of the signals can be explained by a named model, the rest are "it feels so"; the record says which (`basis`), and never forces a model onto a signal.

Lines and boxes are the same on every timeframe: a drawing made on one chart of a study shows on all of them.

## Data rules in brief

Data comes from Dukascopy through dukascopy-node: 1-minute, hourly and daily bid candles with volumes. Dukascopy's own server answers 429 after about a thousand requests and then stays shut for hours, but the CDN in front of it answers without limit for every file somebody fetched during the last week. It keeps a separate copy per accepted encoding, and the uncompressed copies are nearly complete, so the downloader asks with `Accept-Encoding: identity` first. Do not probe the server by hand with compressed requests; each miss counts against the allowance.

1-minute bars with trades are the base. Pauses shorter than 60 minutes are closed with flat bars at the previous close; longer ones stay empty. Hours the minutes lack are copied from the hourly download; days the hours lack are copied from the daily download. Four-hour and daily bars are aggregated from hourly bars, weekly and coarser bars from daily bars. Weekend data belongs to the following Monday. Each bar records its origin in `bar_flags` and the number of minutes behind it in `n_m1`. Timestamps are UTC milliseconds of the nominal start of the period.
