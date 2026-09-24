import { describe, expect, it } from 'vitest';

import {
  contactState,
  dealState,
  decisionContext,
  leadState,
  policyContext,
  proposedAction,
} from '../testing/fixtures';
import type { DecisionContext } from '../decision/context';
import type { ProposedAction } from '../decision/types';
import { RuleBasedPolicyEvaluator } from './rule-based-policy';
import { AUTO_CONDITION_CODES, type PolicyRejectCode, type PolicyReviewCode } from './types';

function evaluate(
  action: ProposedAction,
  context: DecisionContext = decisionContext(),
) {
  return new RuleBasedPolicyEvaluator().evaluate(action, context);
}

/** 断言 Human Review 的触发原因包含指定编码。 */
function expectReview(action: ProposedAction, context: DecisionContext, code: PolicyReviewCode) {
  const outcome = evaluate(action, context);

  expect(outcome.decision).toBe('human_review');
  expect(outcome.decision === 'human_review' ? outcome.reasons.map((r) => r.code) : []).toContain(
    code,
  );
}

/** 断言硬性 Reject 及其首要编码。 */
function expectReject(action: ProposedAction, context: DecisionContext, code: PolicyRejectCode) {
  const outcome = evaluate(action, context);

  expect(outcome.decision).toBe('reject');
  expect(outcome.decision === 'reject' ? outcome.code : null).toBe(code);
}

describe('RuleBasedPolicyEvaluator 可自动执行', () => {
  it('全部条件满足时输出 Auto 并记录满足的条件', () => {
    const outcome = evaluate(proposedAction());

    expect(outcome.decision).toBe('auto');
    expect(outcome.decision === 'auto' ? [...outcome.satisfied_conditions] : []).toEqual([
      ...AUTO_CONDITION_CODES,
    ]);
    expect(outcome.action_id).toBe('action_1');
    expect(outcome.policy_version).toBe('policy_v1');
    expect(outcome.evaluated_at).toBe('2026-09-24T10:05:00+08:00');
  });

  it('非对外沟通动作不受联系偏好与发送窗口约束', () => {
    const action = proposedAction({
      action_type: 'create_task',
      parameters: {
        task_type: 'follow_up',
        assigned_to: 'user_7',
        due_at: '2026-09-25T10:05:00+08:00',
        note: '三天后跟进',
      },
    });
    const context = decisionContext({
      contact_state: null,
      policy_context: policyContext({ evaluated_at: '2026-09-24T22:00:00+08:00' }),
    });

    expect(evaluate(action, context).decision).toBe('auto');
  });

  it('相同输入多次判定结果一致', () => {
    expect(evaluate(proposedAction())).toEqual(evaluate(proposedAction()));
  });
});

describe('RuleBasedPolicyEvaluator 硬性禁止', () => {
  it('退订联系人上的外发动作被拒绝', () => {
    expectReject(
      proposedAction(),
      decisionContext({ contact_state: contactState({ contactability: 'unsubscribed' }) }),
      'unsubscribed_contact',
    );
  });

  it('终态 Deal 上的普通跟进被拒绝', () => {
    expectReject(
      proposedAction({ deal_id: 'deal_1' }),
      decisionContext({ deal_state: dealState({ stage: 'lost' }) }),
      'terminal_subject',
    );
  });

  it('终态 Lead 上的动作被拒绝', () => {
    expectReject(
      proposedAction(),
      decisionContext({ lead_state: leadState({ status: 'closed' }) }),
      'terminal_subject',
    );
  });

  it('超出组织允许动作边界的动作被拒绝', () => {
    expectReject(
      proposedAction(),
      decisionContext({
        policy_context: policyContext({ permitted_action_types: ['create_task'] }),
      }),
      'unauthorized_action',
    );
  });

  it('plan_version 与当前计划不一致时被拒绝', () => {
    expectReject(
      proposedAction({ plan_version: 2 }),
      decisionContext({ workflow_instance: { ...decisionContext().workflow_instance, plan_version: 3 } }),
      'stale_plan_version',
    );
  });

  it('已过期动作被拒绝', () => {
    expectReject(
      proposedAction({ expires_at: '2026-09-24T10:00:00+08:00' }),
      decisionContext(),
      'action_expired',
    );
  });

  it('有效期恰好等于判定时刻时视为已过期', () => {
    expectReject(
      proposedAction({ expires_at: '2026-09-24T10:05:00+08:00' }),
      decisionContext(),
      'action_expired',
    );
  });

  it('执行幂等 key 已产生过业务效果时被拒绝', () => {
    expectReject(
      proposedAction(),
      decisionContext({
        idempotency_context: {
          input_event_id: 'evt_0002',
          processed_idempotency_keys: ['exec:lead_1:send_email:1:action_1'],
        },
      }),
      'already_executed',
    );
  });

  it('缺少执行幂等 key 时被拒绝', () => {
    expectReject(proposedAction({ execution_idempotency_key: '' }), decisionContext(), 'missing_idempotency_key');
  });

  it('多个硬性原因同时命中时按判定顺序返回首要原因', () => {
    const action = proposedAction({ expires_at: '2026-09-24T10:00:00+08:00' });
    const context = decisionContext({ contact_state: contactState({ contactability: 'unsubscribed' }) });
    const outcome = evaluate(action, context);

    expect(outcome.decision).toBe('reject');
    expect(outcome.decision === 'reject' ? outcome.code : null).toBe('action_expired');
    expect(outcome.decision === 'reject' ? outcome.reasons.map((r) => r.code) : []).toEqual([
      'action_expired',
      'unsubscribed_contact',
    ]);
  });
});

