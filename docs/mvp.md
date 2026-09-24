# MVP Acceptance Criteria

## 最小闭环验收标准

MVP 以一个 Lead 的单一销售跟进 Workflow 为范围，必须能够完成以下闭环：

1. 接收 `lead.created`，校验事件信封并按 `idempotency_key` 去重。
2. 创建或幂等恢复唯一的 WorkflowInstance，业务 key 为 `(workflow_type, lead_id)`。
3. 接收 `lead.assigned`，更新 Lead 当前负责人并进入首次跟进规划。
4. Decision 根据 Context 输出 ProposedAction，不直接执行外部动作。
5. Policy 能将动作判定为 `Auto` 或 `Human Review`，并能阻止硬性禁止动作。
6. Auto 动作或 Approved 动作通过接口化 Executor 发起，但只有对应结果事件才能确认动作成功。
7. 至少支持 `deal.created`、`email.sent`、`email.replied`、`meeting.scheduled`、`proposal.sent`、`deal.stage_changed` 和 `task.overdue` 对 Workflow 的恢复。
8. 结果事件会更新当前 State、完成等待节点并触发新的 Replan；旧计划不会覆盖新计划。
9. Deal 通过 `deal.created` 从 `qualification` 建立，并按状态机允许的相邻迁移推进至 `discovery`、`proposal`，最终进入 `won` 或 `lost`；不合法的阶段迁移会被拒绝。
10. 所有事件处理、状态迁移、Decision、Policy、审批和执行结果均写入只追加 Audit Log。
11. Store、Executor 和外部事件来源均通过接口定义，MVP 提供 InMemory 实现用于测试。
12. 服务重启或重复消费后，不能重复发送邮件、重复创建任务、重复推进阶段或创建第二个 WorkflowInstance。

## 测试用例列表

### 1. 重复事件

- 重复投递相同 `lead.created`，系统只创建一个 Lead 和一个 WorkflowInstance。
- 重复投递相同 `lead.assigned`，负责人只发生一次有效更新。
- 重复投递相同 `email.replied`，Workflow 只恢复一次，不重复创建会议建议或任务。
- 重复投递相同 `deal.created`，只创建一个 Deal 且不重复关联 Workflow。
- 重复投递相同 `deal.stage_changed`，Deal 不产生额外阶段变更或重复 Audit Log 业务结果。
- 使用相同 `idempotency_key` 但不同 payload 时，系统拒绝冲突并进入异常/人工处理，不静默覆盖原事件。

### 2. 人工拒绝

- Policy 将高风险 ProposedAction 标记为 `Human Review`。
- 授权人员拒绝动作并填写原因后，系统追加拒绝 Audit Log。
- 原 ProposedAction 不得再次自动执行。
- Workflow 基于拒绝原因进入 Replan，生成新的 `action_id` 和 `plan_version`。
- 新 ProposedAction 必须再次经过 Policy，不能绕过审批。

### 3. 结果事件恢复

- 邮件发送动作获批后，在收到 `email.sent` 前不能把邮件状态标记为已发送。
- 收到匹配的 `email.sent` 后，Workflow 进入等待回复或后续步骤。
- 收到 `email.replied` 后，Workflow 从等待节点恢复并提出下一步建议。
- 收到 `meeting.scheduled` 后，Workflow 更新当前事实，不重复安排同一会议。
- 收到 `proposal.sent` 后，Deal 进入或保持 `proposal` 阶段并等待客户结果。
- 收到 `task.overdue` 后，恢复超时分支，产生补救建议或人工审核。
- 结果事件迟到或与当前 Deal 阶段冲突时，不得覆盖新事实，应进入异常或 `needs_review`。

### 4. 审计日志

- 每条 Audit Log 都包含时间、主体、事件或 action 标识、前后状态摘要、操作者/来源和 Policy/计划版本。
- Audit Log 只能追加，任何更新或删除请求都会失败。
- 同一重复事件不会重复产生相同业务效果；系统能关联原始事件与处理记录。
- 能查询一次人工批准、执行尝试、外部结果和最终状态迁移的完整链路。
- Audit Log 中记录 Rejected 与 Policy Reject 的区别及原因。

### 5. 状态与流程一致性

- 未分配的 Lead 不能直接进入需要负责人的自动发送动作。
- 已 `won` 或 `lost` 的 Deal 不接受普通自动跟进迁移。
- 不存在的 WorkflowInstance 只能在允许创建的入口事件上创建，不能因任意结果事件凭空创建流程。
- Workflow 失败后重试使用同一事件幂等 key，并且不会产生重复业务效果。
- 所有 InMemory Store 和 Executor 测试都覆盖成功、重复、冲突、失败和人工介入路径。
