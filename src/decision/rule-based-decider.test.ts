import { describe, expect, it } from 'vitest';

import {
  contactState,
  dealState,
  decisionContext,
  emailRepliedEvent,
  emailSentEvent,
  leadState,
  meetingScheduledEvent,
  policyContext,
  proposalSentEvent,
  workflowState,
} from '../testing/fixtures';
import type { DecisionContext, PreviousDecision } from './context';
import { RuleBasedDecider } from './rule-based-decider';
import { ACTION_METADATA, type ProposedAction } from './types';
import type { WorkflowInstanceState } from '../stores/types';

function workflowWith(overrides: Partial<WorkflowInstanceState> = {}): WorkflowInstanceState {
  return workflowState({ status: 'running', current_step: 'first_follow_up', ...overrides });
}

function decide(context: DecisionContext): readonly ProposedAction[] {
  return new RuleBasedDecider().decide(context);
}

function only(context: DecisionContext): ProposedAction {
  const actions = decide(context);
  expect(actions).toHaveLength(1);

  return actions[0]!;
}

describe('RuleBasedDecider 决策边界', () => {
  it('Workflow 已进入终态时不再提出任何动作', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(decide(decisionContext({ workflow_instance: workflowWith({ status }) }))).toEqual([]);
    }
  });

  it('Workflow 未处于可决策状态时不提出动作', () => {
    for (const status of ['pending', 'waiting_result', 'needs_review', 'failed'] as const) {
      expect(decide(decisionContext({ workflow_instance: workflowWith({ status }) }))).toEqual([]);
    }
  });

  it('replanning 状态允许重新规划', () => {
    const action = only(decisionContext({ workflow_instance: workflowWith({ status: 'replanning' }) }));

    expect(action.action_type).toBe('send_email');
  });

  it('Lead 缺失或已进入终态时不再提出动作', () => {
    expect(decide(decisionContext({ lead_state: null }))).toEqual([]);

    for (const status of ['disqualified', 'closed'] as const) {
      expect(decide(decisionContext({ lead_state: leadState({ status }) }))).toEqual([]);
    }
  });

  it('Deal 已进入终态时不再提出动作', () => {
    for (const stage of ['won', 'lost'] as const) {
      expect(
        decide(decisionContext({ deal_state: dealState({ stage }), lead_state: leadState({ status: 'converted' }) })),
      ).toEqual([]);
    }
  });

  it('没有任何可执行事实时返回空数组而不是强行推进', () => {
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'new', owner_id: null }),
          contact_state: null,
          recent_events: [emailSentEvent()],
        }),
      ),
    ).toEqual([]);
  });
});

describe('RuleBasedDecider 首次跟进', () => {
  it('提出首次跟进邮件，并完整填写审计所需字段', () => {
    const action = only(decisionContext());

    expect(action).toMatchObject({
      action_type: 'send_email',
      subject_type: 'lead',
      subject_id: 'lead_1',
      workflow_instance_id: 'wf_1',
      lead_id: 'lead_1',
      contact_id: 'contact_1',
      deal_id: null,
      risk_level: ACTION_METADATA.send_email.risk_level,
      policy_version: 'policy_v1',
      plan_version: 1,
      requires_approval: false,
      parameter_source: 'verified_config',
    });
    expect(action.parameters).toEqual({
      template_id: 'tpl_first_touch',
      recipient_email: 'buyer@acme.example',
      subject: null,
    });
    expect(action.reason).toContain('lead_1');
    expect(action.expected_outcome.length).toBeGreaterThan(0);
  });

  it('有效期按动作元数据的 TTL 从建议提出时刻推算', () => {
    expect(only(decisionContext()).expires_at).toBe('2026-09-26T02:05:00.000Z');
  });

  it('事实很旧时建议不会出生即过期：有效期锚定提出时刻而不是事件时间', () => {
    // 事件发生在 09-24，建议直到 09-30 才提出（CRM 回填 / webhook 迟到）
    const action = only(
      decisionContext({
        proposed_at: '2026-09-30T10:05:00+08:00',
        policy_context: policyContext({ evaluated_at: '2026-09-24T10:05:00+08:00' }),
      }),
    );

    expect(action.expires_at).toBe('2026-10-02T02:05:00.000Z');
    expect(Date.parse(action.expires_at)).toBeGreaterThan(Date.parse('2026-09-30T10:05:00+08:00'));
  });

  it('事实时间晚于提出时刻（客户端时钟偏差 / 预置未来时间）时，建议同样不会出生即过期', () => {
    const evaluatedAt = '2026-09-30T10:05:00+08:00';
    const action = only(
      decisionContext({
        proposed_at: '2026-09-24T10:05:00+08:00',
        policy_context: policyContext({ evaluated_at: evaluatedAt }),
      }),
    );

    // 不变量：刚提出的建议一定满足 expires_at > evaluated_at，否则会被 Policy 立刻判 action_expired
    expect(Date.parse(action.expires_at)).toBeGreaterThan(Date.parse(evaluatedAt));
  });

  it('缺少负责人时不提出需要负责人的自动动作', () => {
    expect(decide(decisionContext({ lead_state: leadState({ owner_id: null }) }))).toEqual([]);
  });

  it('缺少联系人邮箱或模板配置时不编造参数', () => {
    expect(decide(decisionContext({ contact_state: null }))).toEqual([]);
    expect(decide(decisionContext({ contact_state: contactState({ email: null }) }))).toEqual([]);
    expect(
      decide(
        decisionContext({
          verified_config: { ...decisionContext().verified_config, first_touch_email_template_id: null },
        }),
      ),
    ).toEqual([]);
  });

  it('已发出首次跟进邮件后不再重复提出', () => {
    expect(decide(decisionContext({ recent_events: [emailSentEvent()] }))).toEqual([]);
  });

  it('忽略属于其它 Lead 的结果事件', () => {
    const otherLead = emailSentEvent({
      payload: { ...emailSentEvent().payload, lead_id: 'lead_9' },
    });
    const action = only(decisionContext({ recent_events: [otherLead] }));

    expect(action.action_type).toBe('send_email');
  });
});

