import { describe, expect, it } from 'vitest';

import { proposedAction } from '../testing/fixtures';
import {
  ACTION_METADATA,
  ACTION_TYPES,
  isActionType,
  parseProposedAction,
  proposedActionSchema,
} from './types';

describe('ACTION_METADATA', () => {
  it('为每个动作类型都登记了固有属性', () => {
    expect(Object.keys(ACTION_METADATA).sort()).toEqual([...ACTION_TYPES].sort());

    for (const actionType of ACTION_TYPES) {
      const metadata = ACTION_METADATA[actionType];
      expect(metadata.default_ttl_hours).toBeGreaterThan(0);
      expect(typeof metadata.external_communication).toBe('boolean');
    }
  });

  it('把涉及报价与条款的动作标记为商业内容且高风险', () => {
    expect(ACTION_METADATA.send_proposal).toMatchObject({
      risk_level: 'high',
      commercial: true,
      external_communication: true,
    });
    expect(ACTION_METADATA.create_task).toMatchObject({
      commercial: false,
      external_communication: false,
    });
  });
});

describe('isActionType', () => {
  it('识别已知动作类型', () => {
    expect(isActionType('send_email')).toBe(true);
    expect(isActionType('delete_everything')).toBe(false);
  });
});

describe('proposedActionSchema', () => {
  it('接受各动作类型的合法动作', () => {
    const actions = [
      proposedAction(),
      proposedAction({
        action_type: 'schedule_meeting',
        parameters: {
          agenda: '需求确认',
          duration_minutes: 30,
          earliest_start_at: '2026-09-24T10:05:00+08:00',
        },
      }),
      proposedAction({
        action_type: 'create_task',
        parameters: {
          task_type: 'follow_up',
          assigned_to: 'user_7',
          due_at: '2026-09-25T10:05:00+08:00',
          note: '等待回复',
        },
      }),
      proposedAction({
        action_type: 'send_proposal',
        parameters: { document_reference: 'doc_rev_1', amount: 120000, currency: 'CNY' },
      }),
      proposedAction({
        action_type: 'advance_deal_stage',
        parameters: { to_stage: 'discovery' },
      }),
    ];

    for (const action of actions) {
      expect(proposedActionSchema.parse(action)).toEqual(action);
    }
  });

  it('拒绝未知动作类型', () => {
    expect(() => parseProposedAction(proposedAction({ action_type: 'send_sms' as never }))).toThrow();
  });

  it('拒绝与动作类型不匹配的参数', () => {
    const mismatched = proposedAction({ parameters: { to_stage: 'discovery' } });

    expect(() => parseProposedAction(mismatched)).toThrow();
  });

  it('拒绝缺失的必填字段', () => {
    const { expected_outcome: _omitted, ...withoutOutcome } = proposedAction();

    expect(() => parseProposedAction(withoutOutcome)).toThrow();
  });

  it('拒绝非法的风险等级与参数来源', () => {
    expect(() => parseProposedAction(proposedAction({ risk_level: 'critical' as never }))).toThrow();
    expect(() =>
      parseProposedAction(proposedAction({ parameter_source: 'guess' as never })),
    ).toThrow();
  });

  it('要求幂等 key 非空且 plan_version 为正整数', () => {
    expect(() => parseProposedAction(proposedAction({ execution_idempotency_key: '' }))).toThrow();
    expect(() => parseProposedAction(proposedAction({ plan_version: 0 }))).toThrow();
    expect(() => parseProposedAction(proposedAction({ plan_version: 1.5 }))).toThrow();
  });

  it('可为空字段必须存在且值可为 null，不允许用 undefined 省略', () => {
    expect(parseProposedAction(proposedAction({ deal_id: null })).deal_id).toBeNull();
    expect(() => parseProposedAction(proposedAction({ deal_id: undefined as never }))).toThrow();
  });

  it('校验时间字段必须带时区', () => {
    expect(() => parseProposedAction(proposedAction({ expires_at: '2026-09-26 10:05:00' }))).toThrow();
  });
});