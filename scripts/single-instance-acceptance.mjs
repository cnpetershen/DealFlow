// DealFlow 单实例验收：只用**一个 Lead / 一个 WorkflowInstance** 跑完整条闭环，
// 并把 docs/mvp.md「最小闭环验收标准」逐条变成机器断言。
//
// 用法：
//   1) 起一个干净实例（独立库、独立端口）：
//        DEALFLOW_DB_PATH=<空库路径> DEALFLOW_PORT=3124 \
//        DEALFLOW_CONTROL_PLANE_TOKEN=dev-token npm start
//   2) node scripts/single-instance-acceptance.mjs
//
// 退出码：0 = 全部必检项通过；1 = 有必检项失败（失败项会打印实际观测值）。
// 环境变量 ACCEPTANCE_REPORT=<路径> 时，额外把结构化结果写成 JSON（供编排器读取）。
//
// 关键点：所有事件的 occurred_at 使用**当前真实时间**，让流程回到真实时钟下的行为。
// 动作的 expires_at 由「max(建议提出时刻, 事实判定时刻) + 动作 TTL」推导
// （send_email 48h / schedule_meeting 72h / advance_deal_stage 168h），而控制面 approve 用
// 真实时钟复核是否过期；因此事实很旧时建议也不会出生即过期，但超过 TTL 未处理仍会被判 stale。
import { writeFileSync } from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE ?? 'http://127.0.0.1:3124';
const TOKEN = process.env.ACCEPTANCE_TOKEN ?? 'dev-token';
const WEBHOOK_TOKEN = process.env.ACCEPTANCE_WEBHOOK_TOKEN ?? '';

const RUN = Date.now().toString(36);
const LEAD = `lead_acc_${RUN}`;
const CONTACT = `contact_acc_${RUN}`;
const OWNER = 'ae_acc';
const WF = `wf_lead_follow_up_${LEAD}`;

let seq = 0;
const results = [];
const ok = (id, criterion, name, passed, detail) => {
  results.push({ id, criterion, name, passed, detail });
  const tag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'INFO';
  console.log(`[${tag}] ${id} (MVP-${criterion}) ${name}${detail === undefined ? '' : `\n        ${detail}`}`);
};

const headers = (extra = {}) => ({ 'content-type': 'application/json', ...extra });
const control = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  headers: headers({ authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) }),
});
const readJson = async (res) => res.json().catch(() => null);
const get = async (path) => { const r = await control(path); return { http: r.status, body: await readJson(r) }; };
const post = async (path, body) => {
  const r = await control(path, { method: 'POST', body: JSON.stringify(body) });
  return { http: r.status, body: await readJson(r) };
};

/** 投一个事件；key 可复用以验证幂等。occurred_at 默认当前真实时间。 */
async function emit(type, payload, key, occurredAt) {
  seq += 1;
  const res = await fetch(`${BASE}/webhooks/dealflow`, {
    method: 'POST',
    headers: headers(WEBHOOK_TOKEN ? { authorization: `Bearer ${WEBHOOK_TOKEN}` } : {}),
    body: JSON.stringify({
      event_id: `evt_acc_${RUN}_${seq}`,
      type,
      version: 1,
      occurred_at: occurredAt ?? new Date().toISOString(),
      idempotency_key: key ?? `acc:${type}:${RUN}:${seq}`,
      payload,
      source: 'single-instance-acceptance',
    }),
  });
  return { http: res.status, body: await readJson(res) };
}

const wf = async () => (await get(`/workflows/${WF}`)).body;
const brief = (w) => w && { status: w.status, step: w.current_step, plan: w.plan_version, waiting: w.awaiting_event_types, pending: w.pending_action && `${w.pending_action.action_type}#${w.pending_action.action_id}` };
const auditChain = async () => (await get(`/audit?workflow_instance_id=${WF}&order=asc&limit=500`)).body?.items ?? [];

async function approve() {
  const w = await wf();
  if (!w?.pending_action?.action_id) return { http: 0, body: { error: 'no pending_action' } };
  return post(`/workflows/${WF}/approve`, { action_id: w.pending_action.action_id, actor_id: OWNER });
}

// ---------------------------------------------------------------- 开始
console.log(`DealFlow 单实例验收\n  base=${BASE}  lead=${LEAD}  workflow=${WF}\n`);

const health = await fetch(`${BASE}/healthz`).then(readJson).catch(() => null);
ok('0', '-', '实例存活（/healthz）', health?.status === 'ok', JSON.stringify(health));

