# Runtime：配置、Provider Adapter、Webhook 与观测

## 配置

运行配置集中在 `src/config/config.ts`，用 Zod 校验并补齐默认值，零配置即可启动 MVP：

- `workflow_type`：Workflow 类型，默认 `lead_follow_up`。
- `server.host` / `server.port` / `server.max_connections`：HTTP 监听参数。
- `database.path` / `database.timeout_ms`：SQLite 业务库位置与写锁忙等超时。
- `shutdown.grace_ms`：优雅关闭宽限期，超时强制断开剩余连接。
- `webhook.path` / `webhook.max_body_bytes` / `webhook.bearer_token`：接收路径、报文上限、Bearer 认证。
- `webhook.hmac_secret` / `webhook.signature_tolerance_seconds` / `webhook.rate_limit_per_minute`：HMAC 签名、时间戳窗口与限流。
- `provider.kind` / `provider.base_url` / `provider.timeout_ms` / `provider.bearer_token`：Provider Adapter 选择与参数。
- `observability.enabled`：是否暴露观测快照。
- `control_plane.enabled` / `control_plane.bearer_token`：控制面开关与鉴权 Token。
- `policy.*`：Policy 静态默认值（白名单、允许动作类型、发送窗口、时区偏移、每日上限、关键客户、高价值阈值）。

`auto_actions_today` 由 `src/policy/auto-actions-today.ts` 从只追加审计推导（`policy_evaluated` + `result=succeeded`
即 Policy 给出 Auto 结论），按业务时区归日；恒为 0 的实现会让 `max_auto_actions_per_day` 永远不生效。

`parseConfig(input)` 严格校验，`loadConfig(overrides)` 在默认值上合并覆盖项，
`loadConfigFromEnv(env)` 映射 `DEALFLOW_*` 环境变量（完整表格见 `docs/deployment.md`），
`policyContextFromConfig(config, runtime)` 把静态配置与运行时事实（判定时刻、当日自动动作数、允许操作者）拼装为引擎所需的 `PolicyContext`。

## Provider Adapter

Provider Adapter 是面向具体外部提供商的「提交 + 对账」端口，接口定义在 `src/provider/types.ts`：

```ts
interface ProviderAdapter {
  readonly provider: string;
  readonly action_types: readonly ActionType[];
  submit(action: ProposedAction): Promise<SubmitOutcome>;
  reconcile(action: ProposedAction): Promise<ProviderReconciliation>;
}
```

契约：

- `submit` 成功返回 `{ status: 'accepted', receipt }`，回执携带 `provider` / `provider_reference` / `correlation_id`，
  用于对账与审计追溯。
- 同一 `execution_idempotency_key` 重复提交返回 `duplicate`，不产生第二次副作用。
- 失败抛可分类的 `ExecutionError`（`classification` / `submitted`），复用 `classifyExecutionError` 的统一分类。
- `reconcile` 判断一次不确定提交是否真的落到提供商侧，用于 `submitted === 'unknown'` 的恢复路径，
  返回三态：`true`（确认已提交）/ `false`（确认未提交）/ `'unknown'`（提供商侧也无法判定，
  例如有记录但给不出回执标识）——第三种情况禁止猜测后重试。

实现：

- `InMemoryProviderAdapter`（`src/provider/in-memory.ts`）：参考实现。`failNext(error, { record_receipt })`
  注入提交失败，其中 `record_receipt: true` 模拟「提供商已接受、回执在响应途中丢失」这一关键场景；
  `failReconcileNext` 注入对账请求失败；`submitted()` / `reconcileCalls()` 暴露副作用与对账调用次数。
- `ProviderAdapterExecutor`（`src/provider/executor.ts`）：把一组 Provider Adapter 组合成引擎的 `Executor` 端口，
  按动作类型路由，并把 `submit` 的回执**原样透传**到 `ExecutionResult`（回执是唯一能对账的凭据，不能在这里丢）；
  同时实现可选能力 `ReconcilableExecutor`，把 `reconcile` 路由到声明支持该动作类型的同一个适配器。
- 引擎侧通过 `isReconcilableExecutor` 探测该能力：不支持对账的 Executor 会让对账请求明确报错，
  而不是被猜一个结论。
- 契约测试 `describeProviderAdapterContract`（`src/provider/contract.ts`）：任何真实适配器与 InMemory 参考实现必须行为一致。

## HTTP/Webhook 入口

`src/http/webhook.ts` 提供无框架的 `node:http` 入口：

- `GET /healthz`：存活探针，返回 `{ status: 'ok' }`。
- `GET /metrics`：运行时观测快照（未启用观测时 `404`）。
- `POST <webhook.path>`：接收事件。信封与 payload 校验失败返回 `400`，幂等冲突返回 `409`，其余接收结果返回 `200`（含 `status` 与 `workflow_id`）。
- 控制面路由（`src/http/control-plane.ts`）：未命中控制面时返回 `false`，继续按 Webhook 判定。

`createWebhookHandler(options)` 返回纯请求处理器便于单元测试，`createWebhookServer(options)` 包装为 `http.Server`。
请求/响应工具集中在 `src/http/respond.ts`，Webhook 与控制面共用，避免两份实现漂移。

