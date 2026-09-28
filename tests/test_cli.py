import json

import pandas as pd

from candle_viewer.market import cli, rawdata, store

from .conftest import ms, random_walk, trading_weeks


def write_raw(folder, symbol="testfx", volumes=True):
    folder.mkdir(parents=True, exist_ok=True)
    random_walk(trading_weeks("2024-01-07", 3), volumes=volumes).to_csv(folder / f"{symbol}-m1-bid_full.csv", index=False)
    daily = pd.DataFrame({"timestamp": [ms("2024-01-04"), ms("2024-01-05")], "open": [1.1, 1.105], "high": [1.11, 1.12], "low": [1.09, 1.1], "close": [1.105, 1.11]})
    if volumes:
        daily["volume"] = [1000.0, 1200.0]
    daily.to_csv(folder / f"{symbol}-d1-bid_full.csv", index=False)


def test_discover_and_read(tmp_path):
    write_raw(tmp_path)
    (tmp_path / "notes.csv").write_text("a,b\n1,2\n")
    found = rawdata.discover(tmp_path)
    assert list(found) == ["testfx"] and sorted(found["testfx"]) == ["d1", "m1"]
    frame = rawdata.read_bars(found["testfx"]["m1"].path)
    assert frame.columns.tolist() == ["timestamp", "open", "high", "low", "close", "volume"]


def test_rebuild_then_check(tmp_path, capsys):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source)
    assert cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)]) == 0
    dataset = store.dataset_dir(workspace, "utc")
    assert store.symbols(dataset) == ["testfx"]
    assert {p.stem for p in (dataset / "testfx").glob("*.parquet")} == {"m1", "m15", "h1", "h4", "d1", "w1", "1mo", "3mo"}
    for name in ("m1", "h4", "3mo"):
        exported = pd.read_csv(store.csv_path(dataset, "testfx", name))
        assert exported.columns.tolist() == ["timestamp", "open", "high", "low", "close", "volume"]
        assert len(exported) == len(pd.read_parquet(store.bars_path(dataset, "testfx", name)))
    manifest = json.loads((dataset / "manifest.json").read_text())
    assert manifest["convention"] == "utc" and manifest["symbols"]["testfx"]["daily_origin"]["original_before_minutes"] == 2
    assert (workspace / "reports" / "data_quality_utc.md").read_text().startswith("# 行情数据重构报告")
    assert cli.main(["check", "--workspace", str(workspace)]) == 0
    assert "checks passed" in capsys.readouterr().out


def test_check_notices_a_tampered_bar(tmp_path):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source)
    cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)])
    target = store.bars_path(store.dataset_dir(workspace, "utc"), "testfx", "h1")
    frame = pd.read_parquet(target)
    frame.loc[10, "high"] += 0.01
    frame.to_parquet(target, index=False)
    assert cli.main(["check", "--workspace", str(workspace)]) == 1


def test_files_without_volume_keep_the_five_column_layout(tmp_path):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source, volumes=False)
    assert cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)]) == 0
    exported = pd.read_csv(store.csv_path(store.dataset_dir(workspace, "utc"), "testfx", "d1"))
    assert exported.columns.tolist() == ["timestamp", "open", "high", "low", "close"]
    assert cli.main(["check", "--workspace", str(workspace)]) == 0


def test_unknown_symbol_is_reported(tmp_path, capsys):
    write_raw(tmp_path)
    assert cli.main(["rebuild", "--source", str(tmp_path), "--workspace", str(tmp_path / "w"), "--symbols", "nothere"]) == 2
    assert "nothere" in capsys.readouterr().err


def test_patches_next_to_the_source_are_applied(tmp_path):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source)
    main = source / "testfx-m1-bid_full.csv"
    full = pd.read_csv(main)
    hole = (full["timestamp"] >= ms("2024-01-10 03:00")) & (full["timestamp"] < ms("2024-01-10 09:00"))
    full[~hole].to_csv(main, index=False)
    (source / "patches").mkdir()
    full[hole].to_csv(source / "patches" / "testfx-m1-bid_full.csv", index=False)
    assert cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)]) == 0
    dataset = store.dataset_dir(workspace, "utc")
    assert json.loads((dataset / "manifest.json").read_text())["symbols"]["testfx"]["minutes_from_patch"] == 360
    assert len(pd.read_parquet(store.bars_path(dataset, "testfx", "m1"))) == len(full)
    assert cli.main(["check", "--workspace", str(workspace)]) == 0


def test_hourly_candles_with_volume_fill_a_hole(tmp_path):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source)
    main = source / "testfx-m1-bid_full.csv"
    full = pd.read_csv(main)
    hole = (full["timestamp"] >= ms("2024-01-10 02:00")) & (full["timestamp"] < ms("2024-01-10 07:00"))
    full[~hole].to_csv(main, index=False)
    hours = random_walk(ms("2024-01-10 00:00") + pd.RangeIndex(12).to_numpy() * 3_600_000, start_price=3.0, volumes=True)
    hours.to_csv(source / "testfx-h1-bid_full.csv", index=False)
    assert cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)]) == 0
    dataset = store.dataset_dir(workspace, "utc")
    hourly = pd.read_parquet(store.bars_path(dataset, "testfx", "h1")).set_index("timestamp")
    assert hourly.loc[ms("2024-01-10 03:00"), "low"] > 2
    assert json.loads((dataset / "manifest.json").read_text())["symbols"]["testfx"]["daily_origin"]["from_hourly"] == 1
    assert cli.main(["check", "--workspace", str(workspace)]) == 0


def test_hourly_candles_without_volume_are_not_used(tmp_path):
    source, workspace = tmp_path / "raw", tmp_path / "workspace"
    write_raw(source, volumes=False)
    main = source / "testfx-m1-bid_full.csv"
    full = pd.read_csv(main)
    hole = (full["timestamp"] >= ms("2024-01-10 02:00")) & (full["timestamp"] < ms("2024-01-10 07:00"))
    full[~hole].to_csv(main, index=False)
    hours = random_walk(ms("2024-01-10 00:00") + pd.RangeIndex(12).to_numpy() * 3_600_000, start_price=3.0)
    hours.to_csv(source / "testfx-h1-bid_full.csv", index=False)
    assert cli.main(["rebuild", "--source", str(source), "--workspace", str(workspace)]) == 0
    hourly = pd.read_parquet(store.bars_path(store.dataset_dir(workspace, "utc"), "testfx", "h1"))
    assert ms("2024-01-10 03:00") not in set(hourly["timestamp"]) and (hourly["high"] < 2).all()
