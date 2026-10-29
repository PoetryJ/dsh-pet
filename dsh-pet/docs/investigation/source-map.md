# 源码地图

仓库是用户 fork `PoetryJ/dsh-pet`，README 指向的上游是 `PC2005-cloud/dsh-pet`。插件包在 `dsh-pet/`。下面的路径相对于 `dsh-pet/`，除非写出仓库根。

证据分三档：

- **README 声称**：文档或包注释里的话，本轮没有用运行去核对。
- **源码确认**：读到了对应实现。
- **实际运行确认**：本轮进程里跑过。没有像素、没有 DSH、没有 Electron 窗的，不升到这一档。

这些能力都是固定提交里已经有的。地图只标出现状，不把它们写成待实现的新机制。

## 1. 素材生产

**入口**

- 仓库根 `MAKE-YOUR-OWN-PET.md`：提示词 → 绿幕视频 → 透明动画 → 拷进 `dsh-pet/assets/webm/`。
- 仓库根 `prompts/桌面宠物 10 秒动作提示词.md`：动作配方。
- 仓库根 `scripts/watermark_step01.py`、`chroma_step02.py`、`pr_import_step02.py`、`normalize_step03.py`、`encode_thumbs.py`、`encode_preview_gifs.py`。
- `encode_thumbs.py:39-40` 的转码尺寸是 `TARGET_W = 640`、`TARGET_H = 360`。

**核心数据**

- 源视频按文档放在仓库根 `video/`（文档写明不进 git）。
- 插件实际播放的文件在 `dsh-pet/assets/webm/`（VP9-alpha）。`package.json` 的 `files` 发布这份目录。

**调用关系**

文档给出的顺序是 step01 去水印 → step02 抠像 → step03 归一化 → step04 转码 → 拷贝到 `assets/webm`。运行时不调用这些脚本。播放端只按名字取已经放好的文件（`src/client/pet/animation/assets.ts:29-32`）。

**外部依赖**

文档写 Python 3、ffmpeg、numpy、scipy。本轮没有安装，也没有跑转码。

**已有测试**

素材链没有对应的 `src/**/*.test.ts`。运行时只测地址拼装：`src/client/pet/animation/assets.test.ts`。

**证据**

- README 声称：根 `README.md:18-25` 的三件套；`MAKE-YOUR-OWN-PET.md` 写 640×360、输出到 `assets/webm`。`package.json` 顶部注释写有 `scripts.encode:webm`，但 `scripts` 字段里没有这条命令。
- 源码确认：上述 Python 脚本存在；`encode_thumbs.py` 文件头散文仍写 360×360 和 `assets/thumb/`，同文件常量已是 640×360。散文和常量不一致，本轮不把它当成运行结论。
- 实际运行确认：无。没有跑 ffmpeg。

**已有价值**

角色、动作和透明视频的生产链已经在仓库里。插件不负责生成像素，只消费 `assets/webm`。

## 2. 动画播放

**入口**

- 浏览器：`src/client/pet/animation/animation.ts` 的 `createOwnAnimation`。卡装配在 `src/client/pet/card/animation.ts:66-96`，`useEffect` 依赖 `[anim, once, seq, cuePlayback]` 后调用 `switchTo`。
- 桌面：`runtime/electron-helper/sprite/playback.js` 的 `switchTo` / `playOnce`。`events.js:310-320` 的 `applyAnimLeaf` 进入它。
- 回执词汇：`src/shared/playback.ts`。宿主状态机：`src/host/playback/store.ts`。浏览器上报：`src/client/pet/playback-report.ts`。桌面上报：`runtime/electron-helper/sprite.js` 的 `reportPlayback`（约 276 行）POST 同一个 `/playback/{id}/report`。

**核心数据**

- 浏览器 `pending`（`animation.ts:34-38`）：`anim`、`once`、`gen`。另有 `playing` 保存当前回执编号。
- 桌面 `this.pending` 与 `this.playback`（`playback.js:14-29`、`78`）。
- A/B 两个 video 槽。浏览器先 `loader.load` 再赋 blob（`animation.ts:160-183`）；桌面直接 `el.src = ...` 然后 `el.load()`（`playback.js:35-58`）。

**调用关系**

点播叶子到达后，浏览器经 `cue-effects.ts:167-192` → `menu-actions.ts:148-167` 的 `playOnce` → React 状态 → `switchTo`。桌面经 `applyAnimLeaf` → `onMenuAction` / `playUrlOnce` → `switchTo`。播完后的下一支由浏览器 `cues.ts` 与桌面 `handleEnded` 各自决定，选池函数在 `src/shared/pickers.ts`。

**外部依赖**

