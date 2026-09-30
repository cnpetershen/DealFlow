# 端到端走查记录与已知问题

`docs/operations.md` 第 9 节的「销售一天」演练 + `node scripts/single-instance-acceptance.mjs`
单实例验收的**实际运行记录**。本文只记录真跑出来的东西，不重复文档里的设计描述。

## 1. 走查环境

| 项 | 值 |
| --- | --- |
| 时间 | 2026-09-30 23:07（+08:00），事件时间按当天 09:15–16:00 生成 |
| 代码版本 | `master`，含本次修复（固定测试时钟、走查脚本改为运行当天） |
| 实例 | `DEALFLOW_PORT=3123`，`DEALFLOW_DB_PATH=acceptance/sales-daily.db`（全新空库） |
| 鉴权 | `DEALFLOW_CONTROL_PLANE_TOKEN=dev-token`；Webhook 未配 Token/HMAC |
| 脚本 | `scripts/sales-day-walkthrough.mjs`（21 个事件）+ `scripts/single-instance-acceptance.mjs` |

```bash
DEALFLOW_PORT=3123 DEALFLOW_DB_PATH="$PWD/acceptance/sales-daily.db" \
DEALFLOW_CONTROL_PLANE_TOKEN=dev-token npm start
node scripts/sales-day-walkthrough.mjs
ACCEPTANCE_BASE=http://127.0.0.1:3123 node scripts/single-instance-acceptance.mjs
```

一键复跑（含类型检查、全量单测、自起实例、走查与断言）：`npm run accept`，
报告写到 `acceptance/report-<时间戳>.json`；产物目录已被 `.gitignore` 忽略，见 `acceptance/README.md`。

## 2. 走查结果：21 个事件全部符合预期

| # | 环节 | 观测 |
| --- | --- | --- |
| 1 | 三条线索进线 | 三个 Workflow 创建，`/leads` 显示 `status=new` |
| 2 | 登记联系人 | 三个实例转 `waiting_result`（等待分配） |
| 3 | 分配负责人 | 三个实例转 `needs_review`，待审队列 3 条 `send_email` |
| 4 | 审批首封邮件 | 三条 `stale_action_replanned=false`，转 `waiting_result`，等待 `email.sent` |
| 5 | 邮件回执 | 三个实例消费 `email.sent` 并进入推导等待 `email.replied` |
| 6 | 销售看板 | 401（无 Token）/ 404（不存在线索）符合设计，过滤与分页正常 |
| 7–8 | 客户回复 → 批准约会议 | Lead 转 `engaged` → `needs_review`(`schedule_meeting`) → 批准 → `waiting_result` |
| 9 | 日历回执 | `meeting.scheduled` 消费，Lead 转 `qualified`，等待 `deal.created` |
| 10 | CRM 建商机 | 提出 `advance_deal_stage`（reason：Deal 仍处于 qualification，资格确认已完成），批准后等待 `deal.stage_changed` |
| 11 | 阶段推进 + 提案 | Deal `qualification → discovery → proposal`（由 `proposal.sent` 推进），事实与阶段一致 |
| 12 | 拒绝约会议 | `action_rejected` 审计写入；同上下文**不再重提**（plan_version 保持 8，队列为空） |
| 13 | 新事实唤醒 | 新 `deal.created` 到达后重新提出，`requires_approval=true` 且 reason 标注「该动作此前被人工拒绝，需再次审批」；批准后正常派发 |
| 14 | 取消 + 迟到回复 | 实例保持 `cancelled`；迟到 `email.replied` 按 `processed` 消费并进异常队列（`workflow_ended`），`resolve` 结案成功 |
| 15 | 成交 | `deal.stage_changed → won`，Deal `stage=won`、`outcome=合同签署`，Workflow `completed` |
| 16 | 收盘看板 | 3 个实例终态/等待正确；审计链完整覆盖 `decision_proposed → policy_evaluated → action_approved/rejected → action_dispatched` |

