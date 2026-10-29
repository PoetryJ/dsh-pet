/**
 * 点播防重复现：只驱动现有模块，不改产品代码，也不改既有测试的预期。
 * 浏览器侧走 createOwnAnimation，桌面侧把 playback.js 装进假 PetSprite。
 * 宿主侧把渲染端回执原样送进 PlaybackStore，看外部调用方实际能读到什么。
 * 跑完写出日志；契约被违反时仍以 0 退出，退出码只表示这次取证有没有跑完。
 * @module dsh-pet/scripts/verify/playback-dedup-probe
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { PlaybackStore, type PlaybackRecord } from '../../src/host/playback.ts';
import { PollStateStore } from '../../src/host/state.ts';
import { createOwnAnimation, type OwnAnimationDeps } from '../../src/client/pet/animation/animation.ts';
import type { AssetHandlers, AssetLoader } from '../../src/client/pet/animation/asset-loader.ts';
import type { ReportableStatus } from '../../src/shared/playback.ts';
import { flattenCounters, readAnim, takeChanged } from '../../src/shared/state.ts';
import type { Animations } from '../../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const logPath = resolve(packageRoot, 'docs/investigation/logs/playback-dedup-probe.json');
const origin = process.hrtime.bigint();

/** 一条按发生顺序编号的事件。 */
interface Mark {
  seq: number;
  tMs: number;
  event: string;
  detail?: Record<string, unknown>;
}

/** 假 video：只实现动画链与桌面 switchTo 会碰到的成员。 */
class FakeVideo {
  loop = true;
  muted = false;
  autoplay = false;
  playsInline = false;
  src = '';
  onended: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  style: Record<string, string> = {};
  paused = true;
  readyState = 0;
  playCalls = 0;
  loadCalls = 0;
  /** 为 true 时 play() 拒绝，用来看兑现失败后回执落在哪个编号。 */
  rejectPlay = false;
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  /** 同步派发已登记的监听；loadeddata 的处理函数由此进入。 */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this } as unknown as Event);
    }
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.rejectPlay) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }
}

/** 假素材加载器：load 只登记，由探针决定何时成功或失败。 */
class FakeLoader implements AssetLoader {
  requests: Array<{ url: string; handlers: AssetHandlers }> = [];
  released: string[] = [];
  aborts = 0;

  load(url: string, handlers: AssetHandlers): void {
    this.requests.push({ url, handlers });
  }

  abortAll(): void {
    this.aborts += 1;
  }

  release(objectUrl: string): void {
    this.released.push(objectUrl);
  }
}

const animations = {
  idle: ['idle1'],
  turn: ['turn1'],
  drag: ['drag1'],
  clicks: ['click1'],
  moves: { default: {}, actions: [] },
  categories: [],
  events: { workStatus: [['ws-run-a']], balance: ['bal1'] },
} as unknown as Animations;

/** 单调序号加相对毫秒，避免用墙钟比较先后。 */
function createLog() {
  const marks: Mark[] = [];
  let seq = 0;
  const mark = (event: string, detail?: Record<string, unknown>): void => {
    marks.push({
      seq: ++seq,
      tMs: Number(process.hrtime.bigint() - origin) / 1e6,
      event,
      detail,
    });
  };
  return { marks, mark };
}

/** 记录里只留外部调用方看得到的字段。 */
function snap(record: PlaybackRecord | undefined) {
  if (!record) return null;
  return { playbackId: record.playbackId, status: record.status, reason: record.reason ?? null };
}

/**
 * 挂一个只等终态的等待者，timeout=0，下一拍返回。
 * 这是 PlaybackStore 自己的「立刻返回」语义，不是随意 sleep。
 */
function waitTerminal(store: PlaybackStore, playbackId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    // PlaybackStore 把等待定时器 unref 了：探针里若没有别的活动句柄，进程会在回调前退出。
    // 这个有引用的定时器只负责把事件循环留住，不参与判定。
    const keepAlive = setTimeout(() => {
      finish({ playbackId, status: 'probe-keep-alive-fired', matched: false });
    }, 1000);
    const finish = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(keepAlive);
      resolve(value);
    };
    const cancel = store.wait({
      playbackId,
      wait: ['ended', 'failed', 'cancelled'],
      timeoutMs: 0,
      onWake: (record, matched) => {
        finish({ playbackId, status: record.status, reason: record.reason ?? null, matched });
      },
    });
    if (cancel === undefined) finish({ playbackId, status: 'missing', matched: false });
  });
}

