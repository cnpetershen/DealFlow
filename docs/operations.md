# 操作文档：DealFlow 日常操作手册

面向「使用与值班」：怎么把业务事件送进系统、怎么看待办/看板、怎么审批、怎么处理异常与失败、怎么巡检。
系统怎么跑起来见 `docs/running.md`；部署与安全配置见 `docs/deployment.md`。

## 1. 概念速览

| 概念 | 说明 |
| --- | --- |
| Event | 外部（CRM/提供商）推送的不可变事实，唯一入口是 `POST <webhook.path>` |
| Workflow | 一个线索的跟进流程，ID 固定为 `wf_<workflow_type>_<lead_id>`（默认 `wf_lead_follow_up_lead_a`） |
| ProposedAction | 系统只**建议**动作（`send_email` / `schedule_meeting` / `create_task` / `send_proposal` / `advance_deal_stage`），不直接执行 |
| Policy | 判定 `auto` / `human_review` / `reject`；`human_review` → 实例进入 `needs_review`，等人工 approve/reject |
| Audit | 只追加审计，回答「谁批的、为什么、发了什么」 |
| Exception | 处理不了的事实进异常队列，交人工 `resolve` / `discard` / `replay` |

Workflow 状态：`pending, running, waiting_result, needs_review, replanning, completed, cancelled, failed`（终态 `completed` / `cancelled`）。完整状态机见 `docs/state-machine.md`。

## 2. 访问与鉴权

服务默认 `http://127.0.0.1:3000`（端口看 `DEALFLOW_PORT`，`.env` 中的值为准）。

| 端点组 | 鉴权 |
| --- | --- |
| `GET /healthz`、`GET /metrics` | 无鉴权、不限流 |
| `POST <webhook.path>` | 可选四道防线：限流 → `Authorization: Bearer <DEALFLOW_WEBHOOK_TOKEN>` → HMAC 签名 → 重放保护 |
| 控制面（`/workflows`、`/leads`、`/audit`…） | `Authorization: Bearer <DEALFLOW_CONTROL_PLANE_TOKEN>`（空则回退 `DEALFLOW_WEBHOOK_TOKEN`；**两者都空 → 全部 404**） |

本页示例使用：

```bash
BASE=http://127.0.0.1:3000
TOKEN=dev-token          # 换成 .env 里的 DEALFLOW_CONTROL_PLANE_TOKEN
AUTH="Authorization: Bearer $TOKEN"
```

Webhook 配了 HMAC 时，签名头为（签名载荷 `${timestamp}.${body}`）：

```text
x-dealflow-timestamp: <unix 秒>
x-dealflow-signature: sha256=<hex HMAC-SHA256>
```

## 3. 投递业务事件（Webhook）

信封必填字段（`src/events/envelope.ts:9-17`）：`event_id`、`type`、`version`、`occurred_at`（带时区偏移的 ISO）、`idempotency_key`、`payload`、`source`。

支持的事件类型（`src/events/dictionary.ts`，payload 字段见 `docs/events.md`）：
`lead.created`、`lead.assigned`、`contact.recorded`、`deal.created`、`email.sent`、`email.replied`、`meeting.scheduled`、`proposal.sent`、`deal.stage_changed`、`task.overdue`。

```bash
curl -s -X POST "$BASE/webhooks/dealflow" \
  -H 'content-type: application/json' \
  -d '{
    "event_id": "evt_01hx_1",
    "type": "lead.created",
    "version": 1,
    "occurred_at": "2026-09-26T09:15:00+08:00",
    "idempotency_key": "lead.created:01hx:1",
    "source": "crm",
    "payload": {
      "lead_id": "lead_a", "source_channel": "web_form", "source_record_id": "sd-1",
      "company_name": "蓝鲸科技", "contact_id": "contact_a", "initial_owner_id": null
    }
  }'
```

成功响应：

```json
{ "status": "processed", "event_status": "processed",
  "workflow_id": "wf_lead_follow_up_lead_a", "workflow_status": "running" }
```

**读响应的规则**：`event_status` 是事件接收结果（`processed | duplicate | unmatched | failed | conflict`），`workflow_status` 是流程当前状态。动作派发失败时仍返回 HTTP 200 + `event_status=processed`，但 `workflow_status=failed` —— **不要只看 HTTP 200**。

幂等：同一 `idempotency_key` 内容相同 → `duplicate`；内容不同 → `409 conflict`；仍是 `pending` → 自动重投。

## 4. 看板查询

全部需要控制面 Token，列表统一分页：默认 `limit=200`、上限 `1000`，响应带 `has_more`。

