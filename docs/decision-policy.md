# Decision and Policy

## Decision 边界

Decision 组件回答“基于当前事实，下一步建议做什么”，但不执行动作。它只输出一个或多个 `ProposedAction`，每个动作都必须能够被审计、审核、批准、拒绝和重新规划。

### 输入 Context

Decision 输入的 Context 至少包括：

- `workflow_instance`：工作流类型、当前节点、状态、等待条件和 `plan_version`
- `lead_state`：Lead 当前事实和负责人
- `contact_state`：联系人身份、联系方式和联系偏好
- `deal_state`：Deal 当前阶段、金额、预测时间和阶段历史摘要
- `recent_events`：相关的近期不可变事件
- `memory`：历史互动摘要、客户偏好和有效上下文
- `pending_tasks`：尚未完成、已逾期或等待结果的任务
- `policy_context`：适用的 Policy 版本、组织规则、时间窗口、权限和合规限制
- `previous_decisions`：相关 ProposedAction 的状态及人工意见
- `idempotency_context`：当前输入事件和已处理事件 key

Context 是 Decision 的输入快照。它不是新的事实来源；当前事实仍以 State 为准，历史证据以事件和 Memory 为准。

### 输出 ProposedAction

每个 ProposedAction 至少包含：

- `action_id`
- `action_type`：例如 `send_email`、`schedule_meeting`、`create_task`、`send_proposal`、`advance_deal_stage`
- `subject_id` 和关联实体标识
- `parameters`：动作所需参数或模板引用
- `reason`：基于哪些事实和事件提出
- `expected_outcome`
- `risk_level`
- `policy_version`
- `plan_version`
- `requires_approval`
- `expires_at`

**时间字段的锚点**（见 `src/decision/context.ts` 的 `DecisionContext.proposed_at`）：`expires_at` 从
**「建议提出时刻」与「事实判定时刻」中较晚者**起算 `ACTION_METADATA[action_type].default_ttl_hours`；
`create_task` 的 `due_at`（起算点后 24h）与 `schedule_meeting` 的 `earliest_start_at` 用同一个起算点。
这三者都是「建议发出后多久失效 / 最早何时可以执行」的墙上时钟属性，不是事实属性。

- 事实较早（正常情况、CRM 回填、导入、webhook 迟到）→ 用提出时刻，建议不会**出生即过期**；
  否则人工批准会被 `action_expired` 静默吞掉并转入 stale 重规划。
- 事实较晚（客户端时钟偏差、预置的未来时间）→ 用事实时刻，保证刚提出的建议满足
  `expires_at > evaluated_at`，不会在出生那一刻就被 Policy 判过期并静默丢弃。

窗口与事实类判定仍用 `evaluated_at`（= 触发事件 `occurred_at`），保持「同一事件在任何时刻处理得到同一结论」。

ProposedAction 不代表动作已经发生。只有执行器在取得有效的 Auto 结论或人工 Approved 后，才可以尝试执行。真实执行结果必须由外部结果事件确认，例如 `email.sent`、`meeting.scheduled` 或 `proposal.sent`。

## Policy：Auto 还是 Human Review

Policy 对每一个 ProposedAction 独立判断，输出：

- `Auto`：满足自动化条件，可以交给 Executor 尝试执行
- `Human Review`：必须先由授权人员批准
- `Reject`：动作违反硬性规则，不进入执行

### 可自动执行的条件

通常同时满足以下条件时可以 `Auto`：

1. 动作类型在组织允许的自动化白名单内。
2. Context 的 State、事件版本和关联关系完整且未冲突。
3. ProposedAction 的 `plan_version` 与当前 WorkflowInstance 版本一致。
4. 不触发高风险、合规、隐私或财务授权规则。
5. 联系偏好、发送时间窗口和频率限制均满足。
6. 所需参数来自可信 State 或已验证的配置，不需要模型猜测。
7. 幂等 key 已生成且尚未执行；重复执行不会造成第二次业务效果。
8. 组织和操作者权限允许该动作。

### 必须人工审核的情况

出现以下任一情况，Policy 应输出 `Human Review`：