describe('RuleBasedDecider 互动与推进', () => {
  it('收到回复后提出会议动作并要求审核', () => {
    const action = only(
      decisionContext({
        lead_state: leadState({ status: 'engaged' }),
        recent_events: [emailSentEvent(), emailRepliedEvent()],
      }),
    );

    expect(action).toMatchObject({
      action_type: 'schedule_meeting',
      risk_level: ACTION_METADATA.schedule_meeting.risk_level,
      requires_approval: true,
      parameter_source: 'state',
    });
    expect(action.parameters).toMatchObject({ duration_minutes: 30, earliest_start_at: '2026-09-24T10:05:00+08:00' });
  });

  it('会议最早可开始时间锚定建议提出时刻，不会给出已经过去的时段', () => {
    const action = only(
      decisionContext({
        proposed_at: '2026-09-30T10:05:00+08:00',
        lead_state: leadState({ status: 'engaged' }),
        recent_events: [emailSentEvent(), emailRepliedEvent()],
        policy_context: policyContext({ evaluated_at: '2026-09-24T10:05:00+08:00' }),
      }),
    );

    expect(action.parameters).toMatchObject({ earliest_start_at: '2026-09-30T10:05:00+08:00' });
  });

  it('已安排会议后不再重复提出', () => {
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'engaged' }),
          recent_events: [
            emailRepliedEvent(),
            {
              ...emailSentEvent(),
              event_id: 'evt_0006',
              type: 'meeting.scheduled',
              idempotency_key: 'meeting.scheduled:meeting_1',
              payload: {
                meeting_id: 'meeting_1',
                lead_id: 'lead_1',
                contact_id: 'contact_1',
                organizer_id: 'user_7',
                scheduled_start_at: '2026-09-25T14:00:00+08:00',
                scheduled_end_at: '2026-09-25T14:30:00+08:00',
                calendar_provider: 'feishu',
                status: 'confirmed',
                provider_reference: null,
                provider: null,
                correlation_id: null,
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('Deal 处于资格确认阶段时推进一步，且目标阶段由状态机决定', () => {
    const action = only(
      decisionContext({
        lead_state: leadState({ status: 'converted' }),
        deal_state: dealState({ stage: 'qualification' }),
      }),
    );

    expect(action).toMatchObject({
      action_type: 'advance_deal_stage',
      deal_id: 'deal_1',
      risk_level: ACTION_METADATA.advance_deal_stage.risk_level,
      parameter_source: 'state',
    });
    expect(action.parameters).toEqual({ to_stage: 'discovery' });
  });

  it('未进入资格确认的 Deal 不会被提前推进', () => {
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'converted' }),
          deal_state: dealState({ stage: 'won' }),
        }),
      ),
    ).toEqual([]);
  });

  it('Lead 尚未发生有效互动时，Deal 阶段推进不抢先于邮件与会议流程', () => {
    // CRM 可能先建立 Deal；此时应优先走首次跟进邮件，而不是把阶段推进塞进人工审核。
    const early = decisionContext({
      lead_state: leadState({ status: 'assigned', owner_id: 'user_7' }),
      deal_state: dealState({ stage: 'qualification' }),
      recent_events: [],
    });

    expect(only(early).action_type).toBe('send_email');

    // 首次跟进邮件已发出后，Lead 仍停在 assigned：既不重复发邮件，也不抢先推进 Deal。
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'assigned', owner_id: 'user_7' }),
          deal_state: dealState({ stage: 'qualification' }),
          recent_events: [emailSentEvent()],
        }),
      ),
    ).toEqual([]);

    // 已发生有效互动后，阶段推进才成为候选动作。
    expect(
      only(
        decisionContext({
          lead_state: leadState({ status: 'engaged', owner_id: 'user_7' }),
          deal_state: dealState({ stage: 'qualification' }),
          recent_events: [emailSentEvent(), emailRepliedEvent(), meetingScheduledEvent()],
        }),
      ).action_type,
    ).toBe('advance_deal_stage');
  });

  it('Deal 处于发现或提案阶段且配置齐备时提出方案发送', () => {
    const context = decisionContext({
      lead_state: leadState({ status: 'converted' }),
      deal_state: dealState({ stage: 'discovery' }),
      verified_config: { ...decisionContext().verified_config, proposal_document_reference: 'doc_rev_1' },
    });
    const action = only(context);

    expect(action).toMatchObject({
      action_type: 'send_proposal',
      risk_level: ACTION_METADATA.send_proposal.risk_level,
      requires_approval: true,
    });
    expect(action.parameters).toEqual({
      document_reference: 'doc_rev_1',
      amount: 120000,
      currency: 'CNY',
    });
  });

  it('没有可用的方案文档时不提出方案发送', () => {
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'converted' }),
          deal_state: dealState({ stage: 'discovery' }),
        }),
      ),
    ).toEqual([]);
  });

  it('方案已发送后不再重复提出', () => {
    expect(
      decide(
        decisionContext({
          lead_state: leadState({ status: 'converted' }),
          deal_state: dealState({ stage: 'discovery' }),
          verified_config: { ...decisionContext().verified_config, proposal_document_reference: 'doc_rev_1' },
          recent_events: [proposalSentEvent()],
        }),
      ),
    ).toEqual([]);
  });
});

