# Domain Model

## 最小销售场景

最小销售场景是：一个新的 `Lead` 进入系统，被分配给销售人员，销售通过邮件或会议进行跟进，必要时发送方案，最终推动一个 `Deal` 到成交或丢单。

这个场景的最小闭环是：

1. 接收并去重 `lead.created`。
2. 为 Lead 分配负责人，产生 `lead.assigned`。
3. 根据当前事实和策略决定下一步跟进动作。
4. 接收外部结果事件，例如回复、会议安排、方案发送或任务逾期。
5. 用结果事件恢复或重新规划 Workflow。
6. 将 Deal 推进到 `won`、`lost` 或继续等待下一结果。

系统不把发送邮件、创建会议、发送方案等动作直接写进 Decision。Decision 只提出 `ProposedAction`，由 Policy 判断是否可以自动执行，或是否必须进入人工审核。

## 核心实体

### Lead

Lead 表示一个尚未完成资格确认、但具备销售跟进价值的潜在客户线索。

建议包含的当前事实：

- `lead_id`
- 来源渠道和来源标识
- 当前负责人 `owner_id`
- 基本公司或个人识别信息
- 资格状态
- 当前关联的 Contact 和 Deal 标识
- 创建时间和最近更新时间

Lead 只保存当前事实。历史分配、历史资格判断和历史互动进入事件流、Memory 或 Audit Log，不在 Lead 中重复维护成时间线。

### Contact

Contact 表示与 Lead 或 Deal 关联的具体联系人。

建议包含的当前事实：

- `contact_id`
- 姓名、邮箱、电话等身份信息
- 所属组织标识
- 联系偏好与可联系状态
- 与 Lead、Deal 的关联关系

同一联系人可以关联多个销售机会，但联系人身份应通过稳定的外部标识或邮箱等字段去重，不能仅依赖显示名称。

### Deal

Deal 表示一个可被推进、赢得或丢失的销售机会。

建议包含的当前事实：

- `deal_id`
- 关联的 `lead_id`、`contact_id` 和组织标识
- 当前阶段 `stage`
- 金额、币种、预计成交时间
- 当前负责人
- `won` 或 `lost` 时的结果信息

Deal 通过 `deal.created` 事件进入系统，阶段变更通过 `deal.stage_changed` 事件更新。Deal 的当前阶段是 State，而阶段变更历史由事件和 Audit Log 保留。

### WorkflowInstance

WorkflowInstance 表示围绕一个销售对象运行的一次可恢复工作流。它负责保存当前执行位置、等待条件、版本和规划上下文，不保存完整互动历史。

建议包含的当前事实：

- `workflow_instance_id`
- `workflow_type`
- `subject_type` 和 `subject_id`
- `status`
- 当前节点或等待节点 `current_step`
- 期望接收的结果事件条件
- 当前 `plan_version`
- 最近一次处理的事件游标或版本
- 创建时间和更新时间

### WorkflowInstance 的 key

WorkflowInstance 应以以下业务复合 key 唯一确定：

`(workflow_type, subject_type, subject_id)`

对 MVP，最小实现可以固定 `subject_type = lead`，因此 key 为：

`(workflow_type, lead_id)`

这样同一个 Lead 在同一种工作流中只有一个可恢复实例，重复投递不会创建第二条并行流程。若未来需要同一 Lead 同时运行不同流程，例如新客培育与续约流程，则由不同的 `workflow_type` 区分。`workflow_instance_id` 是技术标识，不替代上述业务幂等 key。

## 边界与数据归属

| 数据 | 存储含义 | 规则 |
| --- | --- | --- |
| Event | 已发生的事实 | 不可变，必须包含 `event_id`、`type`、`version`、`occurred_at`、`idempotency_key`、`payload` |
| State | 当前事实 | 只保存当前有效值，可由受控的事件处理更新 |
| Memory | 历史互动、摘要、偏好 | 可检索，用于 Decision Context，不作为当前状态的唯一来源 |
| Audit Log | 决策和审批轨迹 | 只追加，不修改；记录谁、何时、基于什么事实做了什么决定 |
| Decision | 下一步建议 | 只输出 `ProposedAction`，不能直接 Execute |
| Policy | 风险和权限判断 | 决定 `Auto`、`Human Review` 或 `Reject` |

### Memory 的落地形态

Memory 是**只追加**的记录流（`MemoryStore`：`src/stores/interfaces.ts` 定义，`InMemory` 与 `Sqlite` 两个实现）：

