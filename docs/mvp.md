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

## 依赖的外部事件与入口

以下事实必须由事件声明，引擎不会猜测（见 `docs/events.md`）：

| 事实 | 事件 | 缺失后果 |
| --- | --- | --- |
| 联系人邮箱与联系偏好 | `contact.recorded` | 没有邮箱时 Decider 不提出 `send_email`，Workflow 停在等待状态而不是编造收件人 |
| Deal 建立与阶段 | `deal.created` / `deal.stage_changed` | 由 CRM 提供；缺失时 Deal 侧规则不触发 |
| 人工审批 | 控制面 `POST /workflows/{id}/approve|reject`（`docs/deployment.md` 第 5 节） | `needs_review` 的实例无法推进 |
| 不确定提交的对账 | 控制面 `POST /workflows/{id}/reconcile`（第 5.3 节） | `submitted === 'unknown'` 的实例既不能重试、也无法恢复 |
| 异常处理与重放 | 控制面 `POST /exceptions/{id}/resolve|discard|replay`（第 5.4 节） | 未匹配/冲突的事件只能线下处理 |

## 已知取舍

- `needs_review` 期间到达的非事实类事件（如外部 `deal.stage_changed`）会合并事实并写入异常队列，
  但不会自动推进 Workflow：需要人工先完成审批，或通过控制面处理异常后重投。
- 未被任何 Workflow 认领的事件保持 `pending`（不标记已处理），以便补建 Workflow 后通过
  `replay` 接回正常路径；同一事件已有未处理异常时不会重复入队。
- 派发动作失败时 HTTP 仍返回 `processed`（事件事实确实已被处理、审计已写入），
  但实例会落到 `failed`；调用方应以 `GET /workflows/{id}` 的实例状态为准，而不是只看接收响应。
- 控制面是内部运维接口，不做 HMAC 签名；必须配置 Token，并限制在内网可达。
- 单实例部署：限流与重放缓存是进程内状态，SQLite 同一时刻只允许一个写事务。
  多实例需要在入口网关做限流/去重，且不要多个进程写同一个库文件。
- 运行在实验性能力上：`--experimental-transform-types` 与 `node:sqlite`（Node 22 标记为 experimental）。
  升级 Node 必须回归 `src/stores` 全部测试。
- 事件与审计只追加、无归档策略，会持续增长。查询路径已索引化（见 `docs/runtime.md`），
  但长期运行仍应规划归档与保留周期。
- 尚无告警规则：`/metrics` 提供 `open_exceptions`、`workflows_by_status` 等 gauge 供外部告警系统采集。

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

Webhook 响应层语义：`event_status` 表示事件处理结果，`workflow_status` 表示关联 Workflow 当前状态；派发失败仍返回 HTTP `200`、`event_status=processed`，但 `workflow_status=failed`。