- 发送给新联系人、关键客户或高价值 Deal 的外部沟通
- 涉及报价、折扣、合同、承诺、法律或财务条款
- 需要覆盖客户明确的联系偏好或合规限制
- State 与事件、Memory 或 CRM 数据冲突
- 结果不确定、关联关系不确定或需要人工判断语义
- 动作会推进高风险 Deal 阶段或关闭销售机会
- 自动化频率、发送窗口或重试次数达到阈值
- Policy 版本变化导致旧 ProposedAction 不再可信

硬性禁止项直接输出 `Reject`，例如已退订联系人、已关闭 Deal 上的普通跟进、无权限的合同动作。`Reject` 与人工拒绝不同：前者表示规则不允许，后者表示授权人员拒绝了一个原本可审查的建议。

## Approved / Rejected 后的 Replan

### Approved

1. 追加记录人工审批 Audit Log，包含审批人、时间、审批依据、原始 `action_id` 和 Policy 版本。
2. 重新读取当前 State，确认 ProposedAction 未过期、未被新事件取代，且 `plan_version` 仍有效。
3. 将 WorkflowInstance 置为 `replanning`，生成新的计划版本或确认当前 action 的执行版本。
4. 把批准后的动作交给接口化 Executor，并使用稳定的执行幂等 key。
5. 不把“已批准”当作“已发生”；必须等待外部结果事件更新 State 并恢复 Workflow。
6. 若执行失败，追加失败 Audit Log，并按失败策略重试或转人工处理。
7. 若第 2 条复核发现动作已失效：不执行该动作，而是作废它（`decision` 留空、审计 `action_stale`）并按当前 State 重新规划，响应中的 `stale_action_replanned` 为 `true`。失效不写入 `previous_decisions`——计划过时不等于人工否决这个动作类型，否则一次过期会永久拉黑它。

### Rejected

1. 追加记录拒绝 Audit Log，包含拒绝人、时间、原因、原始 Context 摘要和 `action_id`。
2. 使被拒绝的 ProposedAction 失效，不得自动重试同一动作或绕过审批再次执行。
3. 将拒绝原因作为新的规划约束，例如“不发送该模板”“改为人工联系”或“等待客户主动回复”。
4. 进入 `replanning`，重新读取当前 State 和最新事件，生成新的 ProposedAction。
5. 新动作必须拥有新的 `action_id` 和 `plan_version`，并重新经过 Policy 判断。
6. 如果没有安全替代动作，则进入 `waiting_result`、`needs_review` 或结束 Workflow，而不是无限循环规划。
7. 约束的有效期锚定在拒绝时已处理的最后一条事件上（`previous_decisions[].basis_event_id`）：
   只要没有更新的事件进入，同一动作类型不会被重新提出，避免“拒绝 → 立刻原样重提 → 再拒绝”的拉锯。
8. 新事件进入后，同一动作类型可以被重新提出，但 Decider 必须把它标记为 `requires_approval: true`，
   重新经过 Policy 与人工审批——不得因为约束解封就绕过上一次人工拒绝自动执行。
   历史数据缺少 `basis_event_id` 时按本条处理：可重新提出、但必须审核，不永久阻断。

所有 Approved、Rejected、Policy 结果、Executor 调用和外部结果都写入只追加 Audit Log。Audit Log 不用于直接覆盖 State。

## 已实现的判定契约

本节记录 `src/decision` 与 `src/policy` 中已经可执行的契约，与上文规则一一对应。

### Context 中承载规则判断的输入

- `verified_config`：已验证配置（邮件模板、方案文档引用、默认会议时长）。缺少对应配置时 Decider 直接放弃该动作，不编造参数。
- `data_conflicts`：State 与事件、Memory 或 CRM 数据之间的冲突说明。非空表示事实不可信。
- `policy_context`：Policy 版本、判定时刻 `evaluated_at`、自动化白名单、组织允许的动作类型边界、允许的操作者、业务时区偏移、发送窗口、每日自动动作上限、关键客户与高价值阈值。
- `previous_decisions`：相关 ProposedAction 的历史结论。状态为 `rejected` 的动作类型，在其 `basis_event_id`
  仍是最后一条已处理事件期间不会被重复提出；新事件进入后可以重新提出，但 `requires_approval` 强制为 `true`。
  拒绝原因因此成为**有边界**的规划约束：既不会被无视，也不会永久拉黑该动作类型。

