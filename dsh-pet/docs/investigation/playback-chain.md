# 点播链路

契约、两套播放实现、以及本轮实际跑到哪一层。行号对固定提交 `e821ddccdef5dd24c2663c163e0b62d15b0646a5`。

## 契约

`openapi.yaml:1337-1355` 把 `POST /playback/{id}/report` 定义成渲染端 → 宿主的内部通道。四个时机：

| status | 契约里的时机 |
| --- | --- |
| `playing` | 视频确实开始出画，括号写明是 `play()` 兑现，而不是设了 `src` |
| `ended` | 播到结尾 |
| `failed` | 素材没拿到、解码失败、自动播放被拒、移动系统占用 |
| `cancelled` | 被非点播动画顶掉（点击、拖拽、碎碎念、余额、工作状态、空闲回收） |

同段还写：`accepted` 由宿主在受理时写入；终态之后的上报忽略但仍回 200；「被新点播顶掉」由宿主在受理新点播时标记，不需要渲染端再报。

`play()` 兑现不是屏幕像素。成功路径的注释也是这个口径（`animation.ts:221`，`playback.js:82`）。本轮判断提前 `playing` 时，只看 `play()` 有没有被调用、返回的 Promise 有没有兑现，不看像素。

## 浏览器

1. `POST /anim`（`routes/motion.ts:53-60`）建播放记录，把 `{ name 或 url, playbackId }` 写进 `pets.<id>.anim`。
2. `runStatePoll`（`state-poll.ts:32-51`）长轮询。空闲挂起 `STATE_WAIT_MS = 1000`（`timings.ts:11`）。有变化宿主立刻返回。
3. `multi.ts:234-246` 看到 anim 叶子 counter 变化就递增本地 seq。注释写明连点两次也会分发两次。
4. `cue-effects.ts:167-192` 消费这条指令。名字走 `playByName`，url 走 `setCueUrl` + `setAnim`。
5. `runtime.ts:196-199` 的 `playOnce` 设置 `once`、动画名和 `cuePlayback`。
6. `card/animation.ts:92-96` 的 effect 调用 `switchTo(anim, once, cuePlayback)`。
7. `switchTo` 开头就 `clearCuePlayback()`（`animation.ts:129-130`）。编号变回 `null` 会让 effect 再跑一遍。
8. 回执经 `playback-report.ts:44-51` POST。失败只打 warn，不抛。

防重在 `animation.ts:137-143`：

```text
pending 的 anim、once 都相同
  → 若 cuePlaybackId 非空：playing = 该编号，立刻 report playing，return
  → 不发起第二次 load，也不调用 play()
```

成功路径要等到 `loadeddata` 之后的 `el.play().then` 才 `report playing`（`animation.ts:219-222`）。失败路径把 `failed` / `asset-load` 报给**这一次调用闭包里的** `cuePlaybackId`（`animation.ts:185-189`）。翻前台时，如果 `playing` 不是这次闭包的编号，会先报 `cancelled` / `superseded`（`animation.ts:213`），然后把 `playing` 改回闭包编号（`animation.ts:217`）。

既有测试 `animation.test.ts:182-190` 的标题是「防重命中仍如实回 playing」。它在第一次 `switchTo('idle1', true, 'pb-1')` 之后、加载完成之前再调 `switchTo('idle1', true, 'pb-2')`，断言只有一次 load，且回执是 `pb-2` 的 `playing`。测试注释把这说成 effect 因编号变化再跑一遍。源码里 effect 的第二次是 `clearCuePlayback()` 带来的 `null`：探针里第二次传入 `null` 时，回执条数是 0。`pb-2` 这条断言覆盖的是两个非空编号，不是 effect 清编号。本轮没有改这条测试。它现在是通过的，通过不等于符合 OpenAPI。

## 桌面