describe('RuleBasedPolicyEvaluator 必须人工审核', () => {
  it('动作类型不在自动化白名单内时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ policy_context: policyContext({ automation_whitelist: ['create_task'] }) }),
      'not_automation_eligible',
    );
  });

  it('Decision 已标记需要审核时转人工', () => {
    expectReview(proposedAction({ requires_approval: true }), decisionContext(), 'not_automation_eligible');
  });

  it('发送给新联系人时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ contact_state: contactState({ is_new_contact: true }) }),
      'new_or_key_contact',
    );
  });

  it('关键客户的外部沟通转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ policy_context: policyContext({ key_account_lead_ids: ['lead_1'] }) }),
      'new_or_key_contact',
    );
  });

  it('高价值 Deal 的外部沟通转人工', () => {
    expectReview(
      proposedAction({ deal_id: 'deal_1' }),
      decisionContext({ deal_state: dealState({ amount: 600000 }) }),
      'high_value_deal',
    );
  });

  it('涉及报价与条款的动作转人工', () => {
    const action = proposedAction({
      action_type: 'send_proposal',
      risk_level: 'low',
      parameters: { document_reference: 'doc_rev_1', amount: 120000, currency: 'CNY' },
      deal_id: 'deal_1',
    });
    const context = decisionContext({
      deal_state: dealState({ stage: 'discovery' }),
      policy_context: policyContext({ automation_whitelist: ['send_proposal'] }),
    });

    expectReview(action, context, 'commercial_terms');
  });

  it('需要覆盖客户联系偏好时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ contact_state: contactState({ contact_preference: 'human_only' }) }),
      'contact_preference_override',
    );
  });

  it('事实冲突时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ data_conflicts: ['Lead.owner_id 与最近分配事件不一致'] }),
      'data_conflict',
    );
  });

  it('参数来自模型猜测时转人工', () => {
    expectReview(
      proposedAction({ parameter_source: 'model_inference' }),
      decisionContext(),
      'uncertain_basis',
    );
  });

  it('发送窗口外或频率超阈值时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ policy_context: policyContext({ evaluated_at: '2026-09-24T20:05:00+08:00' }) }),
      'automation_limit_reached',
    );
    expectReview(
      proposedAction(),
      decisionContext({
        policy_context: policyContext({ max_auto_actions_per_day: 2, auto_actions_today: 2 }),
      }),
      'automation_limit_reached',
    );
  });

  it('Policy 版本变化导致旧动作不可信时转人工', () => {
    expectReview(
      proposedAction({ policy_version: 'policy_v0' }),
      decisionContext(),
      'stale_policy_version',
    );
  });

  it('推进高风险阶段或关闭销售机会时转人工', () => {
    for (const toStage of ['negotiation', 'won', 'lost'] as const) {
      const action = proposedAction({
        action_type: 'advance_deal_stage',
        deal_id: 'deal_1',
        parameters: { to_stage: toStage },
      });

      expectReview(
        action,
        decisionContext({
          deal_state: dealState({ stage: 'discovery' }),
          policy_context: policyContext({ automation_whitelist: ['advance_deal_stage'] }),
        }),
        'high_risk_stage_advance',
      );
    }
  });

  it('操作者未被授权触发自动动作时转人工', () => {
    expectReview(
      proposedAction(),
      decisionContext({ policy_context: policyContext({ permitted_actor_ids: ['user_9'] }) }),
      'auto_condition_not_met',
    );
  });

  it('风险等级高于自动执行上限时按兜底规则转人工', () => {
    const outcome = evaluate(proposedAction({ risk_level: 'high' }));

    expect(outcome.decision).toBe('human_review');
    expect(outcome.decision === 'human_review' ? outcome.reasons[0] : null).toMatchObject({
      code: 'auto_condition_not_met',
    });
    expect(outcome.decision === 'human_review' ? outcome.reasons[0]?.detail : '').toContain(
      'risk_within_auto_limit',
    );
  });

  it('同时命中多个审核原因时全部记录', () => {
    const context = decisionContext({
      data_conflicts: ['联系人信息冲突'],
      contact_state: contactState({ is_new_contact: true }),
    });
    const outcome = evaluate(proposedAction(), context);

    expect(
      outcome.decision === 'human_review' ? outcome.reasons.map((r) => r.code) : [],
    ).toEqual(expect.arrayContaining(['new_or_key_contact', 'data_conflict']));
  });
});

describe('RuleBasedPolicyEvaluator 与 Decider 的边界', () => {
  it('Decider 提出的动作在正常上下文中可被自动执行', () => {
    const action = proposedAction();

    expect(evaluate(action).decision).toBe('auto');
  });
});