// MVP-1 事件信封校验 + 幂等去重
const badEnvelope = await fetch(`${BASE}/webhooks/dealflow`, {
  method: 'POST', headers: headers(),
  body: JSON.stringify({ event_id: 'evt_bad', type: 'lead.created', version: 1, payload: {} }),
});
ok('1a', '1', '缺必填字段的事件被拒（信封校验）', badEnvelope.status >= 400,
  `HTTP ${badEnvelope.status} ${JSON.stringify(await readJson(badEnvelope))}`);

const leadCreatedKey = `acc:lead.created:${RUN}`;
const created = await emit('lead.created', {
  lead_id: LEAD, source_channel: 'web_form', source_record_id: `sd-${RUN}`,
  company_name: '验收样例公司', contact_id: CONTACT, initial_owner_id: null,
}, leadCreatedKey);
ok('1b', '1', 'lead.created 被接收', created.body?.event_status === 'processed',
  `HTTP ${created.http} ${JSON.stringify(created.body)}`);

const createdAgain = await emit('lead.created', {
  lead_id: LEAD, source_channel: 'web_form', source_record_id: `sd-${RUN}`,
  company_name: '验收样例公司', contact_id: CONTACT, initial_owner_id: null,
}, leadCreatedKey);
ok('1c', '1', '同 idempotency_key 重复投递 → duplicate（不重复建流程）',
  createdAgain.body?.event_status === 'duplicate', JSON.stringify(createdAgain.body));

// MVP-2 唯一 WorkflowInstance，业务 key = (workflow_type, lead_id)
const allWf = (await get('/workflows?limit=1000')).body?.items ?? [];
const sameLead = allWf.filter((i) => i.subject_id === LEAD);
ok('2', '2', '同一 Lead 只有一个 WorkflowInstance，且 ID 为 wf_<type>_<lead_id>',
  sameLead.length === 1 && sameLead[0].workflow_instance_id === WF,
  `匹配实例数=${sameLead.length} id=${sameLead.map((i) => i.workflow_instance_id).join(',')}`);

const leadFact = await get(`/leads/${LEAD}`);
ok('2b', '1', '事实已落库（GET /leads/{id}）', leadFact.http === 200 && leadFact.body?.lead_id === LEAD,
  `HTTP ${leadFact.http} status=${leadFact.body?.status}`);

// 联系人 + 分配
await emit('contact.recorded', {
  contact_id: CONTACT, lead_id: LEAD, full_name: '验收联系人', email: 'acc@example.com',
  organization_id: `org_${RUN}`, contact_preference: 'auto_allowed', contactability: 'reachable',
  is_new_contact: true,
});
const assigned = await emit('lead.assigned', {
  lead_id: LEAD, owner_id: OWNER, previous_owner_id: null, assignment_reason: 'acceptance',
});
const afterAssign = await wf();
ok('3', '7', 'lead.assigned 后进入首次跟进规划',
  assigned.body?.event_status === 'processed' && afterAssign.status === 'needs_review',
  `event=${JSON.stringify(assigned.body)} workflow=${JSON.stringify(brief(afterAssign))}`);

// MVP-4 / MVP-5 Decision 只提建议；Policy 判 Human Review（新联系人外发）
const pending = afterAssign.pending_action;
ok('4', '4', 'Decision 输出 ProposedAction（不直接执行外部动作）',
  pending?.action_id !== undefined && pending?.action_type === 'send_email',
  JSON.stringify(pending && { action_type: pending.action_type, action_id: pending.action_id, reason: pending.reason }));
ok('5', '5', 'Policy 把新联系人外发判为 Human Review（实例停在 needs_review）',
  afterAssign.status === 'needs_review', `status=${afterAssign.status} step=${afterAssign.current_step}`);

// MVP-6 批准 → 派发 → 等外部结果；结果事件到达前不算"已发送"
const approved = await approve();
const afterApprove = await wf();
ok('6a', '6', 'approve 后派发动作并进入 waiting_result（不把"已批准"当"已发生"）',
  afterApprove.status === 'waiting_result',
  `HTTP ${approved.http} stale_action_replanned=${approved.body?.stale_action_replanned} workflow=${JSON.stringify(brief(afterApprove))}`);
ok('6b', '6', '批准未被误判为过期动作', approved.body?.stale_action_replanned === false,
  `stale_action_replanned=${approved.body?.stale_action_replanned}`);