浏览器素材加载用 `fetch` + blob（`asset-loader.ts`），超时 10 秒（`animation.ts:27-28`）。桌面用 video 元素自己的加载，另有 10 秒 `setTimeout`（`playback.js:53`）。容器格式由 `media.ts:34-40` 的 `thumbExt()` 决定，macOS WebKit 走 `.mov`，其余 `.webm`。

**已有测试**

- `src/client/pet/animation/animation.test.ts`（含 182-190 的防重用例）
- `assets.test.ts`、`media.test.ts`、`cues.test.ts`
- `src/client/pet/playback-report.test.ts`
- `src/host/playback.test.ts`
- 桌面 `playback.js` 没有同目录单测。本轮探针第一次把它装进假精灵执行。

**证据**

- README 声称：根 `README.md` 写 100 余段动画、浏览器与桌面行为一致。
- 源码确认：两套 `switchTo` 都在，注释写「与浏览器同构」，但是两份源码，不是一份共享函数。
- 实际运行确认：探针驱动了 `createOwnAnimation` 和 `playback.js`。见 `playback-chain.md`。没有真实 video，也没有像素。

**已有价值**

双缓冲、世代号丢弃迟到加载、`play()` 兑现后才在成功路径上报 `playing`、终态回执，都已经写在成功路径里（`animation.ts:219-226`，`playback.js:80-89`）。防重分支是这条路径上的例外，不是缺了一套播放器。

## 3. 行为控制

**入口**

- 播完分支：`src/client/pet/animation/cues.ts` 的 `decideEndedCue`；桌面对应 `playback.js` 的 `handleEnded`（214 行起）和 `playIdle`（180 行起）。
- 随机下一支：`src/client/pet/animation/next-animation.ts`，装配在 `src/client/pet/card/animation-flow.ts`。
- 菜单与点播：`src/client/pet/menu-actions.ts`；桌面 `runtime/electron-helper/sprite/menu.js`。
- 工作状态、余额、说话：浏览器 `src/client/pet/card/cue-effects.ts`；桌面 `runtime/electron-helper/events.js`。
- 选池：`src/shared/pickers.ts`。两端注释都要求随机链走这里。

**核心数据**

成品配置里的 `animations`（idle / turn / drag / clicks / moves / categories / events）。工作状态档位索引在 `src/shared/work-status.ts`。占用锁只挡自动来源，显式点播不挡（`cue-effects.ts:62-63`，`playback.js:118-123`）。

**调用关系**

自播链在一段 `ended` 之后掷权重、选池、再 `switchTo`。第三方点播不走随机链，走菜单动作或 url 直切。工作状态动画由 tick 写入当前动画名，播完再由 `handleEnded` / `decideEndedCue` 轮换或回到 idle。

**外部依赖**

无直接第三方库。行为只读配置和 `/state` 叶子。

**已有测试**

`cues.test.ts`、`next-animation.test.ts`、`menu-actions.test.ts`、`src/shared/pickers.test.ts`、`src/host/work-status.test.ts`、`lock-freeze.test.ts`。

**证据**

- README 声称：待机、随机动作、工作状态、余额档位、右键点播。
- 源码确认：上述文件。
- 实际运行确认：本轮只在探针里调用了点播 `switchTo` 和一次 `handleEnded`。没有跑随机链、工作状态或余额。

**已有价值**

「播完之后做什么」已经是纯函数（`cues.ts`）加两端各自的副作用壳。点播问题出在回执编号，不在选池。

## 4. 运动与窗口

**入口**

- 共享物理：`src/shared/physics.ts` 文件头写明浏览器和桌面消费同一份。
- 浏览器驱动：`src/client/pet/motion/flight.ts`、`drag.ts`、`walk.ts`、`position-follow.ts`。
- 桌面驱动：`runtime/electron-helper/sprite/motion.js`。
- 窗口：`runtime/electron-helper/main.js`、`main/windows.js`。无 `DISPLAY` / `WAYLAND_DISPLAY` 时桌面模式应跳过开窗（根 README 兼容性一节）。

**核心数据**

位置是归一化中心。抛掷状态、拖拽速度、漫游计划在各自驱动里。窗口几何来自 Electron `screen`。点播移动动画时，菜单层可能不换视频源而直接回 `failed` / `busy`（`menu-actions.ts:156-164`，`playback.js` 的 `tryMove`）。

**调用关系**

`switchTo` 成功翻前台后，浏览器 `onFrontReady` 才补 Q 弹和走位（`card/animation.ts:75-81`）。桌面在 `playback.js:91-96` 做同样的事。运动不负责回执编号。

**外部依赖**

Electron（窗口、托盘、穿透）。浏览器侧只用 DOM 与 `requestAnimationFrame`。

**已有测试**

`flight.test.ts`、`drag.test.ts`、`walk.test.ts`、`geometry.test.ts`、`src/shared/physics.test.ts`、`src/host/desktop-geometry.test.ts`。没有把 Electron 窗拉起来的测试。

**证据**

