# proj2-candle_viewer

本地运行的交易研究工作台：多周期 K 线查看、信号与触及的标注、研究记录的保存，并可接入 AI 辅助筛选。它只用于研究，不做自动交易。

## 目前能做什么

- 查看 8 个周期的 K 线（1 分钟到季线），周期之间随时切换，切换后停在同一时刻
- 画线段、射线、直线、水平线、垂直线、方框、文字；标注按时间和价格定位，换周期后仍在原处
- 常用指标，参数可改
- 每条研究记录有快评和评论，保存时连同标注、指标、画面位置、截图一起存下
- 重新打开记录，画面回到保存时的样子；每次保存都留有上一版

信号筛选、六宫格研究窗口、AI 对话属于后续阶段。

## 环境

- Linux，Python 3.12 以上，使用 [uv](https://docs.astral.sh/uv/) 管理依赖
- Node.js 20 以上，用于构建界面和下载行情
- 代码目录放在本地磁盘上，不要放在网络共享盘上

```bash
uv sync
cd frontend && npm install && npm run build && cd ..
```

## 启动

```bash
uv run candle-viewer
```

然后在浏览器打开 <http://127.0.0.1:8765>。默认只有本机能访问；加上 `--host 0.0.0.0` 后局域网内的其他电脑也能打开。

| 操作 | 方法 |
|---|---|
| 画标注 | 点工具栏上的工具，再在图上点击；按 Esc 取消 |
| 移动或改形状 | 拖动标注或它的端点 |
| 改颜色 | 先点选标注，再点颜色 |
| 改方框或文字上的字 | 双击 |
| 删除标注 | 点选后按 Delete，或在标注上点右键 |
| 保存 | 点“保存”或按 Ctrl+S |

## 行情数据

数据来自 Dukascopy。先下载 1 分钟线、1 小时线和日线，再由 1 分钟线逐级重构其余周期。

```bash
# 下载。可随时中断，重新运行会从断点继续
cd tools/dukascopy && npm install
node fetch.mjs --symbols eurusd,gbpusd --to 2026-09-26

# 由 1 分钟线重构全部周期，结果写入私有工作区
uv run candle-data rebuild --source ~/candle_workspace/raw/dukascopy

# 校验重构结果：逐级重新聚合并逐根比对
uv run candle-data check

# 可选：服务器的分钟线有缺失时，用逐笔数据补上，然后再重构一次
node tools/dukascopy/repair.mjs --symbols eurusd
```

处理规则见 [docs/data-conventions.md](docs/data-conventions.md)。

## 数据与隐私

行情数据、研究记录、截图都保存在仓库之外的私有工作区，默认是 `~/candle_workspace`，可用 `--workspace` 指定其他位置。它们不会进入版本库。研究记录的文件格式见 [docs/study-records.md](docs/study-records.md)。

## 测试

```bash
uv run pytest                                  # 后端和数据处理
cd frontend && npm test                        # 界面中与浏览器无关的逻辑
cd frontend && npm run build && npm run e2e    # 在真实浏览器里走一遍：画、存、关、重开
```

最后一项需要本机装有 Chrome，路径可用环境变量 `CHROME` 指定。
