# State Machine

## State 枚举

### Lead State

- `new`: 已接收，尚未完成分配
- `assigned`: 已有负责人，等待首次动作
- `engaged`: 已发生有效互动，例如收到回复或完成会议
- `qualified`: 已确认具备进入销售机会的条件
- `nurturing`: 暂不具备立即推进条件，但仍需持续培育
- `disqualified`: 不再进入当前销售流程
- `converted`: 已转化为 Deal 的销售对象
- `closed`: 该 Lead 的流程已结束

### Deal Stage

- `qualification`
- `discovery`
- `proposal`
- `negotiation`
- `won`
- `lost`

### WorkflowInstance State

- `pending`: 等待启动或等待依赖数据
- `running`: 当前有可执行的工作流步骤
- `waiting_result`: 已提出或执行动作，等待外部结果事件
- `needs_review`: 需要人工批准、拒绝或补充信息
- `replanning`: 收到结果事件，正在重新计算下一步计划
- `completed`: 工作流正常完成
- `cancelled`: 被明确取消，不再自动恢复
- `failed`: 处理失败，等待重试或人工处理

## 状态迁移表

| 当前对象/状态 | 事件 | 条件 | 迁移后状态 | Workflow 动作 |
| --- | --- | --- | --- | --- |
| Lead `new` | `lead.created` | 事件首次处理成功 | `new` | 创建或幂等获取 WorkflowInstance，进入分配决策 |
| Lead `new` | `lead.assigned` | `owner_id` 有效 | `assigned` | 从分配节点恢复，计算首次跟进动作 |
| Lead `assigned` | `lead.assigned` | 同一分配事实重放（至少一次投递） | `assigned` | 幂等合并，不重复推进流程 |
| Lead `assigned` | `email.sent` | 邮件发出且关联当前 Lead | `assigned` | 等待回复或超时结果 |
| Lead `assigned` | `email.replied` | 回复可匹配联系人或线程 | `engaged` | 进入互动结果处理，可能提出会议动作 |
| Lead `engaged` | `meeting.scheduled` | 会议属于当前 Lead/Contact | `qualified` 或 `engaged` | 等待会议结果或后续销售动作 |
| Lead `qualified` | `deal.created` | 由当前 Lead 转化且尚无有效 Deal | `converted` | 创建 Deal 当前事实并关联 Workflow，进入提案准备 |
| Lead `qualified` | `proposal.sent` | 已关联有效 Deal | `converted` | 将 Deal 推进到 `proposal`，等待客户反馈 |
| Lead 任意未终态 | `task.overdue` | 任务仍属于当前 Workflow | 保持当前 Lead 状态 | 恢复超时分支，提出补救或人工审核 |
| Deal 不存在 | `deal.created` | `lead_id` 有效且 `initial_stage = qualification` | `qualification` | 建立 Deal 当前事实，等待资格确认类动作 |
| Deal `qualification` | `deal.stage_changed` | `to_stage = discovery` | `discovery` | 重新规划发现阶段动作 |
| Deal `discovery` | `deal.stage_changed` | `to_stage = proposal` | `proposal` | 允许提案相关动作 |
| Deal `proposal` | `deal.stage_changed` | `to_stage = negotiation` | `negotiation` | 进入商务谈判，允许报价与条款类动作 |
| Deal `proposal` | `proposal.sent` | 提案已发送 | `proposal` | 等待回复、会议或阶段变更 |
| Deal `discovery` | `proposal.sent` | 提案已发送且 Deal 未进入终态 | `proposal` | 推进到提案阶段并等待客户反馈 |
| Deal 任意非终态 | `deal.stage_changed` | `to_stage = won` | `won` | 完成销售 Workflow，写入审计记录 |
| Deal 任意非终态 | `deal.stage_changed` | `to_stage = lost` | `lost` | 终止自动动作，保留丢单原因 |
| Workflow `pending` | 启动 | 依赖数据就绪 | `running` | 进入首个可执行步骤 |
| Workflow `running` | 派发动作 | 动作已交给 Executor 且需等待外部结果 | `waiting_result` | 记录等待条件与执行幂等 key |
| Workflow `running` | 无可执行动作 | 当前无动作可提，但主体仍可被后续事件推进 | `waiting_result` | 按当前 State 推导等待事件集合并休眠（触发器 `awaiting_events`） |
| Workflow `running` | 需要人工审核 | Policy 判定为 Human Review | `needs_review` | 生成待审核 ProposedAction，不直接执行 |
| Workflow `running` | 无法处理 | 可重试错误 | `failed` | 保留失败原因，按重试策略恢复 |
| Workflow `running` | 流程结束 | 无后续步骤且无待办 | `completed` | 结束自动动作，写入审计记录 |
| Workflow `waiting_result` | 匹配的结果事件 | 事件满足等待条件 | `replanning` | 消费结果事件，计算下一节点 |
| Workflow `needs_review` | 人工批准 | ProposedAction 被批准 | `replanning` | 按批准结果重新规划，不直接复用旧计划 |
| Workflow `needs_review` | 人工拒绝 | ProposedAction 被拒绝 | `replanning` | 记录拒绝原因与 `basis_event_id`，基于新约束重新规划；新事件进入前不重提同一动作类型 |
| Workflow `needs_review` | 动作失效 / 人工重新规划 | 待审动作已被新事实取代、已过期，或控制面要求重来（触发器 `stale_action`） | `replanning` | 作废待审动作（不写拒绝结论），基于当前 State 重新规划 |
| Workflow `replanning` | 规划完成 | 已生成新的 `plan_version`，或确认无安全替代动作 | `running` / `waiting_result` / `needs_review` | 进入新计划的首个可执行步骤，或转为等待、人工审核 |
| Workflow `replanning` | 流程结束 | 无后续步骤且无待办 | `completed` | 结束自动动作，写入审计记录 |
| Workflow `failed` | 重试 | `transient` 且 `submitted !== 'unknown'` | `running` | 复用同一 `idempotency_key` 重试（可由 `RetryScheduler` 自动触发，见 `docs/deployment.md` 第 5.2 节） |
| Workflow `failed` | 重试 | `permanent` 失败 | 保持 `failed` | 拒绝自动重试，需人工处理或修正输入 |
| Workflow `failed` | 重试 | `submitted === 'unknown'`（可能已提交） | 保持 `failed` | 拒绝简单自动重试，先做 provider 对账 |
| Workflow `failed` | Provider 对账 | 对账确认**已提交** | `waiting_result` | 恢复为「已派发、等待结果」，不再调用外部（`action_reconciled` 审计，见 `docs/deployment.md` 5.3） |
| Workflow `failed` | Provider 对账 | 对账确认**未提交** | `running` | 用**原执行幂等 key** 重新派发，不产生第二次副作用 |
| Workflow `failed` | Provider 对账 | 对账返回 `unknown` 或对账请求失败 | 保持 `failed` | 写入异常队列转人工，禁止猜测后重试 |
| Workflow 任意非终态 | 取消操作 | 明确取消 | `cancelled` | 不再自动执行未批准动作 |