**验收脚本**：19 PASS / 0 FAIL（含信封校验、幂等去重、唯一实例、Human Review、批准派发、结果恢复、非法阶段迁移入异常、审计只追加、有效期锚点）。

**重启恢复**：同库重启后审计 105 条不变、6 个实例状态与 `plan_version` 逐一相同、3 个 Deal 阶段相同；重投重启前已处理的 `lead.created:muo8ow1h:1` 返回 `duplicate`，实例数 6 → 6。恢复期间无重复副作用。

## 3. 本次修复的两个问题

### 3.1 测试套件与真实时钟耦合（13 个用例失败）

`src/testing/fixtures.ts` 的事件时间固定在 `2026-09-24`，动作 `expires_at = 事件 occurred_at + 动作 TTL`
（`send_email` 48h / `schedule_meeting` 72h / `advance_deal_stage`、`create_task` 168h），
而控制面 `approve` 回退到真实时钟取判定时刻。于是写测试后 48–72 小时之外，
所有「审批 → 派发」用例都会被判 `action_expired` 并转入 stale 重规划。

- 失败面：`approval-failure`(4) / `engine-resume`(4) / `engine`(2) / `control-plane`(1) / `retry-scheduler`(1) / `provider-receipt-audit`(1)；
- A/B 对照（同一份代码、同一组事件，只换时钟）见 `scripts/clock-coupling-proof.mjs`：
  真实时钟 `stale_action_replanned=true`、`needs_review`；注入 `2026-09-24T10:05+08:00` 则 `false`、`waiting_result`；
- **修复**：`src/testing/fixtures.ts` 新增 `FIXED_NOW_ISO` / `fixedNow`，
  6 个测试文件的引擎工厂统一注入 `now: fixedNow`（`src/app/bootstrap.test.ts` 本来就是这个写法）。
  修复后 `npm run typecheck` 退出码 0，`npm run test:run` **49 文件 / 635 用例全部通过**。

### 3.2 走查脚本写死历史日期

`scripts/sales-day-walkthrough.mjs` 把所有事件时间写死为 `2026-09-26`，按 3.1 的机制，
演练中的每次批准都会过期，后续会议、阶段、成交全部偏离文档描述。

- **修复**：事件时间改为基于运行当天（+08:00）的 09:15–16:00 生成；09:00 之前运行则锚点回退一天；
  `scheduled_start_at` / `expected_close_at` 改为相对当天计算；`BASE`/`TOKEN` 支持
  `WALKTHROUGH_BASE` / `WALKTHROUGH_TOKEN` 覆盖；目标实例无待审动作时给出明确提示而不是抛异常。

## 4. 第二轮修复（原 P2 / P3 遗留问题）

### 4.1 动作有效期锚点：建议不再「出生即过期」

**症状**：用 96 小时前的事件时间投递进线 → 分配，得到 `send_email` 时它的 `expires_at` 已经是过去时刻，
第 1 次 `approve` 返回 `stale_action_replanned=true`、实例退回 `needs_review`，销售看到「批准了却没动静、
同一条建议又回来了」。触发条件是 CRM 回填、导入或 webhook 重试晚于动作 TTL。

**根因**：`expires_at = 触发事件 occurred_at + TTL`，而审批复核用的是真实时钟——事实一旧，建议出生就过期。

**修复**：有效期起点改为 **`max(建议提出时刻, 事实判定时刻)`**（`src/decision/rule-based-decider.ts` 的
`proposalAnchor`），新增 `DecisionContext.proposed_at` 承载「建议提出时刻」（引擎时钟）。同一个起算点也用于
`create_task.due_at`（起算点 + 24h）与 `schedule_meeting.earliest_start_at`：