## 控制面

`createControlPlaneHandler({ engine, audit_log, exception_queue, pending_action_store, config, metrics })`：

- 人工审核：`POST /workflows/{id}/approve|reject`，让 `needs_review` 的流程真正可被外部推进；
- 控制操作：`POST /workflows/{id}/cancel|retry`；
- 只读查询：`GET /workflows`、`GET /workflows/{id}`、`GET /audit`、`GET /exceptions`；
- 异常处理：`POST /exceptions/{id}/resolve|discard`（此前只存在于 Store 层，没有任何运维入口）。

鉴权：`control_plane.bearer_token`，为空回退 `webhook.bearer_token`；两者都为空时不注册路由（`404`）。
细分计数器写入 `control_plane.*`，与 `events.*` 分开。完整端点为 `docs/deployment.md` 第 5 节。

`createWebhookServer` 会把控制面处理器挂在同一个 HTTP 服务上，`bootstrap.ts` 同时注入 `logger`，
因此每个请求都会输出一行 `http.access`。

### 生产安全链路

按顺序执行，全部进程内实现，不引入 Redis 等外部基础设施：

1. **限流**（`src/http/rate-limit.ts`）：固定窗口按来源计数，超限 `429` + `Retry-After`；key 数量有上限。
2. **Bearer Token**：`Authorization: Bearer <token>`。
3. **HMAC 签名**（`src/http/hmac.ts`）：`X-Dealflow-Timestamp` + `X-Dealflow-Signature: sha256=<hex>`，
   签名载荷为 `${timestamp}.${body}`，使用 `timingSafeEqual` 比较，时间戳超出容忍窗口即拒绝。
4. **重放保护**（`src/http/replay-guard.ts`）：签名指纹在窗口内只接受一次，重复投递 `409`。
5. **结构化访问日志**：每个请求一行 JSON（`message: "http.access"`），含状态码、耗时、结果与关联事件。

部署参数与运维说明见 `docs/deployment.md`。

## 运行时观测

`src/observability/metrics.ts` 提供进程内观测：

- `RuntimeMetrics.recordEvent(status)`：累计事件接收结果（`processed` / `duplicate` / `conflict` / `failed` / `unmatched` / `invalid`）。
- `RuntimeMetrics.recordAction(name)`：累计控制面调用（`control_plane.*`），与 `events.*` 分开。
- `RuntimeMetrics.snapshot()`：返回 `RuntimeSnapshot`，含计数器 + 从 State/Audit/Exception 派生的 gauges（`workflows_by_status`、`open_exceptions`、`total_exceptions`、`audit_entries`）。

观测依赖接口化 Store，可无缝替换为持久化实现，不改变快照契约。

## 查询必须走索引，不能读全表

引擎每处理一个事件都会构造 Decision Context，其中几处查询原本是「SELECT 全表 + 内存过滤」，
导致单事件处理耗时随事件/审计总量线性增长。实测（SQLite，完整链路）：

| 已存事件/审计 | 修复前单事件 | 修复后单事件 |
| --- | --- | --- |
| 0 | 12.7 ms | 12.3 ms |
| 1,000 | 79 ms | 11.6 ms |
| 5,000 | 329 ms | 12.0 ms |
| 20,000 | 1,373 ms | 21.7 ms |
| 50,000 | 外推约 3.4 s | 33.5 ms |

落实方式（新增接口与索引见 `src/stores/interfaces.ts`、`src/stores/sqlite-db.ts`）：

| 调用点 | 接口 | 索引 |
| --- | --- | --- |
| `DecisionContext.recent_events` | `EventStore.listByLeadId(leadId, limit)` | `idx_events_lead` |
| 待办任务推导 | 同上 + `AuditLogStore.query({workflow_instance_id, action, action_type})` | `idx_audit_dispatched` |
| `auto_actions_today` | `AuditLogStore.count({action, result, occurred_at_from/to})` | `idx_audit_action_window`（COVERING） |
| Memory 检索 | `MemoryStore.list(subjectId)` 改为 SQL 查询 | `idx_entity_state_subject` |
| 待审批动作 | `PendingActionStore.getPending(workflowId)` 改为 SQL 查询 | `idx_entity_state_workflow` |

索引是 **表达式索引**（`json_extract(...)` / `strftime('%s', ...)`），因此不需要新增列或数据迁移，
旧库只是多建几个索引。时间条件统一换算成 epoch 秒比较，避免 `Z` 与 `+08:00` 混写时字符串比较出错。

`recent_events` 按主体取最近 500 条（`RECENT_EVENT_LIMIT`），不再读取整个事件日志。

## 失败实例自动重试

`src/runtime/retry-scheduler.ts` 读取 `WorkflowInstanceState` 上的 `failure_*` 字段，
按周期对 `failed` 实例执行 `engine.retry()`，并实现退避与上限。判定表见 `docs/deployment.md` 第 5.2 节。

一个容易踩的点：`engine.retry()` **正常返回不等于重试成功** —— 它会重新规划并再次派发，
若派发又失败，返回的实例仍是 `failed`。调度器因此检查返回状态，否则退避与次数上限会全部失效。