- `interaction`：结果事件代表与客户真实发生过互动（`email.sent`、`email.replied`、`meeting.scheduled`、`proposal.sent`、`deal.stage_changed`、`task.overdue`），引擎在消费事件时写入；
- `preference`：`contact.recorded` 声明的联系偏好（`contact_preference:*`）；
- `summarizeMemory()`（`src/workflow/memory-summary.ts`）把记录汇总为 `MemorySummary`（互动次数、最近互动时间、去重后的偏好）供 Decision Context 使用。

持久化实现复用 `entity_states` 表（`entity_type = 'memory'`），写入后不提供更新与删除。

### 待审批动作的持久化

`PendingActionRecord`（`entity_type = 'pending_action'`）保存待审核动作的**完整快照**与审批结论。
原因：`needs_review` 的实例必须能在进程重启后继续审批，只保存 `action_id` 会依赖进程内存中的动作表而丢失。
批准前引擎会重新校验动作是否失效（见 `docs/decision-policy.md`「Approved」第 2 条）。

## AuditEntry 字段定义

Audit Log 的每一条记录称为 AuditEntry。Audit Log 只追加，任何更新或删除请求都必须失败。

AuditEntry 必须包含：

- `audit_id`：审计记录的唯一标识
- `occurred_at`：审计动作发生时间，使用带时区的时间
- `actor`：主体，包含 `actor_type`（`system` / `user` / `connector`）和 `actor_id`
- `action`：审计动作类型，例如 `event_processed`、`state_transitioned`、`decision_proposed`、`policy_evaluated`、`policy_rejected`、`action_approved`、`action_rejected`、`action_stale`、`replan_requested`、`action_dispatched`、`action_failed`、`action_reconciled`、`event_conflicted`、`exception_enqueued`、`exception_resolved`、`exception_discarded`、`exception_replayed`
- `subject`：关联实体，包含 `subject_type`、`subject_id`，以及可空的 `workflow_instance_id`
- `event_id` / `action_id`：本记录关联的原始事件或 ProposedAction 标识；异常处理结论通过 `exception_id` 关联，两者至少一个不为空
- `action_type`：关联动作的类型，可空。单独保存是因为重启后内存中的动作表会丢失，审计仍需能回答「派发了什么动作」，也用于「逾期任务是否已被补救」这类派生判断
- `before_state` / `after_state`：变更前后状态摘要，无状态变更时可为空
- `reason`：做出该决定或产生该结果的原因
- `policy_version` / `plan_version`：适用的 Policy 版本与计划版本，可为空
- `source`：来源系统、连接器或人工操作标识
- `result`：执行或处理结果，例如 `succeeded` / `failed` / `skipped` / `pending`
- `provider_reference`：外部提供商回执标识（如邮件服务 message-id），可空；结果事件携带时必须写入该事件的全部相关审计记录
- `provider_receipt`：本次**执行**拿到的提供商回执快照（`provider` / `provider_reference` / `correlation_id`），由 `action_dispatched` 与 `action_reconciled` 写入。它与顶层 `provider_reference` 的分工是：后者跟随「关联事件」以保证同一事件的审计链路可追溯，前者是「这个动作提交后提供商返回了什么」的事实记录；事件没有回执时（例如 `lead.assigned` 触发的首次外发、控制面审批）顶层标识才用执行回执补齐
- `exception_id`：关联的异常记录标识，用于把异常处理结论与该异常记录对上

AuditEntry 不参与状态计算。当前事实以 State 为准，AuditEntry 只用于回答“谁、何时、基于什么事实做了什么决定”。

## Audit 契约：Action / Execution / Result / Error / Retry / Exception

同一业务链路的审计关系如下，全部通过 `event_id`、`action_id` 与 `subject.workflow_instance_id` 关联：

