# 运行文档：如何把 DealFlow 跑起来

面向「部署与运行」：环境准备 → 配置 → 启动 → 验证 → 关闭 → 排障。
日常业务操作（投事件、审批、异常、对账）见 `docs/operations.md`；生产部署细节（systemd、安全、备份策略）见 `docs/deployment.md`。

## 1. 环境要求

| 项 | 要求 | 出处 |
| --- | --- | --- |
| Node.js | `22.22.0`（`engines.node: >=22.22.0`，`.nvmrc` / `.node-version` 固定同值） | `package.json:15-17` |
| 包管理 | npm（仓库带 `package-lock.json`） | 仓库根目录 |
| 依赖 | 运行时仅 `zod`；devDeps：`typescript`、`vitest`、`@types/node` | `package.json:18-25` |
| 数据库 | Node 内置 `node:sqlite`（实验特性，无需额外 flag） | `src/stores/sqlite-db.ts` |

```bash
nvm install && nvm use      # 或自行安装 22.22.0
node --version              # 期望 v22.22.0
```

启动时 `checkRuntime()`（`src/app/runtime.ts`）会先校验版本，不足则打 `dealflow.runtime.unsupported` 并以退出码 1 结束，不会带病启动。

**没有构建步骤**：源码直接被执行。`scripts/register.mjs` 注册 `scripts/ts-resolve.mjs` 解析钩子，把无扩展名的相对导入补全为 `.ts`，因此不需要打包器。

## 2. 安装

```bash
npm ci        # 生产/CI，按 lockfile 精确安装
# 或 npm install
```

安装完成后 `npm run typecheck` + `npm run test:run` 是最快的「可运行性」验证（当前基线：49 个测试文件 / 642 个测试）。

## 3. 配置

配置全部来自环境变量，由 `src/config/config.ts` 用 Zod 校验并补默认值；未设置或空串一律回退默认值，非法值**启动即失败**（不静默回退）。

### 3.1 `.env` 加载

三个 npm 脚本（`start` / `dev` / `backup`）都带 `--env-file-if-exists=.env`：

- 仓库根目录存在 `.env` 就自动加载；不存在则忽略；
- **进程环境中已有的变量优先于 `.env`**；
- 完整注释示例见 `.env.example`（复制为 `.env` 即可改）；
- 用 systemd / 容器部署时仍建议由 `EnvironmentFile` / `env_file` 注入。

> 注意：`docs/deployment.md` 第 79 行「`.env` 不会被进程自动加载」是旧说法，以本节与 `package.json:8-10` 为准。

### 3.2 环境变量（按用途分组）

完整表与语义见 `docs/deployment.md` 第 3 节，这里只列运行时最常动的：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEALFLOW_HOST` | `127.0.0.1` | 监听地址；对外暴露改 `0.0.0.0` |
| `DEALFLOW_PORT` | `3000` | 监听端口；`0` = 系统分配空闲端口（测试用） |
| `DEALFLOW_DB_PATH` | `data/dealflow.db` | SQLite 路径，目录自动创建 |
| `DEALFLOW_WEBHOOK_PATH` | `/webhooks/dealflow` | 事件接收路径 |
| `DEALFLOW_WEBHOOK_TOKEN` | 空 | Webhook Bearer Token；空 = 不校验 |
| `DEALFLOW_WEBHOOK_HMAC_SECRET` | 空 | HMAC-SHA256 密钥；空 = 不校验签名 |
| `DEALFLOW_CONTROL_PLANE_TOKEN` | 空 | 控制面 Token；空则回退 `DEALFLOW_WEBHOOK_TOKEN`；**两者都空 → 控制面 404** |
| `DEALFLOW_LOG_LEVEL` | 空（全输出） | `debug/info/warn/error`；设 `warn` 可关掉每请求的 `http.access` |
| `DEALFLOW_RETRY_ENABLED` | `true` | 失败实例自动重试调度器 |
| `DEALFLOW_PROVIDER_KIND` | `in-memory` | `in-memory`（本地）或 `http`（需 `DEALFLOW_PROVIDER_BASE_URL`） |

取值约定：数字非数字 → `ConfigEnvError`；布尔只接受 `true/false/1/0/yes/no/on/off`（大小写不敏感）；限流变量 `0` 表示**不限流**（转成 `null`，不是回退默认值）；未在 `loadConfigFromEnv` 中列出的 `DEALFLOW_*` 名字会被**静默忽略**（拼错变量名不报错）。

## 4. 启动

| 命令 | 用途 |
| --- | --- |
| `npm run start` | 前台运行（生产） |
| `npm run dev` | `--watch`，改动自动重启（开发） |
| `npm run backup` | SQLite 一致性备份（见第 8 节） |

```bash
npm run start
# 等价于
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env \
  --experimental-transform-types --import ./scripts/register.mjs src/main.ts
