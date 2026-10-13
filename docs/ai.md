# AI

AI 是可选的：没有它软件照常可用。主窗口的“AI 对话”按钮打开对话窗口，窗口带着您正在看的品种、周期和选中的信号。

## 三个助手

| 助手 | 怎么接入 | 能做什么 |
|---|---|---|
| 本地模型 | OpenAI 兼容接口（默认 `http://127.0.0.1:8000/v1`），需要服务支持工具调用 | 与下面两个相同的工具 |
| Claude Code | 本机已登录的 `claude` 命令（您的 Max 账号） | 通过接口读行情、运行 Python 分析全部数据、标记候选信号、添加触及、写筛选脚本、做偷看未来检查 |
| Codex | 本机已登录的 `codex` 命令（您的 Codex Pro 账号） | 同上 |

三个助手拿到的是同一套工具。`run_python` 在软件的环境里运行一段 Python，能读到全部行情（`Market(DATASET).bars(品种, 周期)`），所以可以直接让它们找满足某种特征的 K 线；找到的东西让它们用 `create_signal` 标成候选信号，就会出现在主窗口里。

三者在对话窗口的“设置”里可以开关、改地址或命令。设置存在工作区的 `ai.json` 里，不进版本库。

Claude Code 和 Codex 在后台以非交互方式运行，工作目录是工作区；它们对本软件接口的调用不再逐个询问。它们写的脚本放在工作区的 `screens/` 里，运行后找到的信号都是**候选**，要您确认。

## 接口（MCP）

`candle-viewer-mcp --workspace <工作区>` 是一个 MCP 服务，对话窗口会自动把它交给 Claude Code 和 Codex。您在终端里直接用 Claude Code 时也可以接上它：

```bash
claude mcp add candle-viewer -- ~/dev/proj2-candle_viewer/.venv/bin/candle-viewer-mcp --workspace ~/candle_workspace
```

工具：`list_symbols`、`get_bars`（每次最多 5000 根）、`run_python`（全部数据，最长 300 秒）、`list_signals`、`get_signal`、`create_signal`、`change_signal`、`add_touch`、`read_study`、`list_screens`、`read_screen`、`save_screen`、`run_screen`、`check_screen`。资源 `guide://screens` 是 [docs/screens.md](screens.md)。
