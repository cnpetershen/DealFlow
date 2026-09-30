// 时钟稳健性 A/B 对照：同一份代码、同一组事件，分别在「真实时钟」与「注入固定时钟」下审批，
// 结论必须一致——引擎不应依赖「事件时间与真实时钟恰好接近」这个巧合。
//
// 历史背景：修复前动作有效期锚在事件时间上，真实时钟下（fixtures 事件是 2026-09-24）
// A 组会 stale_action_replanned=true（出生即过期），这正是 npm run test:run 有 13 个用例变红的原因。
// 现在 A 组也必须通过；若 A 再次失败，说明「出生即过期」缺陷回归了。
//
// 运行：node --experimental-transform-types --import ./scripts/register.mjs scripts/clock-coupling-proof.mjs
// 退出码：0 = 两组都符合预期；1 = 存在时钟依赖。
import { InMemoryAuditLog, InMemoryEventStore, InMemoryExceptionQueue, InMemoryPendingActionStore, InMemoryStateStore, InMemoryWorkflowStateStore } from '../src/stores/in-memory.ts';
import { InMemoryExecutor } from '../src/executor/in-memory.ts';
import { RuleBasedDecider } from '../src/decision/rule-based-decider.ts';
import { RuleBasedPolicyEvaluator } from '../src/policy/rule-based-policy.ts';
import { WorkflowEngine } from '../src/workflow/engine.ts';
import { contactState, emailRepliedEvent, emailSentEvent, leadAssignedEvent, leadCreatedEvent } from '../src/testing/fixtures.ts';

const WF_ID = 'wf_lead_follow_up_lead_1';

/** 与 src/workflow/engine.test.ts 的 createEngine 等价；now 为空时用真实时钟。 */
function build(now) {
  const leads = new InMemoryStateStore((s) => s.lead_id);
  const contacts = new InMemoryStateStore((s) => s.contact_id);
  const deals = new InMemoryStateStore((s) => s.deal_id);
  const workflows = new InMemoryWorkflowStateStore();
  const events = new InMemoryEventStore();
  const audit = new InMemoryAuditLog();
  const exceptions = new InMemoryExceptionQueue();
  const pendingActions = new InMemoryPendingActionStore();
  const executor = new InMemoryExecutor();
  let n = 0;
  const engine = new WorkflowEngine({
    event_store: events,
    audit_log: audit,
    exception_queue: exceptions,
    lead_store: leads,
    contact_store: contacts,
    deal_store: deals,
    workflow_store: workflows,
    pending_action_store: pendingActions,
    executor,
    decider: new RuleBasedDecider({ createActionId: () => `action_${++n}` }),
    policy: new RuleBasedPolicyEvaluator(),
    contact_defaults: () => contactState(),
    ...(now ? { now } : {}),
  });
  return { engine, workflows, audit, executor };
}

/** 复现失败用例的前半段：进线 → 分配 → 首触邮件回执 → 客户回复 → 得到待审动作。 */
async function runScenario(label, now) {
  const { engine, workflows, audit, executor } = build(now);
  await engine.handleEvent(leadCreatedEvent({ payload: { ...leadCreatedEvent().payload, contact_id: 'contact_1' } }));
  await engine.handleEvent(leadAssignedEvent());
  await engine.handleEvent(emailSentEvent());
  await engine.handleEvent(emailRepliedEvent());

  const proposed = audit.list().filter((entry) => entry.action === 'decision_proposed');
  const actionId = proposed[proposed.length - 1]?.action_id ?? '';
  const policyVerdict = audit.list().filter((entry) => entry.action === 'policy_evaluated').at(-1);
  const before = workflows.get(WF_ID);

  const outcome = await engine.approve(WF_ID, actionId, 'user_7');
  const after = workflows.get(WF_ID);
  const chain = audit.list().map((e) => `${e.action}${e.action_type ? `(${e.action_type})` : ''}:${e.result}${e.reason ? `[${e.reason}]` : ''}`);

  console.log(`\n===== ${label} =====`);
  console.log(`  引擎判定时刻 now()            : ${now ? now() : '(真实时钟) ' + new Date().toISOString()}`);
  console.log(`  审批前 Policy 结论            : ${policyVerdict?.result}${policyVerdict?.reason ? ` [${policyVerdict.reason}]` : ''}`);
  console.log(`  审批前实例状态                : ${before?.status} step=${before?.current_step} plan=${before?.plan_version}`);
  console.log(`  approve.stale_action_replanned: ${outcome.stale_action_replanned}`);
  console.log(`  审批后实例状态                : ${after?.status} step=${after?.current_step} waiting=${JSON.stringify(after?.awaiting_event_types)}`);
  console.log(`  Executor 实际执行次数          : ${executor.attempts().length}`);
  console.log(`  期望（docs/mvp.md 第 6 条）    : stale=false, status=waiting_result, 执行 2 次`);
  const healthy = outcome.stale_action_replanned === false && after?.status === 'waiting_result' && executor.attempts().length === 2;
  console.log(`  结论                          : ${healthy ? '✅ 符合预期' : '❌ 不符合预期'}`);
  console.log(`  审计链                        : ${chain.join(' | ')}`);
  return healthy;
}

const real = await runScenario('A. 真实时钟（修复前这一组会出生即过期）', undefined);
const pinned = await runScenario('B. 注入 2026-09-24T10:05+08:00（与 fixtures 事件同一时刻）', () => '2026-09-24T10:05:00+08:00');

console.log('\n===== 结论 =====');
console.log(`  A 真实时钟: ${real ? '通过' : '失败'}    B 注入时钟: ${pinned ? '通过' : '失败'}`);
console.log(`  ${real && pinned
  ? '⇒ 两种时钟下结论一致：修复前 A 失败、B 通过（13 个用例变红的根因），现在都已消除。'
  : '⇒ 仍存在依赖时钟的行为，需要排查（A 失败即「出生即过期」回归）。'}`);
process.exitCode = real && pinned ? 0 : 1;