```

临时改端口/库路径不必改 `.env`：

```bash
DEALFLOW_PORT=3199 DEALFLOW_DB_PATH=data/smoke.db npm run start
```

### 4.1 启动顺序（`src/main.ts` → `src/app/bootstrap.ts`）

| # | 步骤 | 失败表现 |
| --- | --- | --- |
| 1 | `checkRuntime()` 校验 Node 版本 | `dealflow.runtime.unsupported`，退出码 1 |
| 2 | `loadConfigFromEnv()` 读取并校验配置 | `dealflow.start.failed`，退出码 1 |
| 3 | 装配：建库目录 → 打开 SQLite（WAL、建表建索引）→ 9 个 Store → Engine → Executor → RetryScheduler → HTTP handler | 同上（如 `provider.kind=http` 缺 `base_url` 直接抛错） |
| 4 | 注册 `SIGTERM`/`SIGINT` 处理器 | — |
| 5 | `recoverOnStart()` **先恢复再接流量** | 见第 5 节 |
| 6 | `server.listen()` → 启动 RetryScheduler | `dealflow.start.failed` |
| 7 | 打 `dealflow.started` + `dealflow.ready` | — |

### 4.2 启动成功日志

单行 JSON，写 stdout：

```json
{"timestamp":"…","level":"info","message":"dealflow.recovery.pending","pending":7,"reprocessed":0,"skipped_blocked":7,"failed":0}
{"timestamp":"…","level":"info","message":"dealflow.started","host":"127.0.0.1","port":3000,"workflow_type":"lead_follow_up","webhook_path":"/webhooks/dealflow","database_path":"data/dealflow.db","retry_scheduler":true}
{"timestamp":"…","level":"info","message":"dealflow.ready","url":"http://127.0.0.1:3000"}
```

出现 `dealflow.ready` 即可认为启动成功。

## 5. 启动恢复（recoverOnStart）

`src/main.ts:36-39` 在监听之前执行，三种分支：

| 条件 | 行为 | 日志 |
| --- | --- | --- |
| 事件表为空 | 直接返回 | 无 |
| State 为空但事件非空（只恢复了事件日志） | 按 `sequence` 重放重建 State，**重放期间不调用外部 Executor**，不会产生二次副作用 | `dealflow.recovery.replayed` |
| 正常重启 | 只重投 `processing_status='pending'` 且没有 open 异常的事件 | `dealflow.recovery.pending` |

孤儿租约（上次崩溃留下的处理中事件）走延迟重投：`dealflow.recovery.deferred`（warn）→ 每 5s 一次、最多 8 次 → `deferred.settled` / `deferred.give_up`。

已有未处理异常的事件**不会**自动重投，交人工走控制面（见操作文档第 7 节），避免每次启动重复刷异常。

## 6. 运行时验证

```bash
# 1) 存活探针（无鉴权、不限流）
curl -s http://127.0.0.1:3000/healthz
# → {"status":"ok"}

# 2) 运行时快照
curl -s http://127.0.0.1:3000/metrics
# → {"counters":{…},"workflows_by_status":{…},"open_exceptions":0,"total_exceptions":1,"audit_entries":137}

# 3) 类型与测试
npm run typecheck
npm run test:run

# 4) 一键验收（typecheck + 单测 + 起干净实例 + 走查 + 单实例断言）
npm run accept
```

CI 跑的就是同一个入口：`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `windows-latest` 上执行
`npm ci && npm run accept`，并把 `acceptance/report-*.json` 作为构建产物上传。

`/metrics` 在 `DEALFLOW_OBSERVABILITY_ENABLED=false` 时返回 `404 {"error":"metrics disabled"}`。

## 7. 关闭

| 动作 | 结果 |
| --- | --- |
| 第一次 `SIGTERM` / `SIGINT`（Ctrl+C） | `dealflow.shutdown.signal` → 优雅关闭 → `dealflow.shutdown.complete`，退出码 **0** |
| 第二次信号 | `dealflow.shutdown.forced`（warn）→ 100ms 后强制退出，退出码 **1** |

优雅关闭顺序（`Application.shutdown`，幂等）：