### 判定顺序

Policy 固定按 `Reject` → `Human Review` → `Auto` 判定：

1. 命中任一条硬性禁止项即 `Reject`，全部命中原因写入审计，`code` 为首个命中项。
2. 逐条检查下方 8 个可自动执行条件；任一条件不满足即 `Human Review`，并给出对应原因。
3. 全部条件满足才 `Auto`，同时记录已满足的条件清单。

硬性禁止项编码：`missing_idempotency_key`、`already_executed`、`action_expired`、`stale_plan_version`、`terminal_subject`、`unsubscribed_contact`、`unauthorized_action`。

人工审核原因编码：`not_automation_eligible`、`new_or_key_contact`、`high_value_deal`、`commercial_terms`、`contact_preference_override`、`data_conflict`、`uncertain_basis`、`high_risk_stage_advance`、`automation_limit_reached`、`stale_policy_version`，以及兜底编码 `auto_condition_not_met`。

### 可自动执行条件的编码

| 编码 | 含义 |
| --- | --- |
| `action_type_whitelisted` | 动作类型在自动化白名单内 |
| `context_integrity_ok` | 无事实冲突，且动作的 Workflow、主体与关联 Deal 与当前 State 一致 |
| `plan_version_current` | 动作 `plan_version` 与当前 WorkflowInstance 一致 |
| `risk_within_auto_limit` | 风险等级不超过自动执行上限，且不涉及商业条款或高风险阶段推进 |
| `communication_window_ok` | 处于发送窗口内且未超过每日自动动作上限；发送窗口只约束对外沟通 |
| `parameters_trusted` | 参数来自可信 State 或已验证配置，不来自模型推断 |
| `execution_idempotent` | 已生成执行幂等 key，且该 key 尚未产生业务效果 |
| `actor_permitted` | 当前负责人被授权触发自动动作 |

### Decision 的动作元数据

动作类型的风险等级、有效期、是否属于对外沟通、是否涉及商业条款集中定义在 `ACTION_METADATA`，是 Decision 与 Policy 共用的唯一来源。Decider 只按规则产出建议，`action_id` 与执行幂等 key 由 Decider 统一生成；注入固定生成器即可让同一 Context 的决策完全可复现。

### 规则之间的优先级约束

规则按优先级取第一个能产出动作的规则（`DECISION_RULES`）。为避免「先建立的 Deal」压住 Lead 侧的互动流程，`qualificationAdvanceRule` 额外要求 Lead 已发生有效互动：

- Lead 处于 `new` / `assigned` 时，即使 CRM 已经建立了 Deal，也**不**提出阶段推进。`deal.created` 是事实类事件，任何时刻都会落库，若此时就推进阶段，会立刻产生一条人工审核并阻塞首次跟进邮件与会议。
- Lead 进入 `engaged` / `qualified` / `converted` 后，阶段推进才成为候选动作（对应状态机 `qualified` + `deal.created` → `converted`）。

对应实现与回归用例：`src/decision/rule-based-decider.ts`、`src/decision/rule-based-decider.test.ts`。

### 批准时的复核

`Approved` 的第 2 条由引擎在批准时执行：重新构造 Context 并让 Policy 再判一次，命中任一硬性禁止项
（`action_expired`、`stale_plan_version`、`terminal_subject`、`unsubscribed_contact`、`unauthorized_action`、
`missing_idempotency_key`、`already_executed`）即判定该动作已失效。
失效既不执行也不报错：作废旧动作、写 `action_stale` 审计、按当前 State 重新规划（`needs_review` + `stale_action` → `replanning`），
实例因此离开 `needs_review`，控制面响应里的 `stale_action_replanned` 为 `true`。
审批入口开放在控制面上，不能假设审核人一定看得到最新 State；把决定权交回 Decider，比让实例卡死或直接报错更可推进。
控制面另提供 `POST /workflows/{id}/replan`：人工主动作废待审动作并重新规划，审计记 `replan_requested`，同样不写拒绝结论。
