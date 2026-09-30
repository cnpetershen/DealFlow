# 单实例验收：用一个 Lead 判断项目是否符合预期成果

**预期成果的判定基准**来自仓库自己写下的两份文件，不另外起标准：

| 基准 | 出处 | 内容 |
| --- | --- | --- |
| 最小闭环验收标准（12 条） | `docs/mvp.md` | 一个 Lead 的单一销售跟进 Workflow 必须跑通的闭环 |
| 销售侧承诺的体验 | `docs/sales-manual.md` | 「第一封永远等你批」「拒绝不是拉黑」「接不动就是接不动」等对外承诺 |

本文只回答一件事：**怎么用「一个实例 + 一个 Lead」把上面两条基准变成可重复的通过/失败判定。**

## 1. 一键验收（推荐）

```bash
npm run accept          # typecheck → 全量单测 → 起干净实例 → 21 事件走查 → 单实例断言 → 汇总
npm run accept -- --skip-tests                            # 只验实例行为
npm run accept -- --base http://127.0.0.1:3000 --token T  # 验已有实例，不自己起
```

自带实例生命周期：端口默认 3199，库建在系统临时目录并在结束时清理，报告写到
`acceptance/report-<时间戳>.json`（含每步退出码与单实例断言结果）。退出码 0 = 全绿。

CI 入口就是它：`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `windows-latest` 上跑
`npm ci && npm run accept`；实例不可达或任一断言失败都会让流水线变红（已做负向验证）。

### 分步手工跑

```bash
# ① 起一个干净实例（独立库、独立端口，避免污染 data/manual-run.db）
DEALFLOW_PORT=3124 \
DEALFLOW_DB_PATH="$PWD/acceptance/acceptance.db" \
DEALFLOW_CONTROL_PLANE_TOKEN=dev-token \
DEALFLOW_RETRY_ENABLED=false \
npm start

# ② 另开一个终端：跑单实例验收
node scripts/single-instance-acceptance.mjs
# 自定义目标实例：ACCEPTANCE_BASE / ACCEPTANCE_TOKEN / ACCEPTANCE_WEBHOOK_TOKEN

# ③ 看退出码：0 = 必检项全通过；1 = 有必检项失败（失败项打印实际观测值）
echo $?
```

脚本每次运行都会生成新的 `lead_acc_<随机后缀>`，因此**同一个库可以反复跑**，不会互相干扰。

## 2. 它断言了什么

| 检查 | MVP 条目 | 断言内容 |
| --- | --- | --- |
| `0` | — | `GET /healthz` 返回 `ok` |
| `1a` | 1 | 缺 `occurred_at`/`idempotency_key`/`source` 的事件被拒（HTTP 400） |
| `1b/1c` | 1 | `lead.created` 被接收；同 `idempotency_key` 重复投递 → `duplicate` 且不重复建流程 |
| `2` | 2 | 同一 Lead 只有一个 `WorkflowInstance`，ID 为 `wf_lead_follow_up_<lead_id>` |
| `2b` | 1 | 事实已落库（`GET /leads/{id}`） |
| `3` | 7 | `lead.assigned` 后进入首次跟进规划 |
| `4` | 4 | Decision 只输出 `ProposedAction`（`send_email`），不直接执行 |
| `5` | 5 | Policy 把新联系人外发判为 Human Review（实例停 `needs_review`） |
| `6a/6b` | 6 | `approve` 后派发并进入 `waiting_result`；不被误判为过期动作 |
| `7a` | 7/8 | `email.sent` 被消费 → `plan_version` +1 并进入推导等待 `email.replied` |
| `12` | 12 | 重复投递 `email.sent` → `duplicate`，业务审计条目数不变 |
| `8a/8b` | 7/8 | `email.replied` → 提出 `schedule_meeting`；批准后 `meeting.scheduled` 恢复流程、Lead → `qualified` |
| `9a/9b` | 9 | `deal.created` 建立 Deal；非法阶段回退被判 `failed` 并进异常队列，事实不被覆盖 |
| `10` | 10 | 审计链完整覆盖 `decision_proposed → action_approved → action_dispatched` |
| `11` | 6 | 事件时间早于动作 TTL 时批准仍能执行（有效期从 `max(提出时刻, 判定时刻)` 起算，不出生即过期） |

## 3. 两个必须知道的时间语义

### 3.1 动作有效期起点 = `max(建议提出时刻, 事实判定时刻)`

- `expires_at` 的起算点是**建议提出时刻**（引擎时钟，`DecisionContext.proposed_at`）与**事实判定时刻**
  （`policy_context.evaluated_at` = 触发事件 `occurred_at`）中较晚者，再加动作 TTL：
  `send_email`/`send_proposal` 48h、`schedule_meeting` 72h、`advance_deal_stage`/`create_task` 168h。
- 控制面 `approve` 用**真实时钟**复核是否过期（`WorkflowEngine.#now`）。

因此：事件很旧（CRM 回填、导入、webhook 迟到）时建议不会出生即过期，第 1 次批准就能执行；
但**建议提出后超过 TTL 仍未处理**，批准仍会被判 `action_expired` → `stale_action_replanned=true` 并重新规划。
这两条都有回归测试：`src/decision/rule-based-decider.test.ts`、`src/workflow/engine.test.ts`，
活实例证据见 `scripts/ttl-anchor-check.mjs`。

