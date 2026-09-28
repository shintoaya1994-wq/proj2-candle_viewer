# proj2-candle_viewer

A local trading research workbench: multi-timeframe candle charts, annotation of signals and their touches, saved research records, and AI-assisted screening. Research only; the software never trades.

The user communicates in Chinese. Reply in Chinese. Code, comments and commit messages are in English; user-facing text (UI, reports) is in Chinese.

## Working agreement

Commit every completed change and push it to GitHub (`origin`, `main`) without asking, unless the user says to hold back. One topic per commit, message in English. Run the tests before committing.

## Privacy

The repository is public. Market data, research records, screenshots and private screening scripts live in a workspace outside the repository (default `~/candle_workspace`). Never commit them, and never put real data into tests or docs. Tests use synthetic data only.

## Environment

- Develop and run on Linux, with the working copy on a local disk.
- Never keep the working copy, `.venv`, `node_modules` or a database on a network share: files on an SMB mount cannot be executed and SQLite cannot open databases there. Raw downloads may be read from a share, and plain files may be written to one.
- Notes that apply to one machine only belong in `CLAUDE.local.md`, which is not part of the repository. Read it if it exists.

## Commands

```bash
uv sync                      # install dependencies
uv run pytest                # tests
node tools/dukascopy/fetch.mjs --symbols eurusd --to 2026-09-26    # download m1 and d1, resumable
uv run candle-data rebuild --source ~/candle_workspace/raw/dukascopy   # rebuild all timeframes
uv run candle-data check                                               # verify a rebuilt dataset
uv run candle-viewer                                                   # serve the application on http://127.0.0.1:8765
node tools/dukascopy/repair.mjs --symbols eurusd                       # fill holes from ticks, then rebuild again
```

## Layout

- `src/candle_viewer/app/` – the local web application (FastAPI)
  - `bars.py` windows of bars read from the Parquet files by row group
  - `studies.py` research records as plain files below `<workspace>/studies`
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
- `tools/dukascopy/` – Node.js tools built on dukascopy-node: `fetch.mjs` downloads, `repair.mjs` fills holes from ticks, `client.mjs` paces and caches requests
- `tests/` – pytest, synthetic data
- `docs/data-conventions.md` – data rules, in Chinese

## Concepts the user insists on

Signal (and its updates), touch of a signal, and the strategy after a touch are three separate things. Do not merge them into one object. Every signal has a time at which it became knowable, distinct from the time of its anchor on the chart.

## Data rules in brief

Data comes from Dukascopy through dukascopy-node: 1-minute, hourly and daily bid candles with volumes. Dukascopy's own server answers 429 after about a thousand requests and then stays shut for hours, but the CDN in front of it answers without limit for every file somebody fetched during the last week. It keeps a separate copy per accepted encoding, and the uncompressed copies are nearly complete, so the downloader asks with `Accept-Encoding: identity` first. Do not probe the server by hand with compressed requests; each miss counts against the allowance.

1-minute bars with trades are the base. Pauses shorter than 60 minutes are closed with flat bars at the previous close; longer ones stay empty. Hours the minutes lack are copied from the hourly download; days the hours lack are copied from the daily download. Four-hour and daily bars are aggregated from hourly bars, weekly and coarser bars from daily bars. Weekend data belongs to the following Monday. Each bar records its origin in `bar_flags` and the number of minutes behind it in `n_m1`. Timestamps are UTC milliseconds of the nominal start of the period.