| 用途 | 请求 |
| --- | --- |
| 待我批的 | `GET /workflows?status=needs_review` |
| 流程详情（含待审 `action_id`） | `GET /workflows/{id}` |
| 我的线索 | `GET /leads?owner_id=ae_wang&status=assigned` |
| 单条线索 | `GET /leads/{id}`（不存在 `404`） |
| 商机看板 | `GET /deals?stage=won`、`?owner_id=`、`?lead_id=` |
| 审计链（复盘） | `GET /audit?workflow_instance_id=wf_lead_follow_up_lead_a&order=asc` |
| 异常队列 | `GET /exceptions`（默认 `status=open`，加 `&status=all` 看全部） |
| 运行时指标 | `GET /metrics`（无需 Token） |

```bash
curl -s -H "$AUTH" "$BASE/workflows?status=needs_review&limit=200"
# → {"items":[{"workflow_instance_id":"wf_lead_follow_up_lead_a","status":"needs_review",
#   "pending_action":{"action_id":"…","action_type":"send_email","requires_approval":true,"reason":"…"}}],
#   "count":1,"total":1,"has_more":false,"limit":200}
```

> 已知限制：未知查询参数（如 `?owner_id=` 传给 `/workflows`）会被**静默忽略**，不报错也不生效；调用方需按上表支持的参数传参。详见 `docs/sales-daily-feedback.md`。
>
> `pending_action.requires_approval` 是**对外有效结论**：实例停在 `needs_review` 时一律为 `true`
> （即 Policy 判了 Human Review）。Decider 内部还有一个同名草案标记（只在「被人工拒绝后重新提出」时为 true），
> 它不回答「这条要不要我批」这个问题，不对外暴露。判据始终是 `status` 与 `pending_action`，不要只看 HTTP 200。

## 5. 人工审批闭环

典型链路：事件 → Decider 建议动作 → Policy 判 `human_review` → 实例 `needs_review` → 人工 approve → 派发 → 等结果事件。

```bash
# 1) 拿 action_id
curl -s -H "$AUTH" "$BASE/workflows?status=needs_review"
# 2) 批准（交给 Executor 执行）
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"action_id":"<上一步的 action_id>","actor_id":"ae_wang"}' \
  "$BASE/workflows/wf_lead_follow_up_lead_a/approve"
# → 200 {..., "pending_action": null, "stale_action_replanned": false}
# 3) 拒绝必须给 reason
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"action_id":"<action_id>","reason":"客户本周出差，下周再约","actor_id":"ae_wang"}' \
  "$BASE/workflows/wf_lead_follow_up_lead_a/reject"
```

| 操作 | 端点 | 要点 |
| --- | --- | --- |
| 批准 | `POST /workflows/{id}/approve` | 必须 `action_id`；批准前会重新校验动作是否已过期，失效则自动作废并重新规划，响应 `stale_action_replanned: true` |
| 拒绝 | `POST /workflows/{id}/reject` | **`reason` 必填**（缺 → `400 reason is required`）；同上下文不重提，新事实到达后重新提出且强制再审 |
| 主动作废重规划 | `POST /workflows/{id}/replan` | 不写批准/拒绝结论；非 `needs_review` → `409` |

动作派发后 `pending_action` 清空，实例进入 `waiting_result`，等待结果事件（如 `email.sent`）匹配。

## 6. 控制操作与对账

```bash
# 取消（终态保护：之后到达的事件按 processed 消费，进异常队列交人工）
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"actor_id":"ae_li"}' \
  "$BASE/workflows/wf_lead_follow_up_lead_c/cancel"

# 重试失败实例（permanent / submitted=unknown 不允许，→ 409）
curl -s -X POST -H "$AUTH" "$BASE/workflows/<id>/retry"

# Provider 对账：仅 status=failed 且 failure_submitted='unknown' 可用，否则 409
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"actor_id":"ops"}' \
  "$BASE/workflows/<id>/reconcile"
# → {"…summary","reconcile":{"outcome":…,"provider_reference":…,"exception_id":…}}
```

对账结论决定走向（**禁止猜测后重试**）：

| 结论 | 结果 |
| --- | --- |
| `submitted = true` | 转 `waiting_result`，副作用已发生，不再调外部 |
| `submitted = false` | 用**原** `execution_idempotency_key` 重新派发（提供商侧幂等） |
| `submitted = 'unknown'` | 保持 `failed` + 写异常队列转人工 |

超时/断连导致「不知道发没发出去」时，一律先 reconcile，不要直接 retry。

## 7. 异常处理

```bash
curl -s -H "$AUTH" "$BASE/exceptions?status=open&limit=50"

# 处理完毕
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"resolution":"客户仍要采购，转人工继续跟进","reason":"自动流程已取消","actor_id":"ae_li"}' \
  "$BASE/exceptions/<exception_id>/resolve"

# 判定不该产生业务效果
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"resolution":"历史脏数据","actor_id":"ae_li"}' \
  "$BASE/exceptions/<exception_id>/discard"

# 把原始事件副本重新走正常流程（幂等，已生效的只会返回 duplicate）
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"resolution":"补投","actor_id":"ae_li"}' \
  "$BASE/exceptions/<exception_id>/replay"
```