> 早期版本把起点锚在事件时间上，导致事实一旧建议就出生即过期、批准被静默丢弃——已修复，
> 见 `docs/sales-daily-feedback.md` 第 4.1 节。

### 3.2 `scripts/sales-day-walkthrough.mjs` 按运行当天生成时间

演练脚本原先把事件时间写死为固定日期，会踩 3.1 的过期判定。现已改为基于运行当天（+08:00）的
09:15–16:00 生成，`scheduled_start_at` / `expected_close_at` 相对当天计算，`BASE`/`TOKEN` 支持
`WALKTHROUGH_BASE` / `WALKTHROUGH_TOKEN` 覆盖。实测见 `docs/sales-daily-feedback.md`。

## 4. 当前实测结论（2026-09-30）

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过（退出码 0） |
| `npm run test:run` | ✅ **49 文件 / 642 用例全部通过** |
| `node scripts/single-instance-acceptance.mjs` | ✅ **19 PASS / 0 FAIL**（干净库与演练实例上均通过） |
| `node scripts/sales-day-walkthrough.mjs` | ✅ 21 个事件全程符合预期，所有批准 `stale_action_replanned=false` |
| 待审队列 `requires_approval` | ✅ `needs_review` 条目一律为 `true`（取 Policy 结论） |
| 重启恢复（同库重启后重投已处理事件） | ✅ 审计与实例状态逐一不变，重投 → `duplicate` |

修复前该套件有 13 个失败，原因**不是业务逻辑缺陷**，而是测试与真实时钟耦合（详见 `docs/sales-daily-feedback.md` 第 3.1 节）。`scripts/clock-coupling-proof.mjs` 用同一份代码、同一组事件做了 A/B 对照：

| 对照组 | 注入时钟 | `stale_action_replanned` | 审批后状态 | Executor 调用 |
| --- | --- | --- | --- | --- |
| A | 真实时钟（今天） | `true` | `needs_review` | 1 |
| B | `2026-09-24T10:05+08:00`（与 fixtures 事件同刻） | `false` | `waiting_result` | 2 |

A 组审计里直接给出了原因：

```text
action_stale(schedule_meeting):skipped[action_expired: 动作有效期至 2026-09-27T04:00:00.000Z，判定时刻 2026-09-30T14:59:31.648Z 已过期]
```

`src/testing/fixtures.ts` 的事件时间固定在 `2026-09-24`，而各测试文件的 `createEngine()`（如 `src/workflow/engine.test.ts:13`）不注入 `now`，于是这套测试只在「写完之后 48–72 小时内」是绿的。

**已落地的修复**：`src/testing/fixtures.ts` 新增 `FIXED_NOW_ISO` / `fixedNow`，
6 个会产生待审动作并调用 `approve`/`reject` 的测试文件（`approval-failure` / `engine-resume` / `engine` /
`control-plane` / `retry-scheduler` / `provider-receipt-audit`）统一注入 `now: fixedNow`；
`src/app/bootstrap.test.ts` 本来就是这个写法。修复前的 13 个失败输出保留在 `acceptance/tests-full.txt`，
修复后的全绿输出在 `acceptance/tests-after-fix.txt`。

## 5. 已解决的遗留问题

| 问题 | 状态 |
| --- | --- |
| 事件时间早于动作 TTL 时第一次批准被静默丢弃 | ✅ 已修复：有效期起点改为 `max(提出时刻, 判定时刻)`，见第 3.1 节 |
| `pending_action.requires_approval` 与 Policy 结论不一致 | ✅ 已修复：视图按有效结论输出，`needs_review` 一律为 `true` |
| fixtures 事件时间写死 `2026-09-24`，新增引擎级测试易再漂移 | ⚠️ 约定：**凡构造 `WorkflowEngine` 的测试工厂必须注入 `now`** |

修复细节与验证见 `docs/sales-daily-feedback.md` 第 4 节。

## 6. 证据文件

`acceptance/` 是**运行产物目录**，已被 `.gitignore` 忽略（只保留 `acceptance/README.md`）；
可运行的检查脚本都在 `scripts/`。产物由 `npm run accept` 或下列单条命令生成：

| 文件 | 内容 |
| --- | --- |
| `acceptance/report-<时间戳>.json` | `npm run accept` 总报告：每步退出码 + 单实例 19 项断言明细 |
| `scripts/acceptance-suite.mjs` | 一键验收编排（`npm run accept`） |
| `scripts/single-instance-acceptance.mjs` | 单实例验收脚本（本页第 2 节的断言） |
| `scripts/sales-day-walkthrough.mjs` | 21 个事件的「销售一天」走查 |
| `docs/sales-daily-feedback.md` | 走查记录、两轮修复与验证 |
| `scripts/clock-coupling-proof.mjs` | 时钟稳健性 A/B 对照（退出码判定） |
| `scripts/ttl-anchor-check.mjs` | 有效期锚点回归（96h 前的事件时间，退出码判定） |
| `acceptance/walkthrough-run1.txt` / `walkthrough-run2.txt` | 走查输出（修复前 / 修复后） |
| `acceptance/acceptance-live.txt` / `acceptance-live2.txt` | 断言输出（18 项 / 19 项） |
| `acceptance/tests-full.txt` | 修复前 `npm run test:run`（13 失败） |
| `acceptance/tests-after-fix.txt` | 第一轮修复后（635 通过） |
| `acceptance/tests-p2p3.txt` / `tests-final.txt` | 第二轮修复后（642 通过） |