/** 浏览器动画链：加载器不完成，直到调用方释放。 */
function browserChain(mark: (event: string, detail?: Record<string, unknown>) => void, store?: PlaybackStore) {
  const videoA = new FakeVideo();
  const videoB = new FakeVideo();
  const loader = new FakeLoader();
  const reports: Array<{ id: string; status: ReportableStatus; reason?: string; hostOutcome?: string }> = [];
  const deps: OwnAnimationDeps = {
    videoA: () => videoA as unknown as HTMLVideoElement,
    videoB: () => videoB as unknown as HTMLVideoElement,
    cfg: () => ({ id: 'pet-1', assetRoot: 'duck', animations }),
    currentAnim: () => 'idle1',
    workStatus: () => null,
    facing: () => 'left',
    report: (id, status, reason) => {
      const hostOutcome = store ? store.report(id, status, reason) : undefined;
      reports.push({ id, status, reason, hostOutcome });
      mark('report', {
        id,
        status,
        reason: reason ?? null,
        hostOutcome: hostOutcome ?? null,
        hostStatus: store ? (store.get(id)?.status ?? null) : null,
        playCalls: videoB.playCalls,
        src: videoB.src,
      });
    },
    clearCuePlayback: () => mark('clear-cue-playback'),
    onFrontReady: () => mark('front-ready'),
    onEnded: () => mark('on-ended-callback'),
    isDragging: () => false,
    initiallyFrozen: false,
    loader,
  };
  const anim = createOwnAnimation(deps);
  return { anim, videoA, videoB, loader, reports };
}

/** 桌面 switchTo 用的假精灵；方法来自真实 playback.js。 */
function desktopSprite(
  prototype: object,
  mark: (event: string, detail?: Record<string, unknown>) => void,
  store?: PlaybackStore,
) {
  const videoA = new FakeVideo();
  const videoB = new FakeVideo();
  const reports: Array<{ id: string; status: string; reason?: string; hostOutcome?: string }> = [];
  const sprite = Object.create(prototype) as {
    pending: { anim: string; once: boolean; gen: number } | null;
    gen: number;
    front: number;
    videoA: FakeVideo;
    videoB: FakeVideo;
    assetBase: string;
    pendingSquash: boolean;
    pendingMove: null;
    playback: string | null;
    facing: string;
    pet: { id: string };
    dragState: { active: boolean };
    frozen: boolean;
    switchTo: (next: string, once: boolean, playbackId: string | null, url?: string) => void;
    handleEnded: () => void;
    reportPlayback: (id: string, status: string, reason?: string) => void;
  };
  sprite.pending = null;
  sprite.gen = 0;
  sprite.front = 0;
  sprite.videoA = videoA;
  sprite.videoB = videoB;
  sprite.assetBase = '/dsh-pet-7340/thumb/duck/';
  sprite.pendingSquash = false;
  sprite.pendingMove = null;
  sprite.playback = null;
  sprite.facing = 'left';
  sprite.pet = { id: 'pet-1' };
  sprite.dragState = { active: true };
  sprite.frozen = false;
  sprite.reportPlayback = (id, status, reason) => {
    const hostOutcome = store ? store.report(id, status, reason) : undefined;
    reports.push({ id, status, reason, hostOutcome });
    mark('report', {
      id,
      status,
      reason: reason ?? null,
      hostOutcome: hostOutcome ?? null,
      hostStatus: store ? (store.get(id)?.status ?? null) : null,
      playCalls: videoB.playCalls,
      src: videoB.src,
      playbackField: sprite.playback,
    });
  };
  return { sprite, videoA, videoB, reports };
}

