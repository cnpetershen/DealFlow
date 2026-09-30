// 销售一天的日常操作全链路走查：线索进线 → 分配 → 首封邮件审核 → 回复 → 约会议 →
// 建商机 → 推进阶段 → 提案 → 成交，穿插审批、拒绝后重提、异常处理、只读看板查询。
//
// 事件时间基于**运行当天**（+08:00）的 09:15-16:00 生成，落在发送窗口 9:00-18:00 内。
// 不要写死历史日期：动作 expires_at = 事件 occurred_at + 动作 TTL（send_email 48h 等），
// 而控制面 approve 用真实时钟复核，写死的历史时间会让审批被判 action_expired → stale 重规划。
// 若在 09:00 之前运行，锚点回退到前一天，保证所有事件时间都在过去。
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://127.0.0.1:3123';
const TOKEN = process.env.WALKTHROUGH_TOKEN ?? 'dev-token';
const headers = (extra = {}) => ({ 'content-type': 'application/json', ...extra });
const ctl = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  headers: headers({ authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) }),
});
const json = async (res) => res.json().catch(() => null);
const get = async (path) => { const r = await ctl(path); return { s: r.status, b: await json(r) }; };
const post = async (path, body) => {
  const r = await ctl(path, { method: 'POST', body: JSON.stringify(body) });
  return { s: r.status, b: await json(r) };
};
const bare = async (path) => { const r = await fetch(`${BASE}${path}`); return { s: r.status, b: await json(r) }; };
const line = (label, v) => console.log(`${label} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const section = (t) => console.log(`\n===== ${t} =====`);
const wf = (lead) => `wf_lead_follow_up_${lead}`;
const TZ_OFFSET_MINUTES = 480; // +08:00
const pad2 = (n) => String(n).padStart(2, '0');
const tzDate = (instantMs) => new Date(instantMs + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
const tzHour = (instantMs) => Number(new Date(instantMs + TZ_OFFSET_MINUTES * 60000).toISOString().slice(11, 13));
// 09:00 之前运行则锚定到前一天，避免生成未来时间的事件
const TODAY = tzDate(tzHour(Date.now()) < 9 ? Date.now() - 86400000 : Date.now());
/** 当天 h:m（+08:00）的 ISO 时间戳 */
const T = (h, m) => `${TODAY}T${pad2(h)}:${pad2(m)}:00+08:00`;
/** 相对当天偏移 days 天的 h:m（+08:00） */
const inDays = (days, h, m) =>
  `${tzDate(Date.parse(`${TODAY}T00:00:00+08:00`) + days * 86400000)}T${pad2(h)}:${pad2(m)}:00+08:00`;
const wfBrief = async (id) => {
  const r = await get(`/workflows/${id}`);
  return { s: r.s, status: r.b?.status, step: r.b?.current_step, awaiting: r.b?.awaiting_event_types, plan: r.b?.plan_version, pending: r.b?.pending_action && { id: r.b.pending_action.action_id, type: r.b.pending_action.action_type, requires_approval: r.b.pending_action.requires_approval, reason: r.b.pending_action.reason } };
};
const auditChain = async (id) => (await get(`/audit?workflow_instance_id=${id}&order=asc&limit=200`)).b.items
  .map((e) => `${e.action}${e.action_type ? `(${e.action_type})` : ''}:${e.result}${e.reason ? `[${e.reason}]` : ''}`).join(' | ');
const needsReview = async () => {
  const r = await get('/workflows?status=needs_review');
  return { s: r.s, total: r.b.total, items: r.b.items.map((i) => ({ wf: i.workflow_instance_id, action: i.pending_action?.action_type, requires_approval: i.pending_action?.requires_approval, reason: i.pending_action?.reason, id: i.pending_action?.action_id })) };
};
const approve = async (lead, actor) => {
  const list = (await get('/workflows?status=needs_review')).b.items;
  const item = list.find((i) => i.workflow_instance_id === wf(lead));
  if (item === undefined) return { s: 0, b: { error: `${wf(lead)} 当前没有待审动作，无法批准` } };
  return post(`/workflows/${wf(lead)}/approve`, { action_id: item.pending_action.action_id, actor_id: actor });
};

let seq = 0;
const RUN = Date.now().toString(36);
async function emit(type, payload, occurred_at) {
  const res = await fetch(`${BASE}/webhooks/dealflow`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      event_id: `evt_${RUN}_${++seq}`,
      type,
      version: 1,
      occurred_at,
      idempotency_key: `${type}:${RUN}:${seq}`,
      payload,
      source: 'sales-day-walkthrough',
    }),
  });
  return { s: res.status, b: await json(res) };
}
const EMAILS = { a: 'lin@bluewhale.example.com', b: 'zhou@yuntu.example.com', c: 'wu@farvoyage.example.com' };

section('0. 开门前：鉴权与空看板');
line('GET /leads 无 token:', await bare('/leads'));
line('GET /leads:', await get('/leads'));
line('GET /deals:', await get('/deals'));

section('1. 09:15 进线：CRM 推送三条新线索');
for (const [l, ch, cn] of [['a', 'web_form', '蓝鲸科技'], ['b', 'trade_show', '云图数据'], ['c', 'referral', '远航物流']]) {
  line(`lead_${l}:`, await emit('lead.created', {
    lead_id: `lead_${l}`, source_channel: ch, source_record_id: `sd-${RUN}-${l}`,
    company_name: cn, contact_id: `contact_${l}`, initial_owner_id: null,
  }, T(9, 15 + ['a', 'b', 'c'].indexOf(l))));
}
line('GET /leads:', await get('/leads'));

section('2. 09:20 登记联系人（CRM 回填邮箱与联系偏好）');
for (const [l, name, email] of [['a', '林经理', EMAILS.a], ['b', '周总监', EMAILS.b], ['c', '吴总', EMAILS.c]]) {
  line(`contact_${l}:`, await emit('contact.recorded', {
    contact_id: `contact_${l}`, lead_id: `lead_${l}`, full_name: name, email,
    organization_id: `org_lead_${l}`, contact_preference: 'auto_allowed', contactability: 'reachable', is_new_contact: true,
  }, T(9, 20 + ['a', 'b', 'c'].indexOf(l))));
}

section('3. 09:30 经理分配线索（lead_a/lead_b → ae_wang，lead_c → ae_li）');
line('lead_a → ae_wang:', await emit('lead.assigned', {
  lead_id: 'lead_a', owner_id: 'ae_wang', previous_owner_id: null, assignment_reason: 'rule:territory',
}, T(9, 30)));
line('lead_b → ae_wang:', await emit('lead.assigned', {
  lead_id: 'lead_b', owner_id: 'ae_wang', previous_owner_id: null, assignment_reason: 'rule:territory',
}, T(9, 31)));
line('lead_c → ae_li:', await emit('lead.assigned', {
  lead_id: 'lead_c', owner_id: 'ae_li', previous_owner_id: null, assignment_reason: 'manual',
}, T(9, 32)));
line('待审批队列:', await needsReview());

section('4. 09:35 销售审核首封邮件（新联系人外发需人工审核）');
line('approve lead_a:', await approve('lead_a', 'ae_wang'));
line('approve lead_b:', await approve('lead_b', 'ae_wang'));
line('approve lead_c:', await approve('lead_c', 'ae_li'));
for (const l of ['a', 'b', 'c']) line(`wf_lead_${l}:`, await wfBrief(wf(`lead_${l}`)));

section('5. 09:36 服务商回执 email.sent');
for (const l of ['a', 'b', 'c']) {
  line(`lead_${l}:`, await emit('email.sent', {
    message_id: `msg_${l}1`, lead_id: `lead_${l}`, contact_id: `contact_${l}`, sender_id: 'tpl_first_touch',
    recipient_email: EMAILS[l], template_id: 'tpl_first_touch', workflow_instance_id: null, sent_at: T(9, 36),
    provider_reference: `sg-msg-${l}1`, provider: 'sendgrid', correlation_id: `corr-msg-${l}1`,
  }, T(9, 36)));
}
for (const l of ['a', 'b', 'c']) line(`wf_lead_${l}:`, await wfBrief(wf(`lead_${l}`)));

section('6. 销售看板（上午）：我的线索');
line('GET /leads?owner_id=ae_wang:', await get('/leads?owner_id=ae_wang'));
line('GET /leads?owner_id=ae_li:', await get('/leads?owner_id=ae_li'));
line('GET /leads?status=assigned:', await get('/leads?status=assigned'));
line('GET /leads/lead_a:', await get('/leads/lead_a'));
line('GET /leads/lead_missing:', await get('/leads/lead_missing'));
line('GET /deals:', await get('/deals'));

section('7. 10:05 客户回复 → 系统建议约会议（需人工审批）');
line('lead_a email.replied:', await emit('email.replied', {
  message_id: 'msg_a1', reply_id: 'reply_a1', lead_id: 'lead_a', contact_id: 'contact_a',
  reply_at: T(10, 5), sentiment: 'positive', intent: 'ask_pricing', body_reference: 'gmail:a#1',
  provider_reference: 'sg-reply-a1', provider: 'sendgrid', correlation_id: 'corr-reply-a1',
}, T(10, 5)));
line('待审批队列:', await needsReview());

section('8. 10:10 销售批准约会议');
line('approve lead_a:', await approve('lead_a', 'ae_wang'));
line('wf_lead_a:', await wfBrief(wf('lead_a')));

section('9. 10:30 日历回传会议已约');
line('meeting.scheduled:', await emit('meeting.scheduled', {
  meeting_id: `mtg_${RUN}`, lead_id: 'lead_a', contact_id: 'contact_a', organizer_id: 'ae_wang',
  scheduled_start_at: inDays(2, 10, 0), scheduled_end_at: inDays(2, 10, 30),
  calendar_provider: 'google', status: 'confirmed',
  provider_reference: `gcal-${RUN}`, provider: 'google_calendar', correlation_id: `corr-mtg-${RUN}`,
}, T(10, 30)));
line('lead_a 状态:', (await get('/leads/lead_a')).b.status);
line('wf_lead_a:', await wfBrief(wf('lead_a')));

section('10. 11:00 CRM 建商机 → 系统建议推进阶段（需审批）');
line('deal.created deal_a:', await emit('deal.created', {
  deal_id: 'deal_a', lead_id: 'lead_a', contact_id: 'contact_a', owner_id: 'ae_wang',
  initial_stage: 'qualification', amount: 80000, currency: 'CNY', expected_close_at: inDays(35, 0, 0),
  source_record_id: `sd-${RUN}-deal-a`,
}, T(11, 0)));
line('待审批队列:', await needsReview());
line('approve advance_deal_stage:', await approve('lead_a', 'ae_wang'));
line('wf_lead_a:', await wfBrief(wf('lead_a')));
line('GET /deals:', await get('/deals'));

section('11. 11:20 CRM 推进阶段 → 11:40 提案发出（CRM 手工发送）');
line('deal.stage_changed → discovery:', await emit('deal.stage_changed', {
  deal_id: 'deal_a', lead_id: 'lead_a', from_stage: 'qualification', to_stage: 'discovery',
  changed_by: 'ae_wang', reason: '需求确认完成',
}, T(11, 20)));
line('wf_lead_a:', await wfBrief(wf('lead_a')));
line('proposal.sent:', await emit('proposal.sent', {
  proposal_id: `prop_${RUN}`, deal_id: 'deal_a', lead_id: 'lead_a', contact_id: 'contact_a', sender_id: 'ae_wang',
  amount: 80000, currency: 'CNY', document_reference: `doc_${RUN}`, sent_at: T(11, 40),
  provider_reference: `docsend-${RUN}`, provider: 'docusign', correlation_id: `corr-prop-${RUN}`,
}, T(11, 40)));
line('wf_lead_a:', await wfBrief(wf('lead_a')));
line('GET /deals?stage=proposal:', await get('/deals?stage=proposal'));

section('12. 14:00 lead_b 客户回复后销售拒绝约会议（理由：本周出差）');
line('lead_b email.replied:', await emit('email.replied', {
  message_id: 'msg_b1', reply_id: 'reply_b1', lead_id: 'lead_b', contact_id: 'contact_b',
  reply_at: T(14, 0), sentiment: 'neutral', intent: 'not_now', body_reference: 'gmail:b#1',
  provider_reference: 'sg-reply-b1', provider: 'sendgrid', correlation_id: 'corr-reply-b1',
}, T(14, 0)));
const reviewB = await needsReview();
line('待审批队列:', reviewB);
const pendB = reviewB.items.find((i) => i.wf === wf('lead_b'));
line('reject:', await post(`/workflows/${wf('lead_b')}/reject`, { action_id: pendB.id, actor_id: 'ae_wang', reason: '客户本周出差，下周再约' }));
line('拒绝后 wf_lead_b:', await wfBrief(wf('lead_b')));
line('同上下文再看一次（应无重提）:', await wfBrief(wf('lead_b')));

section('13. 14:30 新事实（CRM 建商机）解除拒绝约束，但仍需再次审批');
line('deal_created deal_b:', await emit('deal.created', {
  deal_id: 'deal_b', lead_id: 'lead_b', contact_id: 'contact_b', owner_id: 'ae_wang',
  initial_stage: 'qualification', amount: 30000, currency: 'CNY', expected_close_at: inDays(65, 0, 0),
  source_record_id: `sd-${RUN}-deal-b`,
}, T(14, 30)));
const afterWake = await wfBrief(wf('lead_b'));
line('唤醒后 wf_lead_b:', afterWake);
line('approve lead_b:', await post(`/workflows/${wf('lead_b')}/approve`, { action_id: afterWake.pending.id, actor_id: 'ae_wang' }));
line('批准后 wf_lead_b:', await wfBrief(wf('lead_b')));

section('14. 15:00 销售取消 lead_c（不再跟进），15:10 客户迟到回复');
line('cancel wf_lead_c:', await post(`/workflows/${wf('lead_c')}/cancel`, { actor_id: 'ae_li' }));
line('lead_c email.replied(迟到):', await emit('email.replied', {
  message_id: 'msg_c1', reply_id: 'reply_c1', lead_id: 'lead_c', contact_id: 'contact_c',
  reply_at: T(15, 10), sentiment: 'positive', intent: 'buying_signal', body_reference: 'gmail:c#1',
  provider_reference: 'sg-reply-c1', provider: 'sendgrid', correlation_id: 'corr-reply-c1',
}, T(15, 10)));
line('wf_lead_c:', await wfBrief(wf('lead_c')));
const open = await get('/exceptions?status=open&limit=50');
line('GET /exceptions?status=open:', { total: open.b.total, items: open.b.items.map((i) => ({ id: i.exception_id, reason: i.reason, event: i.event?.type, status: i.status, wf: i.subject?.workflow_instance_id })) });
const ex = open.b.items.find((i) => i.reason === 'workflow_ended');
line('resolve 异常(销售结论:转人工继续跟进):', ex === undefined ? '未找到 workflow_ended' : await post(`/exceptions/${ex.exception_id}/resolve`, { resolution: '客户仍要采购，转人工继续跟进', reason: '自动流程已取消', actor_id: 'ae_li' }));

section('15. 16:00 CRM 推进 lead_a 成交 → 流程结束');
line('deal.stage_changed → won:', await emit('deal.stage_changed', {
  deal_id: 'deal_a', lead_id: 'lead_a', from_stage: 'proposal', to_stage: 'won',
  changed_by: 'ae_wang', reason: '合同签署',
}, T(16, 0)));
line('wf_lead_a:', await wfBrief(wf('lead_a')));
line('GET /deals?stage=won:', await get('/deals?stage=won'));

section('16. 收盘看板');
line('GET /leads?owner_id=ae_wang:', await get('/leads?owner_id=ae_wang'));
line('GET /deals?owner_id=ae_wang:', await get('/deals?owner_id=ae_wang'));
line('GET /workflows:', (await get('/workflows?limit=20')).b.items.map((i) => `${i.workflow_instance_id}=${i.status}`));
line('GET /exceptions?status=all:', (await get('/exceptions?status=all&limit=50')).b.items.map((i) => `${i.reason}:${i.status}`));
line('审计链 wf_lead_a:', await auditChain(wf('lead_a')));
line('审计链 wf_lead_b:', await auditChain(wf('lead_b')));
line('审计链 wf_lead_c:', await auditChain(wf('lead_c')));