表中的 Lead 和 Deal 状态必须通过受控的事件处理更新。没有对应事件或违反阶段规则的状态写入应被拒绝并进入异常处理。

Workflow 的触发器与 Lead/Deal 不同：它既可以是外部事件（例如 `waiting_result` 匹配到的结果事件），也可以是控制面操作（启动、派发动作、需要人工审核、人工批准、人工拒绝、规划完成、重试、流程结束、取消）。控制面操作不是 Event，不受 `idempotency_key` 去重约束，但同样必须追加 Audit Log。

## 无动作时的落点：推导等待，而不是结束流程

Decider 暂时提不出动作时，Workflow **不能**直接 `completed`：Lead 侧互动（邮件、回复、会议）与 Deal 侧生命周期（阶段推进、成交/丢单）是同一实例里的连续过程，提前结束会让后续事件全部变成 `unmatched_event`。

引擎按以下规则决定落点（实现见 `src/workflow/expected-events.ts`）：

1. 由当前 Lead 状态与 Deal 阶段推导「还能推进流程的事件集合」，写入 `awaiting_event_types`，`current_step = 'await_event'`，进入 `waiting_result` 休眠；
2. 已经发生过且不会重复的事件（`deal.created`、`email.sent` 等）从集合中剔除，避免等待一个永远不会再来的事件；
3. 只有主体已进入终态（Lead `disqualified`/`closed`、Deal `won`/`lost`）导致集合为空时，才迁移到 `completed`。

两类等待必须区分，`current_step` 是判定依据：

| 等待类型 | `current_step` | `awaiting_event_types` | 事实类事件能否触发重新规划 |
| --- | --- | --- | --- |
| 派发动作后等结果 | 动作类型（如 `send_email`） | 该动作的结果事件（`RESULT_EVENTS`） | 否（避免动作在途时重复派发） |
| 推导等待 | `await_event` | 推导出的可推进事件集合 | 是（此时没有动作在途） |

