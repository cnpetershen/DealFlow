# Event Dictionary

## 通用事件约束

所有事件都是不可变事实，事件一旦发布不得原地修改。事件必须包含以下信封字段：

| 字段 | 含义 |
| --- | --- |
| `event_id` | 事件的全局唯一标识 |
| `type` | 事件类型，例如 `lead.created` |
| `version` | 事件 payload 的 schema 版本，从 `1` 开始 |
| `occurred_at` | 事实在来源系统发生的时间，使用带时区的时间 |
| `idempotency_key` | 来源系统为同一事实提供的稳定去重键 |
| `payload` | 与事件类型和版本绑定的业务数据 |
| `source` | 产生或接入该事件的系统、连接器或人工操作来源 |

事件处理器以 `idempotency_key` 去重，并保留已经处理过的 key。重复事件不得重复推进 State、重复创建任务或重复写入执行结果。

## 事件字典

### `lead.created`

- `event_type`: `lead.created`
- `version`: `1`
- `payload`:
  - `lead_id`: 新 Lead 标识
  - `source_channel`: 来源渠道
  - `source_record_id`: 来源系统记录标识
  - `company_name`: 公司名称，可为空
  - `contact_id`: 初始联系人标识，可为空
  - `initial_owner_id`: 初始负责人，可为空
- `idempotency_key`: `lead.created:{source}:{source_record_id}`
- 来源：CRM、表单、广告平台、导入任务或其他 Lead 接入连接器。

### `lead.assigned`

- `event_type`: `lead.assigned`
- `version`: `1`
- `payload`:
  - `lead_id`
  - `owner_id`: 新负责人
  - `previous_owner_id`: 原负责人，可为空
  - `assignment_reason`: 规则、人工或重新分配原因
- `idempotency_key`: `lead.assigned:{lead_id}:{owner_id}:{assignment_revision}`
- 来源：分配规则引擎、CRM 或人工操作。

### `email.sent`

- `event_type`: `email.sent`
- `version`: `1`
- `payload`:
  - `message_id`: 邮件消息标识
  - `lead_id`、`contact_id`
  - `sender_id`
  - `recipient_email`
  - `template_id`，可为空
  - `workflow_instance_id`，可为空
  - `sent_at`
- `idempotency_key`: `email.sent:{provider}:{message_id}`
- 来源：邮件服务商 webhook、邮件连接器或发送服务的事实回执。

### `email.replied`

- `event_type`: `email.replied`
- `version`: `1`
- `payload`:
  - `message_id`: 被回复的原邮件或线程标识
  - `reply_id`: 回复消息标识
  - `lead_id`、`contact_id`
  - `reply_at`
  - `sentiment` 或 `intent`，若来源系统提供
  - `body_reference`: 正文存储引用，不直接要求事件携带完整正文
- `idempotency_key`: `email.replied:{provider}:{reply_id}`
- 来源：邮件服务商 webhook 或邮件同步连接器。

### `meeting.scheduled`

- `event_type`: `meeting.scheduled`
- `version`: `1`
- `payload`:
  - `meeting_id`
  - `lead_id`、`contact_id`
  - `organizer_id`
  - `scheduled_start_at`、`scheduled_end_at`
  - `calendar_provider`
  - `status`: 例如 `scheduled`
- `idempotency_key`: `meeting.scheduled:{provider}:{meeting_id}:{revision}`
- 来源：日历系统 webhook 或会议调度连接器。

### `proposal.sent`

- `event_type`: `proposal.sent`
- `version`: `1`
- `payload`:
  - `proposal_id`
  - `deal_id`、`lead_id`、`contact_id`
  - `sender_id`
  - `amount`、`currency`，可为空
  - `document_reference`
  - `sent_at`
- `idempotency_key`: `proposal.sent:{provider}:{proposal_id}:{revision}`
- 来源：报价/合同系统、文档发送服务或 CRM。

### `deal.created`

