# 筛选脚本

筛选脚本自动在行情里找信号。找到的东西先作为**候选**信号出现在主窗口（虚线），由您确认或否定；脚本不会改动已有的信号。

## 放在哪里

- 您自己的脚本：`<工作区>/screens/*.py`（不进版本库）。
- 软件自带的例子：`src/candle_viewer/screens/`。同名时您自己的优先。

## 怎么写

```python
from candle_viewer.screen import Found, Market, atr, rolling_max_before

NAME = "my_screen"                      # 名称；找到的信号的 origin 就是它
TITLE = "一句话说明"
PARAMS = {"timeframe": "d1", "window": 20}   # 可改的参数和默认值

def run(market: Market, symbol: str, params: dict) -> list[Found]:
    bars = market.bars(symbol, params["timeframe"])   # numpy 数组：timestamp, open, high, low, close
    ...
    return [Found(key="peak-" + str(ts), shape="point", timeframe="d1",
                  anchors=((ts, price),), known_at=ends[i], models=("某模型",), note="说明")]
```

- `market.bars(symbol, tf)` 给出某周期的全部 K 线，最早的在前。`market.bar_start(ts, tf)` 算某时刻所在的粗周期 K 线，`market.ended(ts, tf)` 算一根 K 线什么时候走完（周五收盘之后的时段算到周五收盘）。
- `Found.key` 在同一品种、同一脚本内唯一。再次运行时已有的不会重复加入，被否定的也不会复活。
- `Found.known_at` 是这个信号**最早能被认出来的时刻**。需要后面的 K 线才能成立的形态，填最后那根 K 线走完的时刻（`market.ended`）。
- `note` 会成为信号第 1 版的说明，显示在主窗口的列表、悬停提示里。

## 偷看未来

“检查”会把数据截断到若干时刻重跑脚本，和完整数据的结果比对：

- 完整数据里声称在 T 之前可知的信号，截断到 T 时必须也能找到，锚点一样；找不到就是偷看了未来（`early`），不通过。
- 截断时找到、完整数据里却要更晚才可知的（`late`）只是 `known_at` 填得保守，会列出但不算失败。

截断点有两类：在数据区间里等距取几个，加上一部分信号的 `known_at` 前一刻和当刻——前一刻应当找不到，当刻应当找到。脚本拿到的 `market` 本身也只给出截断前走完的 K 线，所以脚本不可能真的读到未来；检查的是 `known_at` 填得对不对。

## 命令

```bash
uv run candle-screen list
uv run candle-screen run my_screen --symbols eurusd gbpusd            # 写入候选信号
uv run candle-screen run my_screen --symbols eurusd --dry-run         # 只打印
uv run candle-screen run my_screen --symbols eurusd --param window=30
uv run candle-screen check my_screen --symbols eurusd                 # 偷看未来检查
```

主窗口工具栏的“筛选”菜单做同样的事，针对当前品种。
