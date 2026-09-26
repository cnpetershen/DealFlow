# Deployment

## 1. 固定 Node.js 版本

本项目**直接运行 TypeScript 入口**，依赖两项 Node 内置能力，因此固定版本：

| 文件 | 值 |
| --- | --- |
| `.nvmrc` | `22.22.0` |
| `.node-version` | `22.22.0` |
| `package.json` → `engines.node` | `>=22.22.0` |

```bash
nvm install    # 读取 .nvmrc
nvm use
node --version # 期望 v22.22.0
```

启动时会调用 `checkRuntime()`（`src/app/runtime.ts`）做一次校验，版本不足直接 fail fast 并以退出码 1 结束，不会带着不完整的运行时启动。

### 为什么需要这个版本

1. **`--experimental-transform-types`**（Node 22.7.0+）：源码使用了参数属性（如 `constructor(readonly actionId: string)`）等需要代码生成的语法，仅靠类型擦除不够。
2. **`node:sqlite` 无需额外 flag**：在 22.22.0 上已验证 `require('node:sqlite')` 可直接加载（仅输出 ExperimentalWarning）。

### 为什么不需要构建步骤

源码使用 `moduleResolution: Bundler` 风格的无扩展名相对导入，Node 原生 ESM 解析器不接受。项目用一个 20 行的解析钩子补全扩展名，从而省掉打包器：

- `scripts/ts-resolve.mjs`：把 `./x` 解析为 `./x.ts` / `./x/index.ts`，其余说明符交给默认解析。
- `scripts/register.mjs`：通过 `node:module` 的 `register()` 注册该钩子。

## 2. `node:sqlite` 运行要求

- **模块**：`node:sqlite`（Node 内置），通过 `createRequire(import.meta.url)` 加载，避免打包器把它错误解析成 npm 包。
- **状态**：在 Node 22 上标记为 experimental，启动与本项目测试中会输出
  `ExperimentalWarning: SQLite is an experimental feature`。这是预期行为，`npm run start` / `npm run dev` / `npm run backup` 已通过 `--disable-warning=ExperimentalWarning` 抑制该噪声。
- **不需要** `--experimental-sqlite` flag（22.22.0 已验证）。
- **升级 Node 时必须回归** `src/stores` 下全部测试：`node:sqlite` 的 API 仍可能变动。
- **单写者**：SQLite 同一时刻只允许一个写事务。同一进程内所有 Store 复用同一个 `SqliteDatabase` 连接，一次处理的写入由 `SqliteUnitOfWork` 合并为单一事务（见 `docs/domain.md` 与 `src/stores/unit-of-work.ts`）。**同一数据库文件不要被多个进程同时写入**。

## 3. 配置