/** 装载真实 playback.js。window.setTimeout 会 unref，避免 10s 兜底把进程钉住。 */
function loadDesktopPrototype(): object {
  const PetSprite = function PetSprite(this: object) {
    /* 探针只借原型，不走构造。 */
  } as unknown as { prototype: object };
  PetSprite.prototype = {};
  const sandbox = {
    PetSprite,
    console,
    S: { ANIMATION_EXT: '.webm' },
    window: {
      setTimeout: (fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
        const id = globalThis.setTimeout(fn, ms, ...rest);
        id.unref?.();
        return id;
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    },
  };
  vm.runInNewContext(readFileSync(resolve(packageRoot, 'runtime/electron-helper/sprite/playback.js'), 'utf8'), sandbox, {
    filename: 'playback.js',
  });
  return PetSprite.prototype;
}

/** 浏览器：第一次加载挂起时插入第二个同名同 once 的编号。 */
async function browserScenario(release: 'success' | 'failure' | 'play-reject', withHost: boolean) {
  const { marks, mark } = createLog();
  const store = withHost ? new PlaybackStore() : undefined;
  const chain = browserChain(mark, store);
  const first = store ? store.create('pet-1', 'idle1') : null;
  const firstId = first?.playbackId ?? 'pb-1';
  if (first) mark('host-create', { id: firstId, status: first.status });
  mark('switch-first', { id: firstId });
  chain.anim.switchTo('idle1', true, firstId);
  mark('after-first-switch', {
    loadRequests: chain.loader.requests.length,
    playCalls: chain.videoB.playCalls,
    src: chain.videoB.src,
    playingField: chain.anim.playingPlayback(),
  });
  const second = store ? store.create('pet-1', 'idle1') : null;
  const secondId = second?.playbackId ?? 'pb-2';
  if (second && first) {
    mark('host-create-second', {
      id: secondId,
      first: snap(store?.get(firstId)),
      second: snap(store?.get(secondId)),
    });
  }
  mark('switch-second', { id: secondId });
  chain.anim.switchTo('idle1', true, secondId);
  mark('after-second-switch', {
    loadRequests: chain.loader.requests.length,
    playCalls: chain.videoB.playCalls,
    src: chain.videoB.src,
    playingField: chain.anim.playingPlayback(),
  });
  let third: ReturnType<PlaybackStore['create']> | null = null;
  if (store) {
    third = store.create('pet-1', 'idle1');
    mark('host-create-third-while-second-playing', {
      third: snap(third),
      second: snap(store.get(secondId)),
      first: snap(store.get(firstId)),
    });
  }
  if (release === 'failure') {
    chain.loader.requests[0]?.handlers.onError(new Error('HTTP 404'));
    mark('load-error-returned', {
      loadRequests: chain.loader.requests.length,
      playCalls: chain.videoB.playCalls,
      playingField: chain.anim.playingPlayback(),
    });
  } else {
    if (release === 'play-reject') chain.videoB.rejectPlay = true;
    chain.loader.requests[0]?.handlers.onObjectUrl('blob:held');
    mark('object-url', { src: chain.videoB.src, playCalls: chain.videoB.playCalls });
    chain.videoB.fire('loadeddata');
    mark('loadeddata-returned', { playCalls: chain.videoB.playCalls, playingField: chain.anim.playingPlayback() });
    await Promise.resolve();
    await Promise.resolve();
    mark('after-play-microtasks', { playCalls: chain.videoB.playCalls, playingField: chain.anim.playingPlayback() });
    if (release === 'success') {
      chain.anim.handleEnded({ currentTarget: chain.videoB } as unknown as Event);
      mark('after-handle-ended', { playingField: chain.anim.playingPlayback() });
    }
  }
  chain.anim.dispose();
  const terminalWait = store ? await waitTerminal(store, secondId) : null;
  const playingWaitImmediate = store
    ? {
        playbackId: secondId,
        status: store.get(secondId)?.status ?? null,
        wouldMatchImmediately: store.get(secondId)?.status === 'playing',
      }
    : null;
  return {
    release,
    withHost,
    marks,
    reports: chain.reports,
    terminalWait,
    playingWaitImmediate,
    records: store
      ? { first: snap(store.get(firstId)), second: snap(store.get(secondId)), third: snap(third ?? undefined) }
      : null,
  };
}

/** 对照：第二次 switchTo 的编号是 null（effect 清编号后再进），不应上报 playing。 */
function browserNullSecond() {
  const { marks, mark } = createLog();
  const chain = browserChain(mark);
  chain.anim.switchTo('idle1', true, 'pb-1');
  mark('switch-null');
  chain.anim.switchTo('idle1', true, null);
  mark('after-null', {
    loadRequests: chain.loader.requests.length,
    reports: chain.reports.length,
    playCalls: chain.videoB.playCalls,
  });
  chain.anim.dispose();
  return { marks, reports: chain.reports };
}

/** 桌面 playback.js：同样把第一次 loadeddata 按住。 */
async function desktopScenario(release: 'success' | 'failure', prototype: object, withHost: boolean) {
  const { marks, mark } = createLog();
  const store = withHost ? new PlaybackStore() : undefined;
  const desk = desktopSprite(prototype, mark, store);
  const first = store ? store.create('pet-1', 'idle1') : null;
  const firstId = first?.playbackId ?? 'pb-1';
  if (first) mark('host-create', { id: firstId, status: first.status });
  mark('switch-first', { id: firstId });
  desk.sprite.switchTo('idle1', true, firstId);
  mark('after-first-switch', {
    src: desk.videoB.src,
    playCalls: desk.videoB.playCalls,
    loadCalls: desk.videoB.loadCalls,
    pending: desk.sprite.pending?.anim ?? null,
  });
  const second = store ? store.create('pet-1', 'idle1') : null;
  const secondId = second?.playbackId ?? 'pb-2';
  if (second && first) {
    mark('host-create-second', {
      id: secondId,
      first: snap(store?.get(firstId)),
      second: snap(store?.get(secondId)),
    });
  }
  mark('switch-second', { id: secondId });
  desk.sprite.switchTo('idle1', true, secondId);
  mark('after-second-switch', {
    src: desk.videoB.src,
    playCalls: desk.videoB.playCalls,
    loadCalls: desk.videoB.loadCalls,
    playbackField: desk.sprite.playback,
  });
  if (release === 'failure') {
    desk.videoB.onerror?.();
    mark('video-error-returned', { playCalls: desk.videoB.playCalls, playbackField: desk.sprite.playback });
  } else {
    desk.videoB.fire('loadeddata');
    mark('loadeddata-returned', { playCalls: desk.videoB.playCalls, playbackField: desk.sprite.playback });
    await Promise.resolve();
    await Promise.resolve();
    mark('after-play-microtasks', { playCalls: desk.videoB.playCalls, playbackField: desk.sprite.playback });
    desk.sprite.handleEnded();
    mark('after-handle-ended', { playbackField: desk.sprite.playback });
  }
  const terminalWait = store ? await waitTerminal(store, secondId) : null;
  return {
    release,
    withHost,
    marks,
    reports: desk.reports,
    terminalWait,
    records: store ? { first: snap(store.get(firstId)), second: snap(store.get(secondId)) } : null,
  };
}

/** 单叶子快照：两次写入落在同一次拉取里时，消费端只能看到后一张。 */
function stateDelivery() {
  const collapsedStore = new PollStateStore();
  const collapsedBaseline = flattenCounters(collapsedStore.read());
  collapsedStore.writePet('pet-1', 'anim', { name: 'idle1', playbackId: 'pb-1' });
  collapsedStore.writePet('pet-1', 'anim', { name: 'idle1', playbackId: 'pb-2' });
  const collapsedChanges = takeChanged(collapsedStore.read(), collapsedBaseline).filter((change) =>
    change.path.endsWith('.anim'),
  );

  const interleavedStore = new PollStateStore();
  const interleavedBaseline = flattenCounters(interleavedStore.read());
  interleavedStore.writePet('pet-1', 'anim', { name: 'idle1', playbackId: 'pb-1' });
  const firstWave = takeChanged(interleavedStore.read(), interleavedBaseline).filter((change) =>
    change.path.endsWith('.anim'),
  );
  interleavedStore.writePet('pet-1', 'anim', { name: 'idle1', playbackId: 'pb-2' });
  const secondWave = takeChanged(interleavedStore.read(), interleavedBaseline).filter((change) =>
    change.path.endsWith('.anim'),
  );

  const describe = (changes: typeof collapsedChanges) =>
    changes.map((change) => ({ path: change.path, cue: readAnim(change.leaf) }));

  return {
    collapsed: { changeCount: collapsedChanges.length, changes: describe(collapsedChanges) },
    interleaved: {
      firstWave: describe(firstWave),
      secondWave: describe(secondWave),
    },
  };
}

/** 活进程缺口：不启动 Electron，也不把 mock 宿主当成点播链路。 */
function realPathBlockers() {
  const blockers: string[] = [];
  let dsh = '';
  try {
    dsh = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
  } catch {
    dsh = '';
    blockers.push('PATH 上没有 dsh，无法把插件装进 DeepSeek Harness 再发 POST /anim');
  }
  const mockSrc = readFileSync(resolve(packageRoot, 'scripts/dev/mock-server.mjs'), 'utf8');
  const mockHasAnim = mockSrc.includes('/dsh-pet-7340/anim');
  if (!mockHasAnim) {
    blockers.push('scripts/dev/mock-server.mjs 没有 POST /anim 与 /playback 上报，启动它不能走点播链路');
  }
  blockers.push('node_modules 不存在，Electron 与插件依赖未安装；未启动桌面 Helper');
  blockers.push('没有浏览器页面，也没有真实 HTMLVideoElement；play() 兑现不等于屏幕像素，本探针也不观察像素');
  return {
    reproduced: false,
    display: process.env.DISPLAY ?? null,
    wayland: process.env.WAYLAND_DISPLAY ?? null,
    dsh: dsh || null,
    mockHasAnim,
    blockers,
  };
}

/** 第二个编号在 play() 之前就出现 playing，且之后没有任何终态回执。 */
function summarize(reports: Array<{ id: string; status: string }>, secondId: string, playCallsAtPlaying: number) {
  const secondReports = reports.filter((item) => item.id === secondId);
  const terminals = secondReports.filter((item) => item.status === 'ended' || item.status === 'failed' || item.status === 'cancelled');
  const premature = secondReports.some((item) => item.status === 'playing') && playCallsAtPlaying === 0;
  return {
    prematurePlayingBeforePlay: premature,
    secondTerminalCount: terminals.length,
    secondStatuses: secondReports.map((item) => item.status),
  };
}

const browserModuleSuccess = await browserScenario('success', false);
const browserModuleFailure = await browserScenario('failure', false);
const browserModuleReject = await browserScenario('play-reject', false);
const browserNull = browserNullSecond();
const browserHostSuccess = await browserScenario('success', true);
const browserHostFailure = await browserScenario('failure', true);

const desktopPrototype = loadDesktopPrototype();
const desktopModuleSuccess = await desktopScenario('success', desktopPrototype, false);
const desktopModuleFailure = await desktopScenario('failure', desktopPrototype, false);
const desktopHostSuccess = await desktopScenario('success', desktopPrototype, true);
const desktopHostFailure = await desktopScenario('failure', desktopPrototype, true);
const delivery = stateDelivery();
const realPath = realPathBlockers();

const browserSuccessSecond = browserModuleSuccess.reports.find((item) => item.status === 'playing');
const result = {
  commit: 'e821ddccdef5dd24c2663c163e0b62d15b0646a5',
  node: process.version,
  levels: {
    browserModule: 'in-process createOwnAnimation，加载器由探针挂起',
    desktopModule: 'in-process 执行 runtime/electron-helper/sprite/playback.js',
    hostComposition: '同一进程里把回执送进真实 PlaybackStore；没有 HTTP',
    stateDelivery: '真实 PollStateStore + takeChanged；没有长轮询连接',
    liveProcess: '未跑',
  },
  browserModule: {
    success: browserModuleSuccess,
    failure: browserModuleFailure,
    playReject: browserModuleReject,
    nullSecondDoesNotReport: browserNull,
    summary: {
      success: summarize(
        browserModuleSuccess.reports,
        'pb-2',
        Number(
          browserModuleSuccess.marks.find((item) => item.event === 'report' && item.detail?.id === 'pb-2')?.detail
            ?.playCalls ?? -1,
        ),
      ),
      failure: summarize(
        browserModuleFailure.reports,
        'pb-2',
        Number(
          browserModuleFailure.marks.find((item) => item.event === 'report' && item.detail?.id === 'pb-2')?.detail
            ?.playCalls ?? -1,
        ),
      ),
    },
  },
  desktopModule: {
    success: desktopModuleSuccess,
    failure: desktopModuleFailure,
    summary: {
      success: summarize(
        desktopModuleSuccess.reports,
        'pb-2',
        Number(
          desktopModuleSuccess.marks.find((item) => item.event === 'report' && item.detail?.id === 'pb-2')?.detail
            ?.playCalls ?? -1,
        ),
      ),
      failure: summarize(
        desktopModuleFailure.reports,
        'pb-2',
        Number(
          desktopModuleFailure.marks.find((item) => item.event === 'report' && item.detail?.id === 'pb-2')?.detail
            ?.playCalls ?? -1,
        ),
      ),
    },
  },
  hostComposition: {
    browserSuccess: browserHostSuccess,
    browserFailure: browserHostFailure,
    desktopSuccess: desktopHostSuccess,
    desktopFailure: desktopHostFailure,
  },
  stateDelivery: delivery,
  realPath,
  contract: {
    openApiPlayingMeans: 'play() 兑现，不是设了 src，也不是屏幕像素',
    existingTestExpectsPrematurePlaying: true,
    existingTestFile: 'src/client/pet/animation/animation.test.ts:182-190',
    firstPrematureReport: browserSuccessSecond ?? null,
    claimRuntimeVulnerability: false,
  },
};

mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(logPath, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(logPath + '\n');
process.stdout.write(
  JSON.stringify(
    {
      browserSuccess: result.browserModule.summary.success,
      browserFailure: result.browserModule.summary.failure,
      desktopSuccess: result.desktopModule.summary.success,
      desktopFailure: result.desktopModule.summary.failure,
      hostBrowserSuccessRecords: browserHostSuccess.records,
      hostBrowserSuccessTerminalWait: browserHostSuccess.terminalWait,
      hostBrowserFailureRecords: browserHostFailure.records,
      hostBrowserFailureTerminalWait: browserHostFailure.terminalWait,
      stateDelivery: delivery,
      realPathReproduced: realPath.reproduced,
    },
    null,
    2,
  ) + '\n',
);