| 阶段 | Audit action | 关联字段 | 说明 |
| --- | --- | --- | --- |
| Action（决策） | `decision_proposed` | `event_id` + `action_id` | Decision 提出 ProposedAction |
| Action（策略） | `policy_evaluated` / `policy_rejected` | `event_id` + `action_id` | Policy 结论：auto / human_review / reject |
| Action（审批） | `action_approved` / `action_rejected` | `action_id` | 控制面人工操作，`event_id` 可为空 |
| Action（失效重规划） | `action_stale` / `replan_requested` | `action_id` | 批准前复核发现动作已失效，或人工要求重新规划：动作作废、按当前 State 重算，`result = skipped` |
| 状态迁移 | `state_transitioned` | `subject.workflow_instance_id` | Workflow 自身状态变化（进入等待、结束），含 `before_state` / `after_state` |
| Execution（派发） | `action_dispatched` | `event_id` + `action_id` | Executor 已接受动作，`result = succeeded`，并写入 `provider_receipt` |
| Execution（失败） | `action_failed` | `event_id` + `action_id` | Executor 拒绝或抛错，`result = failed`，`reason` 前缀为 `transient:` 或 `permanent:` |
| Execution（对账） | `action_reconciled` | `action_id` | `submitted === 'unknown'` 的对账结论：已提交 / 未提交 / 无法判定，写入 `provider_receipt` |
| Result（结果事件） | `event_processed` | `event_id` | 匹配的结果事件已消费；`needs_review` 期间到达并被合并的事实、以及终态实例上到达的非事实类事件，同样按 `processed` 消费、写入本条；携带 `provider_reference` 时写入该字段 |
| Error / Retry | `action_failed` + 后续 `decision_proposed` | `action_id` | 失败分类决定是否允许 `retry`；重试成功后产生新的 `action_dispatched` |
| Conflict | `event_conflicted` | `event_id` | 同一 `idempotency_key` 携带不同事实，拒绝覆盖并写入异常队列 |
| Exception | `exception_enqueued` + 异常队列记录（非 AuditEntry 本体） | `event_id` + `exception_id` | 每次写入异常队列都追加一条审计；异常原因见「异常队列」。`awaiting_approval` 与 `workflow_ended` 因事件已正常消费，审计记 `result = pending`，其余原因记 `failed` |
| Exception（结论） | `exception_resolved` / `exception_discarded` / `exception_replayed` | `exception_id` + `event_id` | 人工结论与重放：记录操作者、结论原因、前后状态；结论本体保存在异常记录上 |

规则：

1. 每个 ProposedAction 至少有一条 `decision_proposed`；被 Policy 拒绝时有 `policy_rejected`，不再有 `action_dispatched`。
2. 每次 Executor 调用结束（成功或失败）必须有对应的 `action_dispatched` 或 `action_failed`。
3. 结果事件匹配成功、或在 `needs_review` 期间被合并消费时必须有 `event_processed`，并保留该事件 payload 中的 `provider_reference`。
4. permanent 失败的 Workflow 不允许自动 `retry`；transient 失败允许，且重试必须复用原事件与执行幂等 key。
5. Exception 写入不修改原始事件；原始事件与已有 AuditEntry 保持不可变。
6. `submitted === 'unknown'` 的失败必须先 `action_reconciled` 得出结论，才能回到 `retry` 或 `waiting_result`。
7. 派发动作若拿到了提供商回执，必须写入 `provider_receipt`：它是「本地 action」与「提供商副作用」唯一能对账的凭据。
8. 异常的处理结论（`resolve` / `discard` / `replay`）必须追加对应 AuditEntry，并带上 `exception_id` 与操作者。

## Executor Error Contract

Executor 失败必须在错误边界统一分类，保证调用方可以区分可重试与不可重试失败：

```text
classification:
  transient   # 可自动重试
  permanent   # 需人工介入或修正输入
submitted:
  false       # 确认未提交，可安全重试
  true        # 已提交（通常伴随成功或结果事件）
  unknown     # 超时/网络中断等无法判定，禁止简单 retry，必须先 provider 对账
code / provider / provider_reference / retry_after:
  生产排障字段，可空
```

规则：

1. 显式携带 `classification` 的错误原样保留。
2. `code === 'TIMEOUT'` 默认归类为 `transient`，且 `submitted` 默认 `'unknown'`（可能已被提供商接受）。
3. 其余未分类错误默认 `permanent`（保守策略，避免盲目重试未知失败）；未显式提供时 `submitted` 默认 `false`。
4. `ExecutionError` 至少包含：`actionId`、`message`、`classification`、`cause`，以及生产字段 `code`、`provider`、`provider_reference`、`retry_after`、`submitted`。
5. `submitted === 'unknown'` 时禁止简单 retry，必须先做 provider 对账后再恢复自动重试。
   对账入口是 `POST /workflows/{id}/reconcile`（实现见 `WorkflowEngine.reconcile`，分支表见 `docs/deployment.md` 第 5.3 节）；
   `Executor` 通过可选能力 `ReconcilableExecutor` 暴露 `reconcile`，不支持的实现会明确报错而不是猜结论。
6. Workflow 对 `transient` 且 `submitted !== 'unknown'` 的失败进入 `failed` 并允许 `retry`；对 `permanent` 或 `submitted === 'unknown'` 的失败进入 `failed` 后 `retry` 抛错拒绝。失败分类与 `submitted` 持久化在 WorkflowInstanceState 的 `failure_*` 字段，进程重启后仍生效。
7. 成功派发后必须清空 `failure_classification` / `failure_submitted` / `failure_retry_after`。

