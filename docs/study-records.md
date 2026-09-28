# 研究记录的文件格式

每条研究记录是工作区里的一个文件夹，全部是普通文件，不依赖本软件也能阅读。

```
<工作区>/studies/
  20260928-205129-fa65/        记录的编号：保存时的 UTC 日期、时间，加 4 位随机字符
    study.json                 图上的状态
    notes.md                   评论
    screenshot.png             保存时的截图
    history/
      20260929T031502-1c9e/    每次再保存之前，上一版的三个文件
  .trash/                      被删除的记录移到这里，不会被销毁
```

`notes.md` 可以用任何编辑器修改，软件下次打开这条记录时读到的就是修改后的内容。

## study.json

| 字段 | 含义 |
|---|---|
| `id`、`created`、`updated` | 编号、创建时间、最后保存时间（UTC） |
| `symbol`、`timeframe` | 品种、保存时所看的周期 |
| `focus` | 这条记录关注的时刻，UTC 毫秒 |
| `tag` | 快评 |
| `timezone` | 图上显示时间所用的时区 |
| `drawings` | 标注，见下 |
| `indicators` | 指标：名称 `name`、所在位置 `pane`（`candle` 表示画在 K 线上）、参数 `params` |
| `view` | 画面位置：每根 K 线的宽度 `barSpace`、画面右端那根 K 线的时间 `rightTimestamp`、它到右边缘的距离 `offsetRight` |
| `schemaVersion` | 格式版本，目前是 1 |

## 标注

| 字段 | 含义 |
|---|---|
| `id` | 标注的编号 |
| `name` | 种类：`segment` 线段、`rayLine` 射线、`straightLine` 直线、`horizontalStraightLine` 水平线、`verticalStraightLine` 垂直线、`box` 方框、`note` 文字 |
| `points` | 锚点。每个锚点有时间 `timestamp`（UTC 毫秒）和价格 `value`；水平线只有价格，垂直线只有时间 |
| `timeframe` | 画下或最后一次改动这个标注时所在的周期 |
| `extendData` | 颜色 `color`、文字 `text` |
| `styles` | 线条样式 |

锚点用时间和价格记录，不用屏幕位置。所以换周期、换窗口大小之后，标注仍然落在同一时刻、同一价格上。

在某个周期上画的锚点，到了别的周期会落在“包含那个时刻的那根 K 线”上。例如 1 小时图上 13:00 的锚点，在日线图上落在当天那根 K 线。记录里保存的始终是原来的时刻，换周期不会改动它。
