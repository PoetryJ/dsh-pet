# 首轮调研：点播防重与六域基线

固定提交 `e821ddccdef5dd24c2663c163e0b62d15b0646a5`。本目录是调研证据，不是产品修复。

## 结论

假设在**模块级证实**，在**真实运行路径未复现**。不得把后者说成已经发现的运行漏洞。

首次加载还没完成时，第二个同名、同 `once`、不同 `playbackId` 的 `switchTo` 会立刻上报 `playing`。此时 `play()` 还没被调用。浏览器端连 `src` 都还是空的。

- 加载成功：第二个编号随后收到 `cancelled` / `superseded`，而且仍发生在 `play()` 调用之前。真正的 `play()` 兑现和 `ended` 记在第一个编号上。
- 加载失败：失败回执记在第一个编号上。第二个编号停在 `playing`，没有 `failed` / `ended` / `cancelled`。
- 把这些回执送进真实 `PlaybackStore` 之后：宿主接受第二个编号的提前 `playing`；失败回执落在已经被 `superseded` 的第一个编号上，结果是 `ignored`。外部查询看不到这次失败。

`play()` 兑现只表示播放调用被接受，不是屏幕上已经画出像素。本轮没有观察像素。

## 材料

| 文件 | 内容 |
| --- | --- |
| [source-map.md](source-map.md) | 六域源码地图 |
| [playback-chain.md](playback-chain.md) | 点播链路、共享与分叉、契约对照 |
| [findings.md](findings.md) | 问题报告、两个修复候选、未验证项 |
| [logs/playback-dedup-probe.json](logs/playback-dedup-probe.json) | 探针原始事件 |
| [logs/existing-tests.tap](logs/existing-tests.tap) | 既有测试 TAP（122 通过） |
| [../scripts/verify/README.md](../scripts/verify/README.md) | 再跑命令 |

探针：`dsh-pet/scripts/verify/playback-dedup-probe.ts`。