- `resolution` **必填**（缺 → `400 resolution is required`），`reason` / `actor_id` 可选；
- 三个操作都写只追加审计（`exception_resolved` / `exception_discarded` / `exception_replayed`）；
- 已 `discarded` 的异常拒绝 replay（`409`）；
- replay 后仍被状态机拒绝时异常保持 `open`，可继续处理。

## 8. 日常巡检清单

| 频率 | 检查 | 命令/依据 |
| --- | --- | --- |
| 每次发布/重启后 | 启动成功 | 日志出现 `dealflow.ready`；`curl $BASE/healthz` → `{"status":"ok"}` |
| 每日 | 是否有待审积压 | `GET /workflows?status=needs_review` 的 `total` |
| 每日 | 是否有 open 异常 | `GET /metrics` 的 `open_exceptions`；明细 `GET /exceptions` |
| 每日 | 是否有失败实例 | `GET /workflows?status=failed`；看是否 `dealflow.retry.exhausted` 告警 |
| 每日 | 备份 | `npm run backup`，核对 `dealflow.backup.completed` 的 `bytes` |
| 按需 | 事件是否在被消费 | `GET /metrics` 的 `events.total` / `events.processed` 是否增长 |
| 按需 | 复盘某次动作 | `GET /audit?workflow_instance_id=…&order=asc` |

关注这些日志（stderr/stdout 单行 JSON）：`dealflow.start.failed`、`dealflow.recovery.*`、`dealflow.retry.exhausted`、`dealflow.retry.failed`、`http.unhandled`、`control_plane.failed`。

## 9. 端到端演练

一键跑完「进线 → 分配 → 审批首封邮件 → 回复 → 约会议 → 建商机 → 推阶段 → 拒绝重提 → 取消 → 成交」21 个事件：

```bash
# 1) 全新库启动（脚本默认连 127.0.0.1:3123 + dev-token，可用环境变量覆盖）
DEALFLOW_DB_PATH=data/sales-daily.db DEALFLOW_PORT=3123 DEALFLOW_CONTROL_PLANE_TOKEN=dev-token npm start
# 2) 另开终端
node scripts/sales-day-walkthrough.mjs
# 连别的实例：WALKTHROUGH_BASE=http://127.0.0.1:3000 WALKTHROUGH_TOKEN=<token> node scripts/sales-day-walkthrough.mjs
```

- 事件时间按**运行当天**（+08:00）的 09:15–16:00 生成，可重复执行而不会被动作有效期判过期；
- 重复执行前删除 `data/sales-daily.db*`，从空白看板重来；
- 走查记录与结论见 `docs/sales-daily-feedback.md`；
- 单实例验收（一个 Lead 跑完闭环 + MVP 断言）：`npm run accept`（一键全流程），
  或分步 `node scripts/single-instance-acceptance.mjs`，见 `docs/acceptance-single-instance.md`；
- 只想快速验证安装：`npm run typecheck && npm run test:run`（642 个测试），再 `curl $BASE/healthz`。

## 10. 常见返回码

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `200` | 接收/操作成功（含 `duplicate`、`unmatched`、`failed` 事件结果） | 读 `workflow_status` 判断流程真实状态 |
| `400` | 报文非法 / 缺必填（`reason`、`resolution`、`action_id`） | 按 `error` 补字段 |
| `401` | Token 或 HMAC 签名不对 | 检查 `Authorization`、`x-dealflow-signature` |
| `404` | 资源不存在；或控制面未启用（Token 为空） | 检查 Token 配置 |
| `409` | 幂等冲突、签名重放、状态不允许（如对不可重试实例 retry） | 读 `error`，勿盲目重发 |
| `413` | 请求体超 `DEALFLOW_WEBHOOK_MAX_BODY_BYTES` | 精简报文 |
| `429` | 限流 | 见 `retry-after`；调 `…RATE_LIMIT_PER_MINUTE`（`0`=不限流） |
| `500` | 未预期异常 | 查 `http.unhandled` / `control_plane.failed` 日志 |

## 11. 已知限制（操作时注意）

1. 控制面**没有写入口**：录线索/联系人/商机必须由 CRM 推事件，销售手工记录无法承接。
2. 没有「按人聚合的待办」：要回答「我现在该干什么」需串 `GET /leads?owner_id=` + `GET /workflows?status=needs_review`。
3. 终态实例可能仍显示 `pending_action`，但 approve 会正确返回 `409` —— 以可操作性为准。
4. `send_proposal` 当前不会被系统提出（配置缺口），提案环节实际由 CRM 手工触发。
5. 结果事件（如 `email.sent`）必须在动作派发之后到达，否则会被当事实消费、流程停在等待。

其余发现与优先级见 `docs/sales-daily-feedback.md`。