`needs_review` 期间到达的非事实类事件：合并可安全合并的事实，并按 `processed` 消费该事件，写入异常队列（`awaiting_approval`）等待人工判断，但不擅自推进 Workflow —— 既不静默覆盖，也不静默丢弃，也不把「等审批」报成处理失败。事实本身非法的事件仍被判 `failed`（`stale_event` / `invalid_transition`）。实例离开 `needs_review` 时，该类异常随审批自动关闭。

终态（`completed` / `cancelled`）实例上到达的非事实类事件：同样合并事实并按 `processed` 消费，写入异常队列（`workflow_ended`）交人工判断是否需要新建后续流程，但 Workflow 自身保持终态、不重新规划。它不是「无人认领的事件」，因此不记 `unmatched_event`；事实本身非法时仍判 `failed`（`stale_event` / `invalid_transition`）。

## Workflow Resume 规则

1. **以业务 key 恢复**：收到事件后先通过 `(workflow_type, subject_type, subject_id)` 找到唯一 WorkflowInstance；不存在时按事件类型决定是否创建。
2. **先去重再迁移**：先检查 `idempotency_key` 是否已处理。已处理的事件直接返回原处理结果，不重复迁移或产生动作。
3. **只恢复等待匹配的实例**：事件必须匹配 `subject_id`、事件类型、关联对象和等待条件；不匹配的事件进入事件存档或异常队列，不得强行推进流程。
4. **读取当前事实**：恢复时重新读取 State、最近事件、Memory 摘要和有效 Policy 版本，不从旧 ProposedAction 推断当前状态。
5. **结果优先于计划**：外部结果事件到达后，先更新当前事实并标记旧等待节点完成，再进入 `replanning`。
6. **计划版本递增**：每次重新规划生成新的 `plan_version`。旧计划的未执行动作不得自动复用，除非新计划明确确认仍然有效。
7. **迟到和冲突事件**：依据实体版本和阶段迁移规则处理。不能安全合并的事件必须保留并转 `needs_review`，不可静默覆盖当前事实。
8. **失败可重试**：事件已落库但处理失败时，重试必须复用同一个 `idempotency_key`，不能产生第二次业务效果。失败分类与 `submitted` 写入 WorkflowInstanceState 的 `failure_classification` / `failure_submitted` / `failure_retry_after`，重启后仍生效。`transient` 且 `submitted !== 'unknown'` 时允许自动重试；`permanent` 或 `submitted === 'unknown'` 时 `retry` 必须拒绝。见 `docs/domain.md`「Executor Error Contract」与「Audit 契约」。
9. **终态保护**：Lead 已 `disqualified`/`closed` 或 Deal 已 `won`/`lost` 后，默认不再自动恢复原 Workflow；新事实只能产生明确的后续流程或人工审核。已经结束（`completed` / `cancelled`）的实例上再到达的事件按 `processed` 消费并以 `workflow_ended` 进入异常队列，事实照常合并，但原流程不被重新唤醒。
10. **审计先行**：状态迁移、Decision、Policy 结论、人工操作和执行结果均追加 Audit Log，Audit Log 不可修改。
11. **崩溃恢复重放**：EventStore 中的事件是恢复的唯一事实来源。重启后对空 State Store 调用 `recoverFromEventLog()`，按 `sequence` 重放全部事件重建 State；`pending` 事件完整处理并 `markProcessed`，已处理事件幂等重放。事件仍为 `pending` 且 Workflow 已是 `failed` 时，重投事件按 `retry` 语义先恢复 `running` 再规划。多 worker 并发时通过事件处理租约（claim lease）保证同一 `idempotency_key` 同一时刻仅一个 worker 处理。

    入口由 `Application.recoverOnStart()` 执行（`src/app/bootstrap.ts`），在**开始监听之前**完成：
    State Store 为空而事件日志非空时重放全部事件；否则只重投仍为 `pending` 的事件（复用同一 `idempotency_key`）；
    已经有未处理异常的事件不再自动重投，避免每次启动都刷一条异常，交给人工通过控制面处理。

    **恢复不盲目调用外部 Executor**：外部副作用（发邮件、建会议、发方案等）无法幂等重放，因此重放期间不调用 `Executor.execute`。重放只按确定性 Decision + Policy 重建「已派发、等待结果（`waiting_result`）」状态，并写入 `action_dispatched` 审计；真实副作用交由结果事件确认或 provider 对账，绝不重放第二次。执行失败的 `failure_*` 字段持久化在 WorkflowInstanceState（而非事件日志），仅在 State Store 未清空时跨重启保留。