- 事实较早（回填 / 迟到）→ 用提出时刻，建议不会出生即过期；
- 事实较晚（客户端时钟偏差、预置未来时间）→ 用事实时刻，保证 `expires_at > evaluated_at`
  这一 Policy 判定依赖的不变量成立，**刚提出的建议永远不会立刻被判 `action_expired` 并静默丢弃**。

窗口与事实类判定仍用 `evaluated_at`（= 触发事件 `occurred_at`），「同一事件在任何时刻处理得到同一结论」没有被破坏。

**验证**（`scripts/ttl-anchor-check.mjs`，96 小时前的事件时间）：

```text
修复前：第 1 轮 approve → stale_action_replanned=true, needs_review（action_stale 审计 1 条），要再批一次
修复后：第 1 轮 approve → stale_action_replanned=false, waiting_result，action_stale 审计 0 条
        expires_at=2026-10-02T15:17Z（= 批准前 48h，即提出时刻 + send_email TTL）
```

回归测试：`src/decision/rule-based-decider.test.ts`（有效期锚点、事实更晚的不变量、`due_at`、`earliest_start_at`）
与 `src/workflow/engine.test.ts`（事件很旧时 1 小时后批准仍执行；超过 TTL 才判 stale）。

### 4.2 `pending_action.requires_approval` 语义（原 P3）

**症状**：新联系人的 `send_email` 在 `GET /workflows?status=needs_review` 里报 `requires_approval: false`，
而同一条的 `policy_evaluated` 审计写的是 `new_or_key_contact: … 外发沟通必须先审核`。

**根因**：该字段原先直接透出 Decider 的草案标记——它是 Policy 的**输入**（`requires_approval: true` 会命中
`not_automation_eligible`），只在「被人工拒绝后重新提出」时为 true，不回答「这条要不要我批」。

**修复**：控制面视图（`src/http/control-plane.ts` 的 `summarize`）按有效结论输出：
`pending_action.requires_approval = 草案标记 || workflow.status === 'needs_review'`。
存储与审计保持 Decider 原始输出不动，语义写在 `docs/operations.md` 第 4 节。

**验证**：演练实例上待审队列现在全部为 `true`（修复前 `send_email` 为 `false`）；
回归测试见 `src/http/control-plane.test.ts`「待审动作对外报告 requires_approval=true」。

### 4.3 剩余约定（非缺陷）

`src/testing/fixtures.ts` 的事件时间仍写死 `2026-09-24`。本次已给 6 个会产生待审动作并调用
`approve`/`reject` 的测试文件注入固定时钟，但约定要固化：**凡构造 `WorkflowEngine` 的测试工厂必须注入 `now`**
（`WorkflowEngineOptions.now` 已存在），否则会再次出现「写完 2–3 天后变红」的漂移。

## 5. 环境记录（非项目缺陷）

本次会话的受限 shell 只能写工作区根目录和根下新建目录，无法写入已存在的 `src/`、`docs/`、`data/`、`scripts/`，
因此演练库放在 `acceptance/` 下；直接用 `.env` 的 `data/manual-run.db` 启动会报 `unable to open database file`。
正常（非沙箱）运行不受影响。

## 6. 证据文件

| 文件 | 内容 |
| --- | --- |
| `acceptance/walkthrough-run1.txt` / `walkthrough-run2.txt` | 21 个事件的完整走查输出（第一轮 / 修复后） |
| `acceptance/acceptance-live.txt` / `acceptance-live2.txt` | 单实例验收断言输出（18 项 / 修复后 19 项） |
| `scripts/ttl-anchor-check.mjs` | 有效期锚点回归脚本（4.1 的验证，退出码判定） |
| `scripts/clock-coupling-proof.mjs` | 3.1 的 A/B 对照实验（退出码判定） |
| `acceptance/tests-after-fix.txt` | 修复后 `npm run test:run` 完整输出（635 通过） |
| `acceptance/tests-full.txt` | 修复前 13 个失败的完整输出（对照用） |