配置全部来自环境变量，未设置项使用确定性默认值（`src/config/config.ts`）。环境变量只承载部署参数，不承载业务规则。完整示例见 `.env.example`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEALFLOW_HOST` | `127.0.0.1` | 监听地址；对外暴露时按需改为 `0.0.0.0` |
| `DEALFLOW_PORT` | `3000` | 监听端口 |
| `DEALFLOW_MAX_CONNECTIONS` | `512` | 并发连接上限，超出的连接被直接拒绝 |
| `DEALFLOW_DB_PATH` | `data/dealflow.db` | SQLite 业务库路径（目录会自动创建） |
| `DEALFLOW_DB_TIMEOUT_MS` | `5000` | SQLite 写锁忙等待超时 |
| `DEALFLOW_SHUTDOWN_GRACE_MS` | `10000` | 优雅关闭宽限期，超时强制断开剩余连接 |
| `DEALFLOW_SHUTDOWN_ABORT_GRACE_MS` | `5000` | 关闭阶段等待数据库/文件 IO 收尾的硬上限，须小于外部超时 |
| `DEALFLOW_WORKFLOW_TYPE` | `lead_follow_up` | Workflow 类型 |
| `DEALFLOW_WEBHOOK_PATH` | `/webhooks/dealflow` | 事件接收路径 |
| `DEALFLOW_WEBHOOK_MAX_BODY_BYTES` | `1000000` | 请求体上限 |
| `DEALFLOW_WEBHOOK_TOKEN` | 空 | Bearer Token；空表示不校验 |
| `DEALFLOW_WEBHOOK_HMAC_SECRET` | 空 | HMAC-SHA256 共享密钥；空表示不校验签名 |
| `DEALFLOW_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS` | `300` | 签名时间戳容忍窗口 |
| `DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE` | `600` | 每个来源每分钟请求上限（0 表示不限流） |
| `DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS` | `false` | 处在可信代理之后时用 `X-Forwarded-For` 作为限流来源；直连场景保持 `false`，否则客户端可伪造地址绕过限流 |
| `DEALFLOW_CONTROL_PLANE_ENABLED` | `true` | 是否暴露控制面路由 |
| `DEALFLOW_CONTROL_PLANE_TOKEN` | 空 | 控制面 Bearer Token；空则回退使用 `DEALFLOW_WEBHOOK_TOKEN`；两者都为空时控制面不暴露（404） |
| `DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE` | `120` | 控制面独立限流额度（0 表示不限流）；与 Webhook 分桶，避免一次 Webhook 突发把审批入口一起打成 429 |
| `DEALFLOW_OBSERVABILITY_ENABLED` | `true` | `/metrics` 是否可用 |
| `DEALFLOW_LOG_LEVEL` | 空 | 日志最低级别 `debug/info/warn/error`；设为 `warn` 可关掉每请求一条的 `http.access` 访问日志 |
| `DEALFLOW_RETRY_ENABLED` | `true` | 是否启用失败实例自动重试调度器 |
| `DEALFLOW_RETRY_INTERVAL_MS` | `30000` | 重试调度扫描周期 |
| `DEALFLOW_RETRY_MAX_ATTEMPTS` | `3` | 同一实例连续自动重试上限，超过后停止并告警 |
| `DEALFLOW_RETRY_MAX_BACKOFF_MS` | `300000` | 重试指数退避上限 |
| `DEALFLOW_PROVIDER_KIND` | `in-memory` | `in-memory`（本地）或 `http`（真实提供商） |
| `DEALFLOW_PROVIDER_BASE_URL` | 空 | `kind=http` 时必填 |
| `DEALFLOW_PROVIDER_TOKEN` | 空 | 提供商 Bearer Token |
| `DEALFLOW_PROVIDER_TIMEOUT_MS` | `5000` | 提供商请求超时 |

`kind=http` 但缺少 `base_url` 时启动即失败，避免静默退回本地实现。

> 注意：`.env` 不会被进程自动加载，请由进程管理器（systemd `EnvironmentFile`、容器 `env_file`、`dotenv -e` 等）注入。

## 4. 启动与优雅关闭

```bash
npm ci
npm run start          # 前台运行（生产）
npm run dev            # --watch，改动自动重启（开发）
```

| 脚本 | 命令 |
| --- | --- |
| `npm run start` | `node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register.mjs src/main.ts` |
| `npm run dev` | 同上，追加 `--watch src/main.ts` |
| `npm run backup` | `... src/tools/backup.ts`（见第 7 节） |

关闭流程（`src/app/signals.ts` + `Application.shutdown`）：

1. 收到 `SIGTERM` / `SIGINT`，记录 `dealflow.shutdown.signal`。
2. `server.close()` 停止接收新连接，`closeIdleConnections()` 释放空闲 keep-alive 连接，等待在途请求处理完毕。
3. 超过 `grace_ms` 仍有关闭未完成的连接时调用 `closeAllConnections()` 强制断开。
4. 关闭 SQLite 连接。
5. 写入 `dealflow.shutdown.complete`，以退出码 `0` 结束。
6. 再次收到信号表示运维希望立即终止，直接以退出码 `1` 退出，且不再覆盖为成功码。

`shutdown()` 是幂等的，重复调用共享同一次关闭。

systemd 示例：

```ini
[Service]
Type=simple
WorkingDirectory=/srv/dealflow
EnvironmentFile=/srv/dealflow/.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=20s
User=dealflow
```

## 5. 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 存活探针，返回 `{"status":"ok"}` |
| `GET` | `/metrics` | 运行时观测快照（计数器 + Workflow/异常/审计 gauges） |
| `POST` | `<DEALFLOW_WEBHOOK_PATH>` | 接收事件 |
| `GET` | `/workflows` | 控制面：列出实例（可用 `?status=` 过滤），含待审批动作 |
| `GET` | `/workflows/{id}` | 控制面：实例详情 + 当前待审批 `action_id` |
| `POST` | `/workflows/{id}/approve` | 控制面：`{action_id, actor_id}` 批准并交 Executor 执行；动作已失效时改为作废并重新规划（响应 `stale_action_replanned`） |
| `POST` | `/workflows/{id}/reject` | 控制面：`{action_id, actor_id, reason}` 拒绝并基于新约束重新规划 |
| `POST` | `/workflows/{id}/replan` | 控制面：`{actor_id?}` 作废待审动作并按当前 State 重新规划（不写批准/拒绝结论） |
| `POST` | `/workflows/{id}/cancel` | 控制面：`{actor_id}` 取消实例 |
| `POST` | `/workflows/{id}/retry` | 控制面：重试失败实例（分类与 `submitted` 由引擎判定） |
| `POST` | `/workflows/{id}/reconcile` | 控制面：`{actor_id}` 对 Provider 对账，确认不确定提交是否真的落到提供商侧 |
| `GET` | `/leads` | 控制面销售读端点：列出线索（`?owner_id=&status=&limit=&offset=`），返回 `{items, count, total, has_more, limit, offset}` |
| `GET` | `/leads/{id}` | 控制面销售读端点：单条线索当前事实，不存在回 `404` |
| `GET` | `/deals` | 控制面销售读端点：列出售机（`?owner_id=&stage=&lead_id=&limit=&offset=`），响应结构同 `/leads` |
| `GET` | `/deals/{id}` | 控制面销售读端点：单条商机当前事实，不存在回 `404` |
| `GET` | `/audit` | 控制面：审计查询（`?workflow_instance_id=&event_id=&action_id=&limit=&order=`） |
| `GET` | `/exceptions` | 控制面：异常队列（默认 `status=open`，可 `status=all`） |
| `POST` | `/exceptions/{id}/resolve` | 控制面：`{resolution, reason?, actor_id?}` 标记已处理并写审计 |
| `POST` | `/exceptions/{id}/discard` | 控制面：`{resolution, reason?, actor_id?}` 标记丢弃并写审计 |
| `POST` | `/exceptions/{id}/replay` | 控制面：`{resolution, reason?, actor_id?}` 把原始事件副本交回正常 Workflow 路径 |

`POST` 返回码：`200`（`processed` / `duplicate` / `unmatched` / `failed`）、`409`（`conflict` 或签名重放）、`400`（报文非法）、`401`（认证失败）、`413`（超大）、`429`（限流）。

`/healthz` 与 `/metrics` 不参与限流。`/metrics` 在 `observability.enabled=false` 时返回 `404`。

### 控制面鉴权与可用性

控制面承载人工审核（`approve` / `reject`）与异常处理，**必须配置 Token 才启用**：

- `DEALFLOW_CONTROL_PLANE_TOKEN` 优先；为空时回退 `DEALFLOW_WEBHOOK_TOKEN`；
- 两者都为空时控制面路由不注册（返回 `404`），避免出现「默认无鉴权的审批入口」；
- 控制面不做 HMAC 签名校验，也不参与 Webhook 限流，建议只在内网或 VPN 内暴露；
- 人工审核流程：`GET /workflows?status=needs_review` 取 `pending_action.action_id` → `POST /workflows/{id}/approve`。
  批准前引擎会按 `docs/decision-policy.md`「Approved」第 2 条重新校验动作是否已过期、是否已被新事件取代
  （主体进入终态、联系人退订、`plan_version` 不一致等）：命中即判定动作失效，引擎作废旧动作、
  写 `action_stale` 审计并按当前 State 重新规划，实例离开 `needs_review`，响应 `stale_action_replanned: true`；
  需要人工主动作废待审动作时用 `POST /workflows/{id}/replan`（审计记 `replan_requested`）。
  两者都不写拒绝结论，因此同一动作类型仍可被重新提出。

## 5.1 启动恢复

`src/main.ts` 在开始监听之前调用 `Application.recoverOnStart()`：

1. State Store 为空而事件日志非空（例如只恢复了事件日志）：按 `sequence` 重放全部事件重建 State，
   重放期间不调用 Executor，不会产生第二次外部副作用；
2. 否则只重投仍为 `pending` 的事件（上次处理中途崩溃），复用同一 `idempotency_key`；
3. 已经有未处理异常的事件不再自动重投，交给人工通过控制面处理，避免每次启动重复刷异常。

恢复结果以 `dealflow.recovery.*` 日志输出，可通过 `GET /metrics` 的 `workflows_by_status` / `open_exceptions` 核对。

`GET /audit`、`GET /workflows`、`GET /exceptions` 均受分页约束：默认 200 条、上限 1000 条，响应带 `has_more`。
`/audit` 支持 `order=asc|desc`（默认 `desc`，最近在前）。控制面是运维接口，不能把整张表构造成响应。

### 5.2 失败实例自动重试

`failure_classification` / `failure_submitted` / `failure_retry_after` 会持久化在 WorkflowInstanceState 上，
`RetryScheduler`（`src/runtime/retry-scheduler.ts`）按周期读取它们：

| 情况 | 行为 |
| --- | --- |
| `permanent` | 不自动重试，等人工修正输入 |
| `submitted === 'unknown'` | **不自动重试**，必须先做 provider 对账（见 5.3） |
| `failure_retry_after` 未到 | 按提供商建议的时间等待 |
| `transient` 且未到退避时间 | 跳过本轮 |
| 连续失败达到 `max_attempts_per_workflow` | 停止自动重试并输出 `dealflow.retry.exhausted` 告警 |
| 重试成功 | 输出 `dealflow.retry.succeeded`，并清空退避计数 |

调度器在 `Application.start()` 中启动（在启动恢复之后）、在 `shutdown()` 中最先停止；
定时器已 `unref()`，不会阻止进程退出。它只在单实例内工作：多实例部署时每个进程都会尝试重试同一实例，
但引擎侧的事件处理租约与 `retry` 的在途去重保证不会产生第二次业务效果。

### 5.3 Provider 对账（`submitted === 'unknown'`）

超时/连接中断时无法判断提供商是否已经接受了动作，此时**禁止简单 retry**：
`POST /workflows/{id}/reconcile` 先向提供商确认，再按结论分支（实现见 `WorkflowEngine.reconcile`）：

| 对账结论 | Workflow 落点 | 是否再次调用外部 |
| --- | --- | --- |
| `submitted = true` | `waiting_result`（恢复为「已派发、等待结果」） | 否，副作用已经发生 |
| `submitted = false` | 用**原 `execution_idempotency_key`** 重新派发 | 是，但 key 不变，提供商侧会去重 |
| `submitted = 'unknown'`（或对账请求本身失败） | 保持 `failed` + 写入异常队列转人工 | 否，绝不允许猜测后重试 |

- 只有 `status = failed` 且 `failure_submitted = 'unknown'` 的实例可对账，其余返回 `409`；
- 同一实例的并发对账合并为一次外部调用；
- 失败动作的完整快照从 `pending_action` 存储取回、`action_id` 来自 `action_failed` 审计，
  两者都是持久化事实，因此**重启后仍可对账**；
- 每次对账都追加 `action_reconciled` 审计，含操作者、对账结论与提供商回执快照。

### 5.4 异常处理与重放

`resolve` / `discard` / `replay` 三个入口都会写入只追加审计
（`exception_resolved` / `exception_discarded` / `exception_replayed`），审计通过 `exception_id`
与异常记录关联，并记录操作者、结论原因、前后状态与 `occurred_at`；异常记录本身保存
`resolution` / `resolved_by` / `resolved_at`。

`replay` 把异常记录里保存的**原始事件信封副本**重新交给正常 Workflow 路径（`handleEvent`），因此：

- 原始 Event 不可变：重放使用的是副本，事件本身没有被改写；
- 幂等：事件存储按 `idempotency_key` 去重，已生效的事件只会返回 `duplicate`，不产生重复业务效果；
- 已 `discarded` 的异常拒绝重放（丢弃即明确判定该输入不应产生业务效果），返回 `409`；
- 重放后事件仍被状态机拒绝（例如前置条件没修好）时，异常保持 `open`，审计记为 `failed`，人工可继续处理或丢弃。


## 6. Webhook 生产安全

按顺序执行四道防线，全部为进程内实现，**不需要 Redis 等外部基础设施**：

1. **限流**：固定窗口计数，按来源地址（`socket.remoteAddress`）计数，超限返回 `429` 并带 `Retry-After`。记录有上限，超出后按窗口清理。
2. **Bearer Token**：配置 `DEALFLOW_WEBHOOK_TOKEN` 后校验 `Authorization: Bearer <token>`。
3. **HMAC 签名 + 时间戳窗口**：配置 `DEALFLOW_WEBHOOK_HMAC_SECRET` 后校验两个请求头：

   ```text
   X-Dealflow-Timestamp: <unix 秒>
   X-Dealflow-Signature: sha256=<hex>
   ```

   签名载荷为 `${timestamp}.${body}`（时间戳参与签名，防止替换时间戳绕过窗口），
   使用 `timingSafeEqual` 定长比较。时间戳偏离当前时间超过 `DEALFLOW_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS` 即拒绝。
4. **重放保护**：签名指纹在容忍窗口内只接受一次，重复投递返回 `409 replayed signature`。

签名示例（Node）：

```js
import { createHmac } from 'node:crypto';