describe('RuleBasedDecider 逾期分支', () => {
  it('存在逾期任务时优先提出补救任务', () => {
    const action = only(
      decisionContext({
        pending_tasks: [
          {
            task_id: 'task_1',
            task_type: 'follow_up',
            assigned_to: 'user_7',
            due_at: '2026-09-23T10:00:00+08:00',
            status: 'overdue',
          },
        ],
      }),
    );

    expect(action).toMatchObject({
      action_type: 'create_task',
      risk_level: ACTION_METADATA.create_task.risk_level,
      requires_approval: false,
      parameter_source: 'state',
    });
    expect(action.parameters).toMatchObject({ task_type: 'overdue_remedy', assigned_to: 'user_7' });
    expect(action.reason).toContain('task_1');
  });

  it('补救任务到期时间锚定建议提出时刻，不会出生即逾期', () => {
    const action = only(
      decisionContext({
        proposed_at: '2026-09-30T10:05:00+08:00',
        policy_context: policyContext({ evaluated_at: '2026-09-24T10:05:00+08:00' }),
        pending_tasks: [
          {
            task_id: 'task_1',
            task_type: 'follow_up',
            assigned_to: 'user_7',
            due_at: '2026-09-23T10:00:00+08:00',
            status: 'overdue',
          },
        ],
      }),
    );

    expect(action.parameters).toMatchObject({ due_at: '2026-10-01T02:05:00.000Z' });
  });

  it('未逾期任务不触发补救动作', () => {
    const action = only(
      decisionContext({
        pending_tasks: [
          {
            task_id: 'task_1',
            task_type: 'follow_up',
            assigned_to: 'user_7',
            due_at: '2026-09-25T10:00:00+08:00',
            status: 'open',
          },
        ],
      }),
    );

    expect(action.action_type).toBe('send_email');
  });
});