- README 声称：拖拽甩抛、多屏、透明置顶小窗，三端行为一致。
- 源码确认：物理在 `src/shared`，窗口在 Electron 主进程，两端驱动是两份文件。
- 实际运行确认：无。本环境有 `DISPLAY=:1`，但没有 `node_modules`，没有启动 Helper。

**已有价值**

手感参数和碰撞已经共享。窗口载体是另一层，点播回执不应该靠改窗口来修。

## 5. 聊天与记忆

**入口**

- 宿主生成：`src/host/chat.ts`（`ctx.llm`）。
- 记忆与队列：`src/host/plugin/chat-memory.ts`。记忆文件是 `userRoot/memory.json`（`chat-memory.ts:45`）。
- 路由：`src/host/routes/chat.ts`。
- 浏览器面板：`src/client/chat/`（`panel.ts`、`api.ts`、`register.ts`）。
- 气泡到达渲染端走 `/state` 的 `say` 叶子，不是点播回执。

**核心数据**

`ChatMemoryMessage`（`chat.ts:27-35`）：role、content、ts，以及可选图片与表情包名。活跃宠物 id 在进程内存（`chat-memory.ts:37`）。

**调用关系**

对话请求进宿主队列，模型回复写入记忆，再 `state.writePet(..., 'say', ...)`。渲染端 `consumeSay` 只弹气泡（`cue-effects.ts:154-164`）。说话可以再带一个动画名，那是另一条换源，不走本次点播编号。

**外部依赖**

DSH 的 `ctx.llm`、`@deepseek-ai/dsh-llm`。本环境没有这些包。

**已有测试**

`src/host/chat.test.ts`、`chat-memory.test.ts`、`src/client/chat/api.test.ts`、`src/shared/chat/*.test.ts`。

**证据**

- README 声称：碎碎念、对话、记忆持久化。
- 源码确认：读写 `memory.json` 与 say 叶子。
- 实际运行确认：无。没有模型，也没有打开聊天面板。

**已有价值**

记忆是宿主文件，聊天面板是客户端。它们和点播回执编号不是同一条状态机。

## 6. 接口与存储

**入口**

- 契约：仓库根 `openapi.yaml`。播放上报在 `1334-1355` 行。点播路由在 `dsh-pet/src/host/routes/motion.ts:28-61`。
- 插件装配：`src/host/index.ts` 的 `apply`。`inject` 需要 `webServer`、`llm`、`commands` 等（`index.ts:30`）。
- 状态：`src/host/state.ts` 的 `PollStateStore`。回执表：`src/host/playback/store.ts` 的 `PlaybackStore`。
- 配置：`src/host/config/read.ts` 的 `readAllConfig`。路径清单：`src/host/storage-paths.ts`。
- 待办：`src/host/todo/store.ts`。

**核心数据**

- 播放记录：`accepted → playing → ended|failed|cancelled`（`shared/playback.ts:9-15`）。终态不可逆（`store.ts:124-133`）。
- `/state` 叶子：每只宠物一份 `anim`。`writePet` 整叶替换并递增 counter（`state.ts:136-143`）。
- 新点播受理时，若该宠物仍有未从 `activeByPet` 摘掉的上一场，上一场被标成 `cancelled` / `superseded`（`store.ts:94-97`）。`finish` 在**任何**状态写入时都摘掉 active（`store.ts:226`），包括非终态的 `playing`。

**调用关系**

`POST /anim` → `decideAnim` → `playback.create` → `state.writePet('anim')` → 渲染端长轮询 → `switchTo` → `POST /playback/{id}/report` → `PlaybackStore.report`。外部用 `GET /playback/{id}` 读结果。上报方拿到的 HTTP 200 不区分「写进了」和「被忽略」（`routes/playback.ts:36-42`）。

**外部依赖**

DSH WebServer 挂路由。独立模式有 `src/standalone/`。配置是用户目录里的 JSONC，不是仓库里的运行时状态。

**已有测试**

`playback.test.ts`、`anim.test.ts`、`state.test.ts`、`src/shared/state.test.ts`、`config.test.ts`、`storage-paths.test.ts`、`routes.test.ts`。本轮跑了前四个加 `playback-report.test.ts`：122 通过、0 失败，TAP 在 `logs/existing-tests.tap`。

**证据**

- README 声称：HTTP 前缀 `/dsh-pet-7340`，动作接口回 `{ok}`，播放结果靠 `GET /playback/{id}`。
- 源码确认：路由与存储类如上。
- 实际运行确认：探针调用了 `PlaybackStore` 与 `PollStateStore`。没有打开 HTTP 端口。

**已有价值**

受理、顶替、终态保护、长轮询和查询等待都在宿主里。渲染端要做的是按契约上报，宿主不会替它猜播放结果（`playback.ts` 文件头，`routes/playback.ts:18-19`）。
