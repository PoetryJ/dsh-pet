# 隔离验证脚本

本目录不参与插件构建，也不被 `npm test` 收集（测试只匹配 `src/**/*.test.ts`）。脚本只调用现有模块，不修改产品代码，也不修改既有测试的预期。

退出码 0 表示这次取证跑完。它不表示行为符合 OpenAPI。结论在日志的 `contract` 与 `realPath` 字段。

```sh
cd dsh-pet
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/verify/playback-dedup-probe.ts
```

日志写到 `docs/investigation/logs/playback-dedup-probe.json`。

既有相关测试（本轮原样跑过，122 通过 / 0 失败）：

```sh
node --experimental-strip-types --import ./scripts/test-register.mjs --test \
  src/client/pet/animation/animation.test.ts \
  src/client/pet/playback-report.test.ts \
  src/host/playback.test.ts \
  src/host/anim.test.ts \
  src/shared/state.test.ts
```