## Result Event Contract

外部提供商回执类结果事件（如 `email.sent`、`email.replied`、`meeting.scheduled`、`proposal.sent`）的 payload 约定：

```text
provider_reference: string | null   # 提供商侧唯一回执标识
provider: string | null             # 提供商标识，如 mailgun / sendgrid
correlation_id: string | null       # 提供商关联 id，可与 action 对账
```

规则：

1. 结果事件通过 `workflow_instance_id` + `lead_id` + 事件类型匹配等待条件；`provider_reference` 用于对账与审计追溯，不单独作为 Workflow 匹配键。
2. 事件幂等仍以信封 `idempotency_key` 为准；`provider_reference` 不参与信封幂等，但同一 `provider_reference` 的重复投递必须命中 `idempotency_key` 去重或匹配等待条件后只产生一次业务效果。
3. 重复结果事件：第二次投递返回 `duplicate` / 不匹配，不重复推进 State；接收路径可保留 `event_processed` 审计。
4. 未知 Action 的结果（无法匹配任何等待中的 Workflow）进入异常队列，不静默丢弃。
5. 结果事件携带 `provider_reference` 时，该事件 `event_id` 下的全部 AuditEntry 必须携带同一 `provider_reference`。

## 异常队列

异常队列用于承载无法安全自动处理的输入，保证既不静默丢弃也不静默覆盖当前事实。

写入异常队列的情况包括：

- 同一 `idempotency_key` 携带不同 payload（幂等冲突）
- 事件不匹配任何等待条件，且不能安全地作为新事实合并
- 迟到事件与当前 State 版本冲突，无法确定优先级
- 事件在 `needs_review` 期间到达：事实已合并、事件已按 `processed` 消费，但流程在等人工审批
- 事件到达时实例已进入终态（`completed` / `cancelled`）：事实已合并、事件已按 `processed` 消费，
  但流程不再推进，需要人工判断是否新建后续流程（原因 `workflow_ended`）
- 处理过程中发生不可自动恢复的错误

每个异常记录必须包含：

- `exception_id`
- `occurred_at`
- `reason`：归类原因，例如 `idempotency_conflict`、`unmatched_event`、`stale_event`、`invalid_transition`、`awaiting_approval`、`workflow_ended`、`processing_error`
- `event_id` 与事件的完整信封副本。两者都可为 `null`：异常也可能由控制面操作产生
  （例如 Provider 对账返回 `unknown`），那种情况没有触发事件，用 `subject` 与关联审计的 `action_id` 定位
- `subject`：关联实体标识，可为空
- `status`：`open` / `resolved` / `discarded`
- `resolution`：人工处理结论，未处理时为空
- `resolved_by` / `resolved_at`：处理人与处理时间，未处理时为 `null`

异常队列的写入不需要修改原始事件，原始事件保持不可变。异常记录本身也必须追加一条 AuditEntry。

### 异常的生命周期

| 操作 | 语义 | 事件是否可再被处理 |
| --- | --- | --- |
| `resolve` | 人工给出结论，异常关闭 | 事件保持原处理状态 |
| `discard` | 明确判定该输入不应产生任何业务效果 | 不允许重放（`409`） |
| `replay` | 把异常记录里的**事件副本**重新交给正常 Workflow 路径 | 走 `handleEvent`，按 `idempotency_key` 去重 |

`awaiting_approval` 是唯一由流程自身关闭的异常：实例离开 `needs_review`（approve / reject / replan / cancel）时
自动 `resolve`，结论固定为「审批已离开 needs_review」，`resolved_by` 取审批操作者；其余原因都必须由人工
`resolve` / `discard` / `replay` 给出结论。实例仍停在 `needs_review` 时该异常保持 `open`——它还描述着真实待办。

`replay` 的约束（实现见 `WorkflowEngine.replayException`）：

1. 原始 Event 不可变：重放使用异常记录中的信封副本，事件本体没有被改写；
2. 必须走正常 Workflow 路径，因此去重、幂等、状态机校验与审计与 Webhook 入口完全同源；
3. 不产生重复业务效果：事件存储按 `idempotency_key` 去重，已生效的事件只返回 `duplicate`；
4. 可审计：每次重放追加 `exception_replayed`，记录操作者、结论与事件处理结果；
5. 重放后事件仍被状态机拒绝时，异常保持 `open`，审计记为 `failed`，人工可继续处理或丢弃。

未被任何 Workflow 认领的事件（`unmatched`）**不会**被标记为已处理，因此会留在事件日志中等待
补建 Workflow 后重放；同一事件已有未处理异常时不会重复入队，避免重复投递刷满异常队列。