const timestamp = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify(event);
const signature = 'sha256=' + createHmac('sha256', process.env.DEALFLOW_WEBHOOK_HMAC_SECRET)
  .update(`${timestamp}.${body}`)
  .digest('hex');

await fetch('https://dealflow.example.com/webhooks/dealflow', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-dealflow-timestamp': timestamp,
    'x-dealflow-signature': signature,
  },
  body,
});
```

### 结构化访问日志

每个请求输出一行 JSON（`message: "http.access"`），字段包括
`method`、`path`、`status`、`outcome`、`duration_ms`、`client`、`event_id`、`workflow_id`、`rate_limit_remaining`。
可直接接入容器日志采集，无需旁路组件。

> **多实例部署注意**：限流与重放缓存是进程内状态（这是「不引入额外基础设施」的取舍）。
> 需要跨实例强一致的限流/去重时，应在入口网关层处理，或后续再引入共享存储。

## 7. SQLite 备份与恢复

### 备份

```bash
npm run backup                                  # 使用 DEALFLOW_DB_PATH，输出到 <库目录>/backups/<库名>-<时间戳>.db
npm run backup -- --db data/dealflow.db --out backups/dealflow-manual.db
```

实现为 `VACUUM INTO`（`src/runtime/backup.ts`），会：

- 在**单一读事务**中把整库写成一个新文件，得到**一致性快照**；
- **不需要停机**，也不阻塞正常写入；
- 拒绝覆盖已存在的目标文件，避免误删历史备份。

**不要直接拷贝 `dealflow.db` 文件**：并发写入时可能拿到撕裂快照。若必须用文件拷贝，请先停止进程，并同时拷贝 `-wal` / `-shm` 文件（如存在）。

产物可独立打开校验：

```bash
node --disable-warning=ExperimentalWarning --experimental-transform-types \
  --import ./scripts/register.mjs --input-type=module \
  -e "const {openSqlite}=await import('./src/stores/sqlite-db.ts');const {SqliteEventStore}=await import('./src/stores/sqlite.ts');const db=openSqlite({path:'backups/dealflow-manual.db'});console.log(new SqliteEventStore({sqlite:db}).list().length,'events');db.close();"