- `event_type`: `deal.created`
- `version`: `1`
- `payload`:
  - `deal_id`: 新 Deal 标识
  - `lead_id`: 来源 Lead 标识
  - `contact_id`: 关联联系人标识，可为空
  - `owner_id`: 负责人，可为空
  - `initial_stage`: 初始阶段，MVP 固定为 `qualification`
  - `amount`、`currency`: 预计金额与币种，可为空
  - `expected_close_at`: 预计成交时间，可为空
  - `source_record_id`: 来源系统记录标识
- `idempotency_key`: `deal.created:{source}:{source_record_id}`
- 来源：CRM、Lead 转化服务或销售人员人工创建。

Deal 只能通过该事件进入系统。`deal.stage_changed` 只负责推进已存在 Deal 的阶段，不能凭空创建 Deal。

### `deal.stage_changed`

- `event_type`: `deal.stage_changed`
- `version`: `1`
- `payload`:
  - `deal_id`
  - `lead_id`
  - `from_stage`
  - `to_stage`
  - `changed_by`: 用户或系统标识
  - `reason`，可为空
- `idempotency_key`: `deal.stage_changed:{deal_id}:{stage_revision}`
- 来源：CRM、销售人员操作或受控的阶段更新服务。

### `task.overdue`

- `event_type`: `task.overdue`
- `version`: `1`
- `payload`:
  - `task_id`
  - `lead_id`、`deal_id`，至少一个不为空
  - `workflow_instance_id`
  - `task_type`
  - `assigned_to`
  - `due_at`
  - `overdue_at`
- `idempotency_key`: `task.overdue:{task_id}:{overdue_revision}`
- 来源：任务调度器或任务系统。

## 事件处理顺序与来源可信度

事件按 `occurred_at` 记录事实时间，同时按接收顺序进入处理管道。迟到事件不能直接覆盖更新的 State；处理器必须依据实体版本、阶段规则或事件来源版本判断是否仍然有效。无法安全判断时，保留事件并进入人工审核或异常队列。

## Result Event 契约

提供商回执与外部结果事件在通用信封之上，payload 约定以下对账字段（可空，字段必须存在）：

| 字段 | 含义 |
| --- | --- |
| `provider_reference` | 提供商侧唯一回执标识（如邮件 message-id） |
| `provider` | 提供商标识，如 `mailgun`、`sendgrid` |
| `correlation_id` | 提供商关联 id，用于与本地 `action_id` / `execution_idempotency_key` 对账 |

### 关联与幂等

1. **如何关联 `action_id` / `execution_idempotency_key`**：结果事件通过 `workflow_instance_id`（或 `lead_id`）+ 事件类型匹配 Workflow 当前 `awaiting_event_types`；提供商对账通过 `provider_reference` / `correlation_id` 反查执行记录。MVP 不强制要求 payload 内嵌 `action_id`。
2. **`provider_reference` 是否参与幂等**：不参与信封 `idempotency_key` 计算。事件幂等仍以 `idempotency_key` 为唯一去重键；`provider_reference` 用于审计追溯与人工对账。
3. **重复结果事件**：同一 `idempotency_key` 第二次投递返回 `duplicate`，不产生第二次业务效果；接收路径可保留 `event_processed` 审计（含 `provider_reference`）。
4. **未知 Action / 无法匹配的结果**：进入异常队列（`unmatched_event`），不静默丢弃。
5. **必须携带 `provider_reference` 的事件**：所有由提供商 webhook 驱动的结果事件（`email.sent`、`email.replied`、`meeting.scheduled`、`proposal.sent`）在提供商可用时必须提供；缺失时为 `null`，并允许进入异常队列做人工对账。

### 与审计的关系

结果事件被匹配消费后，引擎为该 `event_id` 写入的所有 AuditEntry 必须保留 payload 中的 `provider_reference`（见 `docs/domain.md`「Audit 契约」）。
