# 问题报告

固定提交 `e821ddccdef5dd24c2663c163e0b62d15b0646a5`。Node `v22.23.4`。工作区在探针运行时是该提交的 `cursor/playback-dedup-investigation-99df` 分支，产品源码未改。

## 环境

- 用户仓库：`https://github.com/PoetryJ/dsh-pet.git`，探针开始时 `HEAD` 就是 `e821ddccdef5dd24c2663c163e0b62d15b0646a5`。
- 上游文档指向 `https://github.com/PC2005-cloud/dsh-pet.git`。
- `PATH` 上没有 `dsh`。`node_modules` 不存在。`DISPLAY=:1`，`WAYLAND_DISPLAY` 未设置。
- 既有测试命令与结果见 `scripts/verify/README.md` 与 `logs/existing-tests.tap`：122 通过，0 失败。其中 `animation.test.ts` 的防重用例通过，预期仍是「加载未完成就回 `playing`」。

再跑探针：

```sh
cd dsh-pet
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/verify/playback-dedup-probe.ts
```

原始事件：`logs/playback-dedup-probe.json`。下面的序号是该文件里 `marks[].seq`。`playCalls` 是后台槽位（第一次换源的 B）上 `play()` 被调用的次数。

## 预期

按 `openapi.yaml:1343-1350`：

- 第二个编号在 `play()` 兑现之前不能是 `playing`。设了 `src`、甚至还没设 `src`，都不够。
- 加载成功且视频播完：该编号应到 `ended`。`cancelled` 只用于被非点播动画顶掉。宿主侧「被新点播顶掉」在受理时已经写在**被顶掉的那一场**上。
- 加载失败：该编号应到 `failed`（`asset-load` 或 `decode-error`），而不是停在 `playing`。
- 外部调用方通过 `GET /playback/{id}` 能看到上述终态。渲染端上报被忽略时，HTTP 仍是 200（`routes/playback.ts:40-42`），所以上报方自己看不出写丢了。

## 实际（模块级）

### 浏览器 `createOwnAnimation`，加载成功

序号 1–15，`browserModule.success`：

1. `switchTo(idle1, true, pb-1)`，加载请求 1 次，`playCalls = 0`，`src` 仍是空串。
2. `switchTo(idle1, true, pb-2)`。序号 6 上报 `pb-2 playing`。此时 `playCalls = 0`，`src` 仍是空串，加载请求仍是 1。
3. 释放加载成功。序号 9 在 `play()` 之前上报 `pb-2 cancelled` / `superseded`（`playCalls` 仍是 0）。
4. 随后 `play()` 被调用一次。序号 12 才上报 `pb-1 playing`。序号 14 上报 `pb-1 ended`。
5. `pb-2` 的回执只有 `playing`、`cancelled`。没有 `ended`。

`cancelled` 来自翻前台时的闭包比较：防重把 `playing` 改成了 `pb-2`，而 `onReady` 仍拿着第一次调用的 `pb-1`（`animation.ts:213` 与 `217`）。同一次加载被当成「把 pb-2 顶掉」。

### 浏览器，加载失败

序号 1–9，`browserModule.failure`：

1. 同样在序号 6 提前上报 `pb-2 playing`，`playCalls = 0`。
2. 加载器 `onError`。序号 8 上报 `pb-1 failed` / `asset-load`。
3. `pb-2` 没有第二条回执。`playingPlayback()` 仍是 `pb-2`。`play()` 没有被调用。

### 浏览器，加载成功但 `play()` 拒绝

补充，不是假设原文。`playReject`：`pb-2` 仍先 `playing` 再 `cancelled`（都在 `play()` 之前），`pb-1` 收到 `failed` / `play-rejected`。第二个编号同样没有 `play-rejected`。

### 浏览器，第二次编号是 `null`

`nullSecondDoesNotReport`：回执 0 条，加载仍是 1 次。effect 清编号后再进入防重，**不会**提前 `playing`。提前 `playing` 需要第二个非空编号。

### 桌面 `playback.js`

成功与失败的回执顺序与浏览器相同（`desktopModule`）。差别只在载体：

- 第一次 `switchTo` 已经把 `src` 设成 `/dsh-pet-7340/thumb/duck/idle1.webm` 并调用了 `load()`。提前 `playing` 时 `playCalls` 仍是 0。契约写明设了 `src` 不算 `playing`。
- 失败由 `onerror` 进入，原因是 `decode-error`，编号仍是 `pb-1`。`pb-2` 停在 `playing`。

## 宿主实际接受了什么

这一层把渲染端回执原样送进 `PlaybackStore`。没有 HTTP。编号是 `create()` 生成的。

受理第二个点播时，第一个还在 `accepted`，宿主把它写成 `cancelled` / `superseded`（`store.ts:94-97`）。这符合「被新点播顶掉由宿主标记」。

### 加载成功（`hostComposition.browserSuccess`）

- 序号 8：第二个编号 `playing`，`hostOutcome` 是 `ok`，`playCalls = 0`。
- 序号 10：此时再 `create` 第三个。第二个仍是 `playing`，**没有**被第三个标成 `cancelled`。`finish` 在写入 `playing` 时已经摘掉 `activeByPet`（`store.ts:226`），所以后续受理不再顶替这场非终态记录。
- 序号 12：第二个编号 `cancelled` / `superseded`，`hostOutcome` 是 `ok`。这发生在 `play()` 之前。
- 序号 15、17：第一个编号的 `playing` 和 `ended` 都是 `ignored`，记录保持宿主受理时写的 `cancelled`。
- 终态等待在这些回执之后才注册，`timeout = 0`，所以 `matched` 是 false、状态已是 `cancelled`。这只说明当时记录已经是终态。路由在挂起前会先看当前状态（`routes/playback.ts:54-56`）：若调用方在这条 `cancelled` 之后查询，且 `wait` 含 `cancelled`，会立刻 `matched: true`。没有人收到这场动画的 `ended`。