1. 停 RetryScheduler、清延迟重投定时器；
2. `server.close()` + `closeIdleConnections()`，超过 `DEALFLOW_SHUTDOWN_GRACE_MS`（默认 10000ms）则 `closeAllConnections()` 强制断连；
3. 用 `DEALFLOW_SHUTDOWN_ABORT_GRACE_MS`（默认 5000ms）作为**总预算**，依次等待：进行中的恢复 → 延迟重投 → 在途请求处理完；
4. 关闭 SQLite 连接，写 `dealflow.shutdown.complete`。

外部编排器（systemd `TimeoutStopSec`、容器 stop timeout）的超时必须 **> grace_ms + abort_grace_ms**，否则进程会被强杀。示例见 `docs/deployment.md` 第 4 节。

## 8. 备份

```bash
npm run backup                                              # 库路径取 DEALFLOW_DB_PATH，产物到 <库目录>/backups/<库名>-<时间戳>.db
npm run backup -- --db data/dealflow.db --out data/backups/manual.db
```

- 实现是 `VACUUM INTO`（`src/runtime/backup.ts`）：单读事务一致性快照，**不停机**、不阻塞写；
- 目标文件已存在则拒绝覆盖（退出码 1）；成功输出单行 `dealflow.backup.completed` JSON（含 `bytes`）；
- **不要直接拷贝 `.db` 文件**（可能拿到撕裂快照）；必须拷贝时先停进程并连同 `-wal`/`-shm` 一起复制。

恢复步骤与演练建议见 `docs/deployment.md` 第 7 节。

## 9. 数据与存储

- 单库单连接：进程内所有 Store 复用一个 `SqliteDatabase`（WAL 模式），一次事件处理的写入合并为单事务（`SqliteUnitOfWork`）。
- **同一个数据库文件不要被多个进程同时写入**。
- 表：`events`（追加式事件日志 + 处理状态 + 租约）、`audit_log`（只追加）、`exceptions`、`workflows`、`entity_states`（Lead/Contact/Deal/memory/pending_action 共用）。DDL 见 `src/stores/sqlite-db.ts:48-126`。
- `DEALFLOW_DB_PATH=:memory:` 可用，但**不跨重启**，只适合一次性试验。
- 没有环境变量能切换存储后端：生产装配固定用 SQLite，InMemory 实现仅供测试与注入（`src/stores/in-memory.ts`）。

## 10. 故障排查

| 现象 | 排查 |
| --- | --- |
| 启动即退出、无 `dealflow.ready` | 看 `dealflow.start.failed` 的 `error` 字段：配置非法（`ConfigEnvError`/Zod）、端口占用、`provider.kind=http` 缺 `base_url` |
| 日志有 `dealflow.runtime.unsupported` | Node 版本低于 22.22.0 |
| `ExperimentalWarning: SQLite is an experimental feature` | 正常（npm 脚本已抑制，直接跑 `node` 时会出现） |
| 控制面全 404 | `DEALFLOW_CONTROL_PLANE_TOKEN` 与 `DEALFLOW_WEBHOOK_TOKEN` 都为空 → 控制面按设计不注册 |
| 控制面 401 | Token 不对；注意回退关系（control plane token 优先） |
| 429 | Webhook 与控制面是**独立限流桶**，分别调 `…RATE_LIMIT_PER_MINUTE`；`0` = 不限流 |
| 启动后旧数据不见了 | 确认 `.env` 是否被加载、`DEALFLOW_DB_PATH` 是否被进程环境变量覆盖（进程环境优先） |
| 重启后大量 `dealflow.recovery.deferred` | 上次非正常退出留下处理中租约；正常会自动收敛，反复出现则查崩溃原因 |
| 实例停在 `failed` 不重试 | `permanent` 或 `submitted='unknown'` **按设计不自动重试**：前者等人改输入，后者必须先对账 |
| 备份报「备份目标已存在」 | 换 `--out` 文件名或删旧备份，设计上拒绝覆盖 |

## 11. 相关文档

| 文档 | 内容 |
| --- | --- |
| `docs/operations.md` | 日常操作：投事件、看板、审批、异常、对账、巡检 |
| `docs/deployment.md` | 生产部署：安全链路、systemd、备份策略、检查清单 |
| `docs/runtime.md` | 配置、Provider Adapter、Webhook、观测的实现说明 |
| `docs/domain.md` / `docs/events.md` / `docs/state-machine.md` | 领域模型、事件字典、状态机 |
| `docs/decision-policy.md` | Decision 与 Policy 的判定规则 |
| `docs/sales-daily-feedback.md` | 端到端走查记录与已知问题 |
| `docs/acceptance-single-instance.md` | 单实例验收：一个 Lead 跑完闭环的断言与判定基准 |