```

### 恢复

1. 停止服务（确保没有写入者）。
2. 归档当前库文件，便于回溯。
3. 将备份文件复制到 `DEALFLOW_DB_PATH` 指向的位置，并确保运行账户可读写。
4. 启动服务；`EventStore` 是恢复的唯一事实来源，State/Audit/Exception 已随备份一同恢复。

> `recoverFromEventLog()` 只在 **State Store 为空** 时使用（例如仅恢复事件日志）。
> 正常从一致备份恢复时不要调用它，否则会重复重建审计记录。

### 建议策略

- 每日至少一次 `npm run backup`，产物落到独立卷或对象存储。
- 备份前后记录 `docs` 中提到的 `audit_entries` 等指标，便于核对。
- 定期做一次「备份 → 新目录恢复 → 启动」演练。

## 8. 目录与权限

```text
data/            # SQLite 业务库与默认备份目录（已在 .gitignore 中忽略）
scripts/         # TS 解析钩子（运行时必需）
src/             # 源码，直接被执行，无需构建
```

- 运行账户需要 `data/` 的读写权限。
- 备份目录建议单独挂载并限制访问（备份内含全部业务事实与审计）。
- 日志走 stdout，由进程管理器或容器运行时收集。

## 9. 部署前检查清单

- [ ] `node --version` 为 `22.22.0`（或满足 `engines`），启动日志无 `dealflow.runtime.unsupported`。
- [ ] `DEALFLOW_DB_PATH` 指向持久化卷，目录可写。
- [ ] 已设置 `DEALFLOW_WEBHOOK_HMAC_SECRET`（对外暴露时强烈建议同时设置 `DEALFLOW_WEBHOOK_TOKEN`）。
- [ ] 已设置 `DEALFLOW_CONTROL_PLANE_TOKEN`，且控制面只在内网/VPN 可达（否则 `needs_review` 无法推进）。
- [ ] 已按预期流量设置 `DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE` 与 `DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE`。
- [ ] 处在反向代理之后时已设 `DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS=true`；直连暴露时保持 `false`。
- [ ] `DEALFLOW_PROVIDER_KIND=http` 且 `DEALFLOW_PROVIDER_BASE_URL` 可达。
- [ ] 进程管理器以 `SIGTERM` 停止服务，且 `TimeoutStopSec` ≥ `DEALFLOW_SHUTDOWN_GRACE_MS`。
- [ ] 已配置定期备份，并演练过一次恢复。

Webhook 响应统一包含 `event_status`、`workflow_id`、`workflow_status`；兼容保留 `status`，其值等于 `event_status`。`event_status` 表示事件接收/处理结果，`workflow_status` 表示关联 Workflow 当前状态，二者不能混用。
动作派发失败时仍返回 HTTP `200`、`event_status=processed`，同时 `workflow_status=failed`；调用方不得仅依据 HTTP 200 或 `event_status` 判断动作成功，应读取 `workflow_status` 或查询 `GET /workflows/{id}`。