桌面组合 `desktopHostSuccess` 的回执结局相同。

### 加载失败（`hostComposition.browserFailure`）

- 第二个编号被接受为 `playing`（`playCalls = 0`）。
- 第一个编号的 `failed` / `asset-load` 是 `ignored`。
- 第二个编号保持 `playing`。终态等待 `matched: false`，状态仍是 `playing`。
- 第三个受理没有把它顶掉。`sweep` 只清理终态（`playback.test.ts` 已有「非终态不受影响」），所以这条 `playing` 会留到进程结束。
- 外部调用方等 `ended,failed,cancelled` 等不到失败。上报方收到的若是 HTTP，`ignored` 也是 200，调用方从上报响应里看不到错误。桌面失败组合相同，只是原因字符串是 `decode-error`。

## 触发条件

1. 同一个动画链实例上，第一次 `switchTo(name, once, id1)` 已经设了 `pending`，加载尚未结束（浏览器：`onObjectUrl` 未到；桌面：`loadeddata` 未到）。
2. 再 `switchTo(name, 相同 once, id2)`，且 `id2` 非空。
3. 名字或 url 字符串必须相同。`once` 不同不会进这个分支（源码比较，本探针没有另跑一组）。

活页面上还要第一次叶子已经被消费。两次写入落在同一次快照里时，渲染端只看到第二个编号，不会进防重。见 `playback-chain.md`。

## 影响

第二个调用方会在视频尚未 `play()` 时看到 `playing`。

- 成功时接着看到 `cancelled` / `superseded`，发生在 `play()` 之前。若他们等的是 `ended`，会被这场 `cancelled` 提前唤醒，而播完回执在已经被宿主作废的第一个编号上，且被忽略。
- 失败时一直看到 `playing`，看不到 `failed`。
- 渲染端日志能看到素材失败（探针里产品代码打出了「素材加载失败」）。那条日志不是 `/playback/{id}` 的记录。

## 证据等级

- 模块级浏览器与桌面：**证实**。日志里的 `prematurePlayingBeforePlay` 为 true。
- 宿主记录表组合：**证实**「若渲染端按上述顺序上报，宿主会接受提前的 `playing`，并忽略记在第一个编号上的真实终态」。不是抓到的 HTTP。
- 真实运行路径：**不能证实，也不证伪**。缺少下面的条件，所以**不宣称已发现运行漏洞**。

## 修复候选（只设计，本轮不改代码）

现有单测 `animation.test.ts:182-190` 把提前 `playing` 写成了预期。任一候选都会让这则测试失败。本 PR 不改它，避免用新预期把不符合契约的行为说成通过。

### 候选 A：防重只改回执目标，`playing` 仍只从 `play()` 兑现发出

`pending` 记住最新的非空 `playbackId`。防重命中时更新这个编号并返回，不调用 `report playing`。`onReady`、`onError`、`play().then` / `catch`、`handleEnded` 都读最新编号，不读第一次 `switchTo` 的闭包。

翻前台时不要把「刚并进来的新编号」当成被旧闭包顶掉的 `playing`。加载成功：最新编号在 `play()` 兑现后得到 `playing`，播完得到 `ended`。加载失败：最新编号得到 `failed`。宿主已经把第一个编号标成 `cancelled`，再给它上报会被忽略，这是现有规则，不用渲染端再报一次。

不增加第二次素材请求。浏览器与桌面要各改自己的 `switchTo`，因为没有共享实现。

### 候选 B：编号不同就不防重，升一代覆盖

`playbackId` 不同则 `gen` 加一，让第一次加载结果按现有「世代不符即丢弃」作废，第二次走完整的加载和 `play()`。每个编号的回执跟自己的那次调用走。

代价是同名动画多一次取素材。现有单测断言「不重新取素材」。行为更隔离，但和「防重是为了不重复加载」的注释相反。

候选 A 保留不重复加载，只改正回执落点，更贴近成功路径已经写下的 `play()` 口径。

## 尚未验证

1. **活的 DSH 页面或 Electron 窗。** 没有 `dsh`，没有 `node_modules`，没有启动 Helper。`DISPLAY` 有值也不能代替 Electron。因此没有观察到：长轮询是否真的在两次 `POST /anim` 之间把两张叶子都送到渲染端、真实 `HTMLVideoElement.play()` 的时序、屏幕像素。
2. **HTTP 路由。** `store.report` 的 `ok` / `ignored` 没有经过 `handlePlaybackRoutes`。200 与 `unknown-playback` 的响应体没有抓包。
3. **在提前 `playing` 和后续终态之间挂起的等待者。** 探针的 `wait` 是在回执结束之后注册的。等待者会在状态进入 `wait` 集合时被唤醒，这是 `store.ts` 的 `finish` 和既有单测已经覆盖的行为，不是这次新开的连接。
4. **url 形态、`once` 不同、两个不同动画名。** 防重键是 `anim + once`。url 形态把地址当作 `anim`（`playback.js:111-113`，浏览器 `setCueUrl`）。相同地址会进同一分支，本探针没有单独跑 url。
5. **素材转码管线。** 没有跑 Python / ffmpeg。`encode_thumbs.py` 文件头和常量不一致，只记在源码地图里。
6. **mock 宿主。** `scripts/dev/mock-server.mjs` 没有点播与回执，启动它不能补上第 1 条。