1. 同一份 `/state`。`events.js:359-386` 用 `takeChanged`，anim 路径调用 `applyAnimLeaf`。
2. `applyAnimLeaf`（`events.js:310-320`）对 url 调 `playUrlOnce`，对名字调 `onMenuAction`。
3. `playback.js:11-27` 的防重与浏览器同形：pending 的 anim、once 相同就 `this.playback = playbackId` 并立刻 `reportPlayback(..., 'playing')`，然后 return。
4. 不走 React。没有「清成 null 再进一次 effect」这一步。两次叶子变化就是两次 `switchTo`。
5. 加载是 `el.src` + `loadeddata`，不是浏览器的 blob fetch。失败走 `onerror` 或 10 秒定时器（`playback.js:43-57`），原因是 `decode-error` 或 `asset-load`，编号仍是这次调用的闭包参数。
6. `loadeddata` 里同样先按 `this.playback !== playbackId` 报 `cancelled`，再把 `this.playback` 设回闭包编号，然后 `el.play().then` 才报 `playing`（`playback.js:72-83`）。

## 共享与分叉

共享的是协议和选池，不是 `switchTo` 本身。

| 内容 | 哪里共用 | 哪里各写一份 |
| --- | --- | --- |
| 状态名 `playing` / `ended` / `failed` / `cancelled` | `src/shared/playback.ts` 被宿主 `playback/status.ts` 和浏览器类型引用 | 桌面 `playback.js` 写死字符串。`src/shared/index.ts` 没有导出 `playback.ts`，打进 `shared-core.js` 的清单里也没有它 |
| `/state` 叶子形状、`readAnim`、`takeChanged` | `src/shared/state.ts` | 宿主 `PollStateStore` 按注释不 import `src/shared`，形状各写一份 |
| 受理、顶替、终态保护、查询等待 | 只有宿主 `PlaybackStore` | 两端只上报 |
| 选下一支动画 | `src/shared/pickers.ts` | 两端的 `handleEnded` / `playIdle` 是两份壳 |
| 换源、防重、回执时机 | 无共享函数 | `animation.ts` 与 `playback.js` |
| 素材字节 | 都读 `assets/webm`（或 mov 回退） | 浏览器 fetch blob；桌面 video 直链 |
| 菜单动作 | 语义对齐 | `menu-actions.ts` 与 `sprite/menu.js` |

`scripts/build-desktop-core.mjs` 只把 `src/shared` 打成 `shared-core.js`。播放状态机不在里面。

## 真实路径要同时满足的条件

`pets.<id>.anim` 是单叶子。`takeChanged` 只比较 counter。

探针用真实 `PollStateStore` 测了两种快照（`logs/playback-dedup-probe.json` 的 `stateDelivery`）：

- 两次 `writePet` 之后只 `takeChanged` 一次：只有一条变化，`playbackId` 是第二个。渲染端不会为第一个编号进入 `switchTo`。宿主若已 `create` 两次，第一个编号在受理第二个时已经是 `cancelled` / `superseded`。第二个编号走正常加载。这种快照**不会**触发防重。
- 两次写入之间各 `takeChanged` 一次：第一拍是 `pb-1`，第二拍是 `pb-2`。若第一拍已经调用了 `switchTo` 且加载未完成，第二拍会撞上防重。

长轮询的结构允许第二种：第一次写入唤醒正在等的客户端，客户端处理并再次挂起，第二次写入再唤醒（`state.ts:136-143` 每次写入都 `wakeWaiters`；桌面循环在 `events.js:415-421`）。这是源码结构，不是本轮打开的 HTTP 连接。

因此模块级行为要变成外部可见，还要：渲染端已经为第一个编号执行过 `switchTo`，并且第一次加载尚未结束。只看到合并后的那一张叶子时，假设不成立。

## 本轮跑到的层

| 层 | 做了什么 | 没有做什么 |
| --- | --- | --- |
| 浏览器模块 | 真实 `createOwnAnimation`，假加载器挂起第一次 `load` | 没有 React effect，没有页面 |
| 桌面模块 | `vm` 执行真实 `playback.js`，假 video 的 `readyState` 保持 0，直到探针派发 `loadeddata` 或 `onerror` | 没有 Electron，没有真 video |
| 宿主组合 | 回执直接送进真实 `PlaybackStore.report` | 没有 HTTP。路由对 `ignored` 也回 200 是读源码，不是抓包 |
| 状态投递 | 真实 `PollStateStore` + `takeChanged` + `readAnim` | 没有长轮询 socket |
| 活进程 | 无 | 见 `findings.md` 的未验证项 |

`scripts/dev/mock-server.mjs` 只有配置、余额和 thumb 读文件，没有 `POST /anim`，也没有回执。启动它不能当作点播链路。
