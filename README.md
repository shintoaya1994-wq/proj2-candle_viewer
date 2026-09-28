# proj2-candle_viewer

本地运行的交易研究工作台：多周期 K 线查看、信号与触及的标注、研究记录的保存，并可接入 AI 辅助筛选。它只用于研究，不做自动交易。

项目处于早期阶段。目前已完成的是行情数据的整理工具。

## 环境

- Linux，Python 3.12 以上，使用 [uv](https://docs.astral.sh/uv/) 管理依赖
- 代码目录放在本地磁盘上，不要放在网络共享盘上

```bash
uv sync
uv run pytest
```

## 行情数据

数据来自 Dukascopy。先下载 1 分钟线、1 小时线和日线，再由 1 分钟线逐级重构其余周期。

```bash
# 下载（需要 Node.js）。可随时中断，重新运行会从断点继续
cd tools/dukascopy && npm install
node fetch.mjs --symbols eurusd,gbpusd --to 2026-09-26

# 由 1 分钟线重构全部周期，结果写入私有工作区
uv run candle-data rebuild --source ~/candle_workspace/raw/dukascopy

# 校验重构结果：逐级重新聚合并逐根比对
uv run candle-data check

# 可选：服务器的分钟线有缺失时，用逐笔数据补上，然后再重构一次
node tools/dukascopy/repair.mjs --symbols eurusd
```

结果默认写入 `~/candle_workspace`，可用 `--workspace` 指定其他位置。处理规则见 [docs/data-conventions.md](docs/data-conventions.md)。

## 数据与隐私

行情数据、研究记录、截图都保存在仓库之外的私有工作区，不会进入版本库。