// MVP-7 / MVP-12 结果事件驱动恢复；重复投递不产生第二次业务效果
const sentKey = `acc:email.sent:${RUN}`;
const sentPayload = {
  message_id: `msg_${RUN}`, lead_id: LEAD, contact_id: CONTACT, sender_id: OWNER,
  recipient_email: 'acc@example.com', template_id: 'tpl_first_touch', workflow_instance_id: WF,
  sent_at: new Date().toISOString(), provider_reference: `sg-${RUN}`, provider: 'sendgrid',
  correlation_id: `corr-${RUN}`,
};
const sent = await emit('email.sent', sentPayload, sentKey);
const afterSent = await wf();
ok('7a', '7', 'email.sent 被消费并触发重规划（进入推导等待，而不是卡在等待该结果）',
  sent.body?.event_status === 'processed'
    && afterSent.plan_version > afterApprove.plan_version
    && afterSent.current_step === 'await_event'
    && (afterSent.awaiting_event_types ?? []).includes('email.replied'),
  `event=${JSON.stringify(sent.body)} plan ${afterApprove.plan_version}→${afterSent.plan_version} workflow=${JSON.stringify(brief(afterSent))}`);

/** 重复事件允许追加 event_processed 审计（docs/events.md「重复结果事件」），业务条目不得增加。 */
const businessAudit = (items) => items.filter((e) => e.action !== 'event_processed');
const auditAfterSent = businessAudit(await auditChain());
const sentDuplicate = await emit('email.sent', sentPayload, sentKey);
const auditAfterDuplicate = businessAudit(await auditChain());
ok('12', '12', '重复投递 email.sent → duplicate，且不新增业务审计条目',
  sentDuplicate.body?.event_status === 'duplicate' && auditAfterDuplicate.length === auditAfterSent.length,
  `event=${JSON.stringify(sentDuplicate.body)} 业务审计 ${auditAfterSent.length} → ${auditAfterDuplicate.length}`);

// 客户回复 → 建议约会议 → 人工批准
await emit('email.replied', {
  message_id: `msg_${RUN}`, reply_id: `reply_${RUN}`, lead_id: LEAD, contact_id: CONTACT,
  reply_at: new Date().toISOString(), sentiment: 'positive', intent: 'ask_pricing',
  body_reference: 'acceptance#1', provider_reference: `sg-reply-${RUN}`, provider: 'sendgrid',
  correlation_id: `corr-reply-${RUN}`,
});
const afterReply = await wf();
ok('8a', '7', 'email.replied 恢复流程并提出下一步建议',
  afterReply.status === 'needs_review' || afterReply.status === 'waiting_result',
  `workflow=${JSON.stringify(brief(afterReply))}`);

if (afterReply.status === 'needs_review') {
  const meetingApproved = await approve();
  const afterMeetingApprove = await wf();
  const meetingSent = await emit('meeting.scheduled', {
    meeting_id: `mtg_${RUN}`, lead_id: LEAD, contact_id: CONTACT, organizer_id: OWNER,
    scheduled_start_at: new Date(Date.now() + 86400000).toISOString(),
    scheduled_end_at: new Date(Date.now() + 88200000).toISOString(),
    calendar_provider: 'google', status: 'confirmed', provider_reference: `gcal-${RUN}`,
    provider: 'google_calendar', correlation_id: `corr-mtg-${RUN}`,
  });
  const afterMeeting = await wf();
  const leadAfterMeeting = await get(`/leads/${LEAD}`);
  ok('8b', '8', '批准约会议 → meeting.scheduled 恢复流程并更新 Lead 事实',
    meetingApproved.body?.stale_action_replanned === false && afterMeeting.status !== 'failed'
      && meetingSent.body?.event_status === 'processed'
      && ['engaged', 'qualified', 'assigned'].includes(leadAfterMeeting.body?.status),
    `approve.stale=${meetingApproved.body?.stale_action_replanned} workflow=${JSON.stringify(brief(afterMeeting))} lead=${leadAfterMeeting.body?.status}`);
} else {
  ok('8b', '8', '批准约会议 → meeting.scheduled 恢复流程', null,
    `跳过：回复后实例未进入 needs_review（当前 ${afterReply.status}）`);
}

// MVP-9 非法阶段迁移被拒（Deal 只能 qualification → discovery → proposal …）
await emit('deal.created', {
  deal_id: `deal_${RUN}`, lead_id: LEAD, contact_id: CONTACT, owner_id: OWNER,
  initial_stage: 'qualification', amount: 80000, currency: 'CNY',
  expected_close_at: new Date(Date.now() + 30 * 86400000).toISOString(), source_record_id: `sd-deal-${RUN}`,
});
const afterDeal = await wf();
ok('9a', '9', 'deal.created 建立 Deal 事实（从 qualification 起）',
  (await get(`/deals?lead_id=${LEAD}`)).body?.items?.some((d) => d.deal_id === `deal_${RUN}`) === true,
  `workflow=${JSON.stringify(brief(afterDeal))}`);

