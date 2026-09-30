// 动作有效期锚点回归：事件时间早于动作 TTL 时（CRM 回填 / webhook 迟到），
// 第 1 次批准就应该正常执行——有效期起点 = max(建议提出时刻, 事实判定时刻)。
// 修复前这里是 stale_action_replanned=true（批准被静默丢弃，要再批一次）。
//
// 用法：ACCEPTANCE_BASE=http://127.0.0.1:3123 node scripts/ttl-anchor-check.mjs
// 退出码：0 = 第 1 次批准即生效；1 = 被判过期或未执行。
const BASE = process.env.ACCEPTANCE_BASE ?? 'http://127.0.0.1:3123';
const TOKEN = process.env.ACCEPTANCE_TOKEN ?? 'dev-token';
const RUN = Date.now().toString(36);
const LEAD = `lead_exp_${RUN}`;
const OLD = new Date(Date.now() - 96 * 3600000).toISOString();
const j = (r) => r.json().catch(() => null);
let n = 0;
const emit = async (type, payload) => {
  const res = await fetch(`${BASE}/webhooks/dealflow`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: `evt_${RUN}_${++n}`, type, version: 1, occurred_at: OLD, idempotency_key: `${type}:${RUN}:${n}`, payload, source: 'ttl-anchor-check' }),
  });
  return j(res);
};
const ctl = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }).then(j);

console.log(`真实时钟 now = ${new Date().toISOString()}，事件 occurred_at = ${OLD}（96h 前）`);
await emit('lead.created', { lead_id: LEAD, source_channel: 'web_form', source_record_id: `sd-${RUN}`, company_name: '过期样例', contact_id: `c_${RUN}`, initial_owner_id: null });
await emit('contact.recorded', { contact_id: `c_${RUN}`, lead_id: LEAD, full_name: 'X', email: 'x@example.com', organization_id: `o_${RUN}`, contact_preference: 'auto_allowed', contactability: 'reachable', is_new_contact: true });
await emit('lead.assigned', { lead_id: LEAD, owner_id: 'ae_x', previous_owner_id: null, assignment_reason: 'probe' });

const WF = `wf_lead_follow_up_${LEAD}`;
let firstRoundOk = false;
for (let round = 1; round <= 3; round += 1) {
  const before = await ctl(`/workflows/${WF}`);
  const pending = before.pending_action;
  if (!pending) { console.log(`\n第 ${round} 轮：无待审动作，流程状态 ${before.status}`); break; }
  const res = await ctl(`/workflows/${WF}/approve`, { method: 'POST', body: JSON.stringify({ action_id: pending.action_id, actor_id: 'ae_x' }) });
  const after = await ctl(`/workflows/${WF}`);
  console.log(`\n第 ${round} 轮`);
  console.log(`  待审动作      : ${pending.action_type} ${pending.action_id} expires_at=${pending.expires_at}`);
  console.log(`  approve 结果  : stale_action_replanned=${res.stale_action_replanned} status=${after.status} plan_version=${after.plan_version}`);
  console.log(`  新待审动作    : ${after.pending_action ? `${after.pending_action.action_type} ${after.pending_action.action_id} expires_at=${after.pending_action.expires_at}` : '(无)'}`);
  const audit = await ctl(`/audit?workflow_instance_id=${WF}&order=asc&limit=100`);
  const stale = (audit.items ?? []).filter((e) => e.action === 'action_stale');
  console.log(`  action_stale 审计: ${stale.length} 条，最后一条 reason=${stale.at(-1)?.reason}`);

  if (round === 1) {
    firstRoundOk = res.stale_action_replanned === false && after.status === 'waiting_result'
      && Date.parse(pending.expires_at) > Date.parse(new Date().toISOString());
  }
}

console.log(`\n结论: ${firstRoundOk ? '✅ 第 1 次批准即生效（有效期从提出时刻起算）' : '❌ 第 1 次批准未生效，有效期锚点可能回退'}`);
process.exitCode = firstRoundOk ? 0 : 1;
