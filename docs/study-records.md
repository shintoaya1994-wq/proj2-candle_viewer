# 记录的文件格式

信号、触及、策略和研究记录都是工作区里的普通文件，不依赖本软件也能阅读。

```
<工作区>/
  signals/
    eurusd/                          品种
      s202401100000-5d5a/            一个信号：s + 最早锚点的 UTC 时间 + 4 位随机字符
        signal.json                  信号本身：形状的各个版本、模型、状态
        study.json                   信号的研究：窗格、标注、快评
        notes.md                     评论
        screenshot.png               保存时各窗格的截图
        history/
          20260929T031502-1c9e/      每次再保存之前，上一版的研究文件
        touches/
          t202402201400-0a1b/        一次触及：t + 触及的 UTC 时间 + 4 位随机字符
            touch.json               触及本身：时间、价格、对应信号的第几版
            strategies.json          触及后的策略，可以有几条
            study.json、notes.md、screenshot.png、history/     触及的研究
          .trash/                    被删除的触及
    .trash/                          被删除的信号
  studies/
    20260928-205129-fa65/            不针对某个信号的自由研究：保存时的 UTC 日期、时间 + 4 位随机字符
      study.json、notes.md、screenshot.png、history/
    .trash/                          被删除的自由研究
```

删除只是把文件夹移到 `.trash`，不会销毁任何东西。`notes.md` 可以用任何编辑器修改，软件下次打开时读到的就是修改后的内容。

信号、触及、策略是三种分开的记录：信号是行情给出的东西，触及是价格某一次来到信号，策略是在那次触及上打算怎么做。

## signal.json

| 字段 | 含义 |
|---|---|
| `id`、`symbol`、`created`、`updated` | 编号、品种、创建时间、最后修改时间（UTC） |
| `versions` | 形状的各个版本，见下。最后一个是当前的形状 |
| `models` | 用到的模型的名称，可以为空 |
| `basis` | 能不能用模型说清楚：`model` 能、`partial` 部分能、`feeling` 感觉如此、`unset` 未填 |
| `status` | `confirmed` 已确认、`candidate` 候选、`rejected` 已否定 |
| `origin` | 来源：`manual` 手工标记，以后还有筛选脚本的名称 |
| `relations` | 与其他信号的关系：`continues` 延续、`replaces` 取代、`related` 相关 |

每个版本：

| 字段 | 含义 |
|---|---|
| `version` | 第几版，从 1 开始 |
| `shape` | 形状：`point` 点、`level` 向右延伸的水平位、`segment` 线段、`box` 方框 |
| `anchors` | 锚点，每个有时间 `timestamp`（UTC 毫秒）和价格 `value`。点和水平位 1 个，线段和方框 2 个 |
| `timeframe` | 定下这些锚点时所在的周期 |
| `knownAt` | 信号最早在什么时候能被认出来，UTC 毫秒；没有填则为空。它通常晚于锚点的时间 |
| `reason` | 这一版的由来：`initial` 最初标记、`market` 行情变化、`review` 复盘修正 |
| `note`、`created` | 说明、记录时间 |

修改信号的形状不会改动已有的版本，而是追加一个新版本。

## touch.json

| 字段 | 含义 |
|---|---|
| `id`、`signalId`、`symbol` | 编号、所属信号、品种 |
| `signalVersion` | 触及的是信号的第几版。信号后来有了新版本，这个数字不变 |
| `timestamp`、`value` | 触及的时间（UTC 毫秒）和价格 |
| `timeframe` | 标下这次触及时所在的周期 |
| `rule` | 判定触及的规则，手工标记时为空 |
| `origin`、`created`、`updated` | 来源、创建时间、最后修改时间 |

## strategies.json

一个列表，每一项是一条策略：编号 `id`、名称 `label`、内容 `text`、创建时间 `created`、最后修改时间 `updated`。同一次触及可以并排记几条，例如“当时的做法”“现在的想法”。

## study.json

信号的研究、触及的研究、自由研究用同一种格式。

| 字段 | 含义 |
|---|---|
| `id`、`created`、`updated` | 编号、创建时间、最后保存时间（UTC） |
| `subject` | 研究的对象：种类 `kind`（`signal` 或 `touch`）和编号 `id`；自由研究为空 |
| `symbol` | 品种 |
| `focus` | 这条记录关注的时刻，UTC 毫秒 |
| `tag` | 快评 |
| `timezone` | 图上显示时间所用的时区 |
| `layout` | 窗格的排列：列数 `columns`、行数 `rows` |
| `panes` | 各个窗格，见下 |
| `drawings` | 标注，见下 |
| `schemaVersion` | 格式版本，目前是 2 |

每个窗格：

| 字段 | 含义 |
|---|---|
| `symbol`、`timeframe` | 这个窗格的品种和周期 |
| `indicators` | 指标：名称 `name`、所在位置 `pane`（`candle` 表示画在 K 线上）、参数 `params` |
| `view` | 画面位置：每根 K 线的宽度 `barSpace`、画面右端那根 K 线的时间 `rightTimestamp`、它到右边缘的距离 `offsetRight` |

第 1 版格式只有一个窗格，它的 `timeframe`、`indicators`、`view` 直接写在记录上。这样的记录打开时当作一个窗格的研究，文件保持原样；再次保存时才写成第 2 版，原文件留在 `history` 里。

触及的研究窗口里还会显示信号研究的标注（虚线，不能在那里修改）。它们只存在信号的 `study.json` 里，不会复制到触及的记录中；信号的研究改了，每次触及看到的也随之改变。触及的研究第一次打开时，窗格和指标沿用信号研究的设置，之后各自保存。

## 标注

| 字段 | 含义 |
|---|---|
| `id` | 标注的编号 |
| `name` | 种类：`segment` 线段、`levelSegment` 水平线段、`levelRay` 水平射线、`rayLine` 射线、`straightLine` 直线、`horizontalStraightLine` 水平线、`verticalStraightLine` 垂直线、`box` 方框、`note` 文字 |
| `points` | 锚点。每个锚点有时间 `timestamp`（UTC 毫秒）和价格 `value`；水平线只有价格，垂直线只有时间 |
| `symbol` | 所属的品种。标注显示在这个品种的所有窗格上 |
| `timeframe` | 画下或最后一次改动这个标注时所在的周期 |
| `extendData` | 颜色 `color`、文字 `text` |
| `styles` | 线条样式 |

## 锚点在不同周期上的位置

锚点用时间和价格记录，不用屏幕位置。所以换周期、换窗口大小之后，标注和信号仍然落在同一时刻、同一价格上。记录里保存的始终是原来的时刻，换周期不会改动它。

- 在较细的周期上定下的锚点，到了较粗的周期落在“包含那个时刻的那根 K 线”上。例如 1 小时图上 13:00 的锚点，在日线图上落在当天那根 K 线。
- 在较粗的周期上定下的锚点，如果价格正好是那根 K 线的最高价或最低价，到了较细的周期落在“走出这个价位的那根 K 线”上。例如标在日线高点上的信号，在 1 小时图上落在当天创出高点的那个小时，而不是当天的第一个小时。
- 价格不是最高价也不是最低价时，落在那段时间的第一根 K 线上。