const illegal = await emit('deal.stage_changed', {
  deal_id: `deal_${RUN}`, lead_id: LEAD, from_stage: 'proposal', to_stage: 'qualification',
  changed_by: OWNER, reason: 'acceptance: 非法回退',
});
const dealAfterIllegal = (await get(`/deals?lead_id=${LEAD}`)).body?.items?.[0];
const exceptions = (await get('/exceptions?status=all&limit=200')).body?.items ?? [];
ok('9b', '9', '非法阶段迁移被拒绝且进入异常队列，不静默覆盖事实',
  ['failed', 'conflict'].includes(illegal.body?.event_status)
    && dealAfterIllegal?.stage === 'qualification'
    && exceptions.some((e) => e.reason === 'stale_event' || e.reason === 'invalid_transition'),
  `event=${JSON.stringify(illegal.body)} deal.stage=${dealAfterIllegal?.stage} exceptions=${JSON.stringify(exceptions.map((e) => `${e.reason}:${e.status}`))}`);

// MVP-10 审计只追加、可完整复盘
const chain = await auditChain();
const actions = chain.map((e) => e.action);
const required = ['decision_proposed', 'action_approved', 'action_dispatched'];
ok('10', '10', '审计链完整记录 建议 → 审批 → 派发（只追加）',
  required.every((a) => actions.includes(a)),
  `条目=${chain.length} 覆盖=${required.map((a) => `${a}:${actions.filter((x) => x === a).length}`).join(' ')}`);

// 动作有效期锚点：事实很旧（CRM 回填 / webhook 迟到）时，建议不能「出生即过期」。
// 有效期起点 = max(建议提出时刻, 事实判定时刻)，见 src/decision/rule-based-decider.ts 的 proposalAnchor。
const ttlLead = `lead_ttl_${RUN}`;
const old = new Date(Date.now() - 96 * 3600000).toISOString();
await emit('lead.created', {
  lead_id: ttlLead, source_channel: 'web_form', source_record_id: `sd-ttl-${RUN}`,
  company_name: 'TTL 样例', contact_id: `contact_ttl_${RUN}`, initial_owner_id: null,
}, undefined, old);
await emit('contact.recorded', {
  contact_id: `contact_ttl_${RUN}`, lead_id: ttlLead, full_name: 'TTL', email: 'ttl@example.com',
  organization_id: `org_ttl_${RUN}`, contact_preference: 'auto_allowed', contactability: 'reachable',
  is_new_contact: true,
}, undefined, old);
await emit('lead.assigned', {
  lead_id: ttlLead, owner_id: OWNER, previous_owner_id: null, assignment_reason: 'ttl-probe',
}, undefined, old);
const ttlWf = (await get(`/workflows/wf_lead_follow_up_${ttlLead}`)).body;
const ttlExpires = ttlWf?.pending_action?.expires_at;
const ttlApproved = ttlWf?.pending_action?.action_id
  ? await post(`/workflows/wf_lead_follow_up_${ttlLead}/approve`, { action_id: ttlWf.pending_action.action_id, actor_id: OWNER })
  : { body: {} };
const ttlAfter = (await get(`/workflows/wf_lead_follow_up_${ttlLead}`)).body;
ok('11', '6', '事件时间早于动作 TTL 时，批准仍能执行（有效期从提出时刻起算，不出生即过期）',
  Date.parse(ttlExpires ?? '') > Date.parse(old)
    && ttlApproved.body?.stale_action_replanned === false
    && ttlAfter?.status === 'waiting_result',
  `事件时间=${old} expires_at=${ttlExpires} approve.stale=${ttlApproved.body?.stale_action_replanned} workflow=${JSON.stringify(brief(ttlAfter))}`);

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => r.passed === false);
const passed = results.filter((r) => r.passed === true);
const info = results.length - passed.length - failed.length;
console.log(`\n===== 汇总 =====\nPASS ${passed.length}  FAIL ${failed.length}  INFO ${info}`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.id} (MVP-${f.criterion}) ${f.name}`);
}
console.log(`\n审计链（${chain.length} 条）：${actions.join(' | ')}`);

// 结构化结果：给 scripts/acceptance-suite.mjs 之类编排器读取（子进程不用管道传结果）
if (process.env.ACCEPTANCE_REPORT) {
  writeFileSync(
    process.env.ACCEPTANCE_REPORT,
    `${JSON.stringify({
      base: BASE, lead: LEAD, workflow: WF, generated_at: new Date().toISOString(),
      passed: passed.length, failed: failed.length, info, results,
    }, null, 2)}\n`,
    'utf8',
  );
}

process.exitCode = failed.length === 0 ? 0 : 1;