describe('RuleBasedDecider 拒绝原因即规划约束', () => {
  const rejection = (basis_event_id: string | null): PreviousDecision => ({
    action_id: 'action_old',
    action_type: 'send_email',
    status: 'rejected',
    plan_version: 1,
    decided_by: 'user_9',
    reason: '改用人工联系',
    decided_at: '2026-09-24T10:04:00+08:00',
    basis_event_id,
  });

  it('拒绝所依据的事件仍是最后一条事件时，不再提出同类动作', () => {
    expect(
      decide(
        decisionContext({
          workflow_instance: workflowWith({ last_processed_event_id: 'evt_assigned' }),
          previous_decisions: [rejection('evt_assigned')],
        }),
      ),
    ).toEqual([]);
  });

  it('新事件进入后同一动作可以再次提出，但必须再次人工审核', () => {
    const action = only(
      decisionContext({
        workflow_instance: workflowWith({ last_processed_event_id: 'evt_new_fact' }),
        previous_decisions: [rejection('evt_assigned')],
      }),
    );

    expect(action).toMatchObject({ action_type: 'send_email', requires_approval: true });
    expect(action.reason).toContain('此前被人工拒绝');
  });

  it('缺少 basis_event_id 的历史拒绝记录不再永久阻断，但必须再次人工审核', () => {
    const legacy = rejection('evt_assigned');
    const { basis_event_id: _ignored, ...withoutBasis } = legacy;

    const action = only(
      decisionContext({
        workflow_instance: workflowWith({ last_processed_event_id: 'evt_new_fact' }),
        previous_decisions: [{ ...withoutBasis, basis_event_id: undefined as unknown as string | null }],
      }),
    );

    expect(action).toMatchObject({ action_type: 'send_email', requires_approval: true });
  });

  it('被拒绝后仍可提出类型不同的替代动作', () => {
    const action = only(
      decisionContext({
        previous_decisions: [rejection('evt_assigned')],
        pending_tasks: [
          {
            task_id: 'task_1',
            task_type: 'follow_up',
            assigned_to: 'user_7',
            due_at: '2026-09-23T10:00:00+08:00',
            status: 'overdue',
          },
        ],
      }),
    );

    expect(action.action_type).toBe('create_task');
  });

  it('已批准或被拒绝的历史结论不影响非拒绝类型的动作', () => {
    const action = only(
      decisionContext({
        previous_decisions: [
          {
            action_id: 'action_old',
            action_type: 'schedule_meeting',
            status: 'approved',
            plan_version: 1,
            decided_by: 'user_9',
            reason: null,
            decided_at: '2026-09-24T10:04:00+08:00',
            basis_event_id: 'evt_assigned',
          },
        ],
      }),
    );

    expect(action.action_type).toBe('send_email');
  });
});

describe('RuleBasedDecider 标识与可复现性', () => {
  it('为每个动作生成唯一标识与执行幂等 key', () => {
    const decider = new RuleBasedDecider();
    const context = decisionContext();
    const first = decider.decide(context)[0]!;
    const second = decider.decide(context)[0]!;

    expect(first.action_id).not.toBe(second.action_id);
    expect(first.execution_idempotency_key).not.toBe(second.execution_idempotency_key);
    expect(first.execution_idempotency_key).toContain(first.action_id);
  });

  it('允许注入标识生成器，保证测试与审计可复现', () => {
    let counter = 0;
    const decider = new RuleBasedDecider({ createActionId: () => `action_fixed_${++counter}` });

    expect(decider.decide(decisionContext())[0]!.action_id).toBe('action_fixed_1');
    expect(decider.decide(decisionContext())[0]!.action_id).toBe('action_fixed_2');
  });

  it('相同 Context 与相同标识生成器下产出完全一致的决策', () => {
    const first = new RuleBasedDecider({ createActionId: () => 'action_fixed' }).decide(decisionContext());
    const second = new RuleBasedDecider({ createActionId: () => 'action_fixed' }).decide(decisionContext());

    expect(first).toEqual(second);
  });

  it('派生的动作始终携带当前 plan_version 与 Policy 版本', () => {
    const action = only(
      decisionContext({
        workflow_instance: { ...decisionContext().workflow_instance, plan_version: 3 },
        policy_context: policyContext({ policy_version: 'policy_v2' }),
      }),
    );

    expect(action.plan_version).toBe(3);
    expect(action.policy_version).toBe('policy_v2');
  });
});