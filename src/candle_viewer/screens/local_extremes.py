"""Local highs and lows: a bar whose close is above the closes of the bars around it, or below them."""

import numpy as np

from candle_viewer.screen import Found, Market, rolling_max_before, rolling_min_before

NAME = "local_extremes"
TITLE = "局部高低点：收盘价高于前后各 N 根的收盘价，或低于它们"
PARAMS = {"timeframe": "d1", "window": 15}


def run(market: Market, symbol: str, params: dict) -> list[Found]:
    bars = market.bars(symbol, params["timeframe"])
    window = int(params["window"])
    n = len(bars)
    found: list[Found] = []
    if n < 2 * window + 1:
        return found
    before_high = rolling_max_before(bars.close, window)
    before_low = rolling_min_before(bars.close, window)
    # The closes of the bars after each one, by looking at the reversed series.
    after_high = rolling_max_before(bars.close[::-1], window)[::-1]
    after_low = rolling_min_before(bars.close[::-1], window)[::-1]
    ends = market.ended(bars.timestamp, params["timeframe"])
    for i in np.flatnonzero((bars.close >= before_high) & (bars.close >= after_high)):
        i = int(i)
        found.append(Found(
            key=f"peak-{bars.timestamp[i]}",
            shape="point",
            timeframe=params["timeframe"],
            anchors=((int(bars.timestamp[i]), float(bars.high[i])),),
            known_at=int(ends[min(n - 1, i + window)]),
            models=("局部高点",),
            note=f"收盘价高于前后各 {window} 根的收盘价",
        ))
    for i in np.flatnonzero((bars.close <= before_low) & (bars.close <= after_low)):
        i = int(i)
        found.append(Found(
            key=f"valley-{bars.timestamp[i]}",
            shape="point",
            timeframe=params["timeframe"],
            anchors=((int(bars.timestamp[i]), float(bars.low[i])),),
            known_at=int(ends[min(n - 1, i + window)]),
            models=("局部低点",),
            note=f"收盘价低于前后各 {window} 根的收盘价",
        ))
    found.sort(key=lambda item: item.anchors[0][0])
    return found
