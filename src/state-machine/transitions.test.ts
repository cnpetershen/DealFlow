import { describe, expect, it } from 'vitest';

import { isEventType } from '../events/dictionary';
import {
  DEAL_STAGES,
  isDealTerminal,
  isLeadTerminal,
  isWorkflowTerminal,
  LEAD_STATUSES,
  WORKFLOW_STATUSES,
} from './states';
import {
  DEAL_TRANSITIONS,
  KEEP_CURRENT,
  LEAD_TRANSITIONS,
  validateDealTransition,
  validateLeadTransition,
  validateWorkflowTransition,
  WORKFLOW_TRANSITIONS,
  WORKFLOW_TRIGGERS,
  type TransitionResult,
  type TransitionRow,
} from './transitions';

function expectAllowed<TState>(result: TransitionResult<TState>) {
  expect(result.allowed).toBe(true);
  if (!result.allowed) {
    throw new Error(`期望迁移被允许，实际被拒绝：${result.code} - ${result.detail}`);
  }
  return result;
}

function expectRejected<TState>(result: TransitionResult<TState>, code: string) {
  expect(result.allowed).toBe(false);
  if (result.allowed) {
    throw new Error(`期望迁移被拒绝，实际被允许：${result.to.join(', ')}`);
  }
  expect(result.code).toBe(code);
  return result;
}

/** 统计表中「能够进入」的状态。自环（保持当前状态）不产生新的可达状态，故跳过。 */
function enteredStates<TState extends string>(
  rows: readonly { readonly from: string | null; readonly to: readonly TState[] | string }[],
): Set<TState> {
  const entered = new Set<TState>();
  for (const row of rows) {
    if (row.to === KEEP_CURRENT) {
      continue;
    }
    for (const target of row.to as readonly TState[]) {
      entered.add(target);
    }
  }
  return entered;
}

/** 同一张表内 (from, trigger, to) 组合必须唯一，否则无目标校验会依赖行的书写顺序。 */
function assertNoDuplicateRows<TState, TTrigger extends string>(
  rows: readonly TransitionRow<TState, TTrigger>[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const targets = row.to === KEEP_CURRENT ? KEEP_CURRENT : row.to.join('|');
    const key = `${String(row.from)}::${row.trigger}::${targets}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
}

describe('Lead 迁移校验', () => {
  it('new + lead.created 保持 new', () => {
    expect(expectAllowed(validateLeadTransition('new', 'lead.created')).to).toEqual(['new']);
  });

  it('new + lead.assigned 进入 assigned', () => {
    expect(expectAllowed(validateLeadTransition('new', 'lead.assigned')).to).toEqual(['assigned']);
  });

  it('assigned + email.sent 保持 assigned', () => {
    expect(expectAllowed(validateLeadTransition('assigned', 'email.sent')).to).toEqual([
      'assigned',
    ]);
  });

  it('assigned + email.replied 进入 engaged', () => {
    expect(expectAllowed(validateLeadTransition('assigned', 'email.replied')).to).toEqual([
      'engaged',
    ]);
  });

  it('engaged + meeting.scheduled 允许 qualified 或 engaged 两种结果', () => {
    expect(expectAllowed(validateLeadTransition('engaged', 'meeting.scheduled')).to).toEqual([
      'qualified',
      'engaged',
    ]);
  });

  it('qualified + deal.created 进入 converted', () => {
    expect(expectAllowed(validateLeadTransition('qualified', 'deal.created')).to).toEqual([
      'converted',
    ]);
  });

  it('qualified + proposal.sent 进入 converted', () => {
    expect(expectAllowed(validateLeadTransition('qualified', 'proposal.sent')).to).toEqual([
      'converted',
    ]);
  });

  it('任意未终态 + task.overdue 保持当前状态', () => {
    for (const status of LEAD_STATUSES) {
      if (isLeadTerminal(status)) {
        continue;
      }
      const result = validateLeadTransition(status, 'task.overdue');
      expect(expectAllowed(result).to).toEqual([status]);
      expect(result.from).toBe(status);
    }
  });

  it('事件未在表中声明时拒绝为 unsupported_trigger', () => {
    // new 不是 email.replied 的合法来源，且没有匹配的任意未终态行。
    expectRejected(validateLeadTransition('new', 'email.replied'), 'unsupported_trigger');
  });

  it('终态 Lead 拒绝任何迁移', () => {
    for (const status of LEAD_STATUSES) {
      if (!isLeadTerminal(status)) {
        continue;
      }
      expectRejected(validateLeadTransition(status, 'lead.assigned'), 'terminal_state');
      // 终态优先于「任意未终态」行：task.overdue 也不能唤醒终态 Lead。
      expectRejected(validateLeadTransition(status, 'task.overdue'), 'terminal_state');
    }
  });

  it('拒绝结果回传来源状态与可读原因', () => {
    const result = expectRejected(validateLeadTransition('new', 'email.replied'), 'unsupported_trigger');
    expect(result.from).toBe('new');
    expect(result.detail).toContain('email.replied');
    expect(result.detail).toContain('new');
  });
});

describe('Deal 迁移校验', () => {
  it('Deal 不存在 + deal.created 建立 qualification', () => {
    const result = validateDealTransition(null, 'deal.created', 'qualification');
    expect(expectAllowed(result).to).toEqual(['qualification']);
    expect(result.from).toBeNull();
  });

  it('qualification + deal.stage_changed(discovery) 进入 discovery', () => {
    expect(
      expectAllowed(validateDealTransition('qualification', 'deal.stage_changed', 'discovery')).to,
    ).toEqual(['discovery']);
  });

  it('discovery + deal.stage_changed(proposal) 进入 proposal', () => {
    expect(
      expectAllowed(validateDealTransition('discovery', 'deal.stage_changed', 'proposal')).to,
    ).toEqual(['proposal']);
  });

  it('proposal + deal.stage_changed(negotiation) 进入 negotiation', () => {
    expect(
      expectAllowed(validateDealTransition('proposal', 'deal.stage_changed', 'negotiation')).to,
    ).toEqual(['negotiation']);
  });

  it('discovery + proposal.sent 直接推进到 proposal', () => {
    expect(expectAllowed(validateDealTransition('discovery', 'proposal.sent', 'proposal')).to).toEqual(
      ['proposal'],
    );
  });

  it('proposal + proposal.sent 保持 proposal', () => {
    expect(expectAllowed(validateDealTransition('proposal', 'proposal.sent', 'proposal')).to).toEqual(
      ['proposal'],
    );
  });

  it('任意非终态 + deal.stage_changed 可直达 won', () => {
    for (const stage of DEAL_STAGES) {
      if (isDealTerminal(stage)) {
        continue;
      }
      expect(expectAllowed(validateDealTransition(stage, 'deal.stage_changed', 'won')).to).toEqual([
        'won',
      ]);
      expect(expectAllowed(validateDealTransition(stage, 'deal.stage_changed', 'lost')).to).toEqual([
        'lost',
      ]);
    }
  });

  it('跨级跳转被拒绝为 illegal_transition', () => {
    expectRejected(
      validateDealTransition('qualification', 'deal.stage_changed', 'proposal'),
      'illegal_transition',
    );
    expectRejected(
      validateDealTransition('qualification', 'deal.stage_changed', 'negotiation'),
      'illegal_transition',
    );
    expectRejected(
      validateDealTransition('negotiation', 'deal.stage_changed', 'discovery'),
      'illegal_transition',
    );
  });

  it('请求的 to_stage 与事件允许的目标不一致时拒绝', () => {
    // deal.created 只能建立 qualification。
    expectRejected(validateDealTransition(null, 'deal.created', 'discovery'), 'illegal_transition');
    // 未进入终态的 Deal 不能通过 proposal.sent 改阶段。
    expectRejected(
      validateDealTransition('qualification', 'proposal.sent', 'proposal'),
      'unsupported_trigger',
    );
  });

  it('Deal 不存在时只接受 deal.created', () => {
    expectRejected(
      validateDealTransition(null, 'deal.stage_changed', 'discovery'),
      'unsupported_trigger',
    );
    expectRejected(validateDealTransition(null, 'proposal.sent', 'proposal'), 'unsupported_trigger');
  });

  it('终态 Deal 拒绝任何迁移', () => {
    for (const stage of DEAL_STAGES) {
      if (!isDealTerminal(stage)) {
        continue;
      }
      expectRejected(
        validateDealTransition(stage, 'deal.stage_changed', 'lost'),
        'terminal_state',
      );
      expectRejected(validateDealTransition(stage, 'proposal.sent', 'proposal'), 'terminal_state');
    }
  });
});

describe('Workflow 迁移校验', () => {
  it('pending + started 进入 running', () => {
    expect(expectAllowed(validateWorkflowTransition('pending', 'started')).to).toEqual(['running']);
  });

  it('running + action_dispatched 进入 waiting_result', () => {
    expect(expectAllowed(validateWorkflowTransition('running', 'action_dispatched')).to).toEqual([
      'waiting_result',
    ]);
  });

  it('running + approval_required 进入 needs_review', () => {
    expect(expectAllowed(validateWorkflowTransition('running', 'approval_required')).to).toEqual([
      'needs_review',
    ]);
  });

  it('running + processing_error 进入 failed', () => {
    expect(expectAllowed(validateWorkflowTransition('running', 'processing_error')).to).toEqual([
      'failed',
    ]);
  });

  it('running + workflow_finished 进入 completed', () => {
    expect(expectAllowed(validateWorkflowTransition('running', 'workflow_finished')).to).toEqual([
      'completed',
    ]);
  });

  it('waiting_result + result_event_matched 进入 replanning', () => {
    expect(
      expectAllowed(validateWorkflowTransition('waiting_result', 'result_event_matched')).to,
    ).toEqual(['replanning']);
  });

  it('needs_review 的人工批准与拒绝都进入 replanning', () => {
    expect(expectAllowed(validateWorkflowTransition('needs_review', 'approval_granted')).to).toEqual(
      ['replanning'],
    );
    expect(
      expectAllowed(validateWorkflowTransition('needs_review', 'approval_rejected')).to,
    ).toEqual(['replanning']);
  });

  it('needs_review 的失效动作重新规划进入 replanning', () => {
    expect(expectAllowed(validateWorkflowTransition('needs_review', 'stale_action')).to).toEqual([
      'replanning',
    ]);
  });

  it('replanning + replan_completed 允许 running / waiting_result / needs_review', () => {
    expect(expectAllowed(validateWorkflowTransition('replanning', 'replan_completed')).to).toEqual([
      'running',
      'waiting_result',
      'needs_review',
    ]);
  });

  it('replanning + workflow_finished 进入 completed', () => {
    expect(expectAllowed(validateWorkflowTransition('replanning', 'workflow_finished')).to).toEqual([
      'completed',
    ]);
  });

  it('failed + retry 恢复 running', () => {
    expect(expectAllowed(validateWorkflowTransition('failed', 'retry')).to).toEqual(['running']);
  });

  it('任意非终态 + cancel_requested 进入 cancelled', () => {
    for (const status of WORKFLOW_STATUSES) {
      if (isWorkflowTerminal(status)) {
        continue;
      }
      expect(expectAllowed(validateWorkflowTransition(status, 'cancel_requested')).to).toEqual([
        'cancelled',
      ]);
    }
  });

  it('终态 Workflow 拒绝任何迁移', () => {
    for (const status of WORKFLOW_STATUSES) {
      if (!isWorkflowTerminal(status)) {
        continue;
      }
      expectRejected(validateWorkflowTransition(status, 'cancel_requested'), 'terminal_state');
      expectRejected(validateWorkflowTransition(status, 'retry'), 'terminal_state');
    }
  });

  it('未声明的控制面触发器被拒绝', () => {
    expectRejected(validateWorkflowTransition('pending', 'action_dispatched'), 'unsupported_trigger');
    expectRejected(validateWorkflowTransition('completed', 'retry'), 'terminal_state');
  });
});

describe('迁移表完整性', () => {
  it('Lead 与 Deal 的触发器都是已注册的事件类型', () => {
    for (const row of [...LEAD_TRANSITIONS, ...DEAL_TRANSITIONS]) {
      expect(isEventType(row.trigger)).toBe(true);
    }
  });

  it('Workflow 的触发器都在 WORKFLOW_TRIGGERS 内', () => {
    for (const row of WORKFLOW_TRANSITIONS) {
      expect(WORKFLOW_TRIGGERS).toContain(row.trigger);
    }
  });

  it('同一张表内 (from, trigger, to) 组合不重复', () => {
    // Deal 的 deal.stage_changed 允许同一来源与触发器指向不同目标（won / lost），
    // 因此唯一性必须把目标集合一起纳入。
    assertNoDuplicateRows(LEAD_TRANSITIONS);
    assertNoDuplicateRows(DEAL_TRANSITIONS);
    assertNoDuplicateRows(WORKFLOW_TRANSITIONS);
  });

  it('表中引用的状态都属于对应枚举', () => {
    for (const row of LEAD_TRANSITIONS) {
      if (row.from !== null && row.from !== '*') {
        expect(LEAD_STATUSES).toContain(row.from);
      }
      if (row.to !== KEEP_CURRENT) {
        for (const target of row.to) {
          expect(LEAD_STATUSES).toContain(target);
        }
      }
    }
    for (const row of DEAL_TRANSITIONS) {
      if (row.from !== null && row.from !== '*') {
        expect(DEAL_STAGES).toContain(row.from);
      }
      if (row.to !== KEEP_CURRENT) {
        for (const target of row.to) {
          expect(DEAL_STAGES).toContain(target);
        }
      }
    }
    for (const row of WORKFLOW_TRANSITIONS) {
      if (row.from !== '*') {
        expect(WORKFLOW_STATUSES).toContain(row.from);
      }
      if (row.to !== KEEP_CURRENT) {
        for (const target of row.to) {
          expect(WORKFLOW_STATUSES).toContain(target);
        }
      }
    }
  });

  it('Deal 与 Workflow 的每个状态都能被进入（初始态除外）', () => {
    expect([...enteredStates(DEAL_TRANSITIONS)].sort()).toEqual([...DEAL_STAGES].sort());
    // pending 是初始态，没有入边。
    expect([...enteredStates(WORKFLOW_TRANSITIONS)].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'needs_review',
      'replanning',
      'running',
      'waiting_result',
    ]);
  });

  it('Lead 当前可达状态集合固定，nurturing/disqualified/closed 无入边（已知规格缺口）', () => {
    // nurturing、disqualified、closed 目前没有事件能够进入：docs/state-machine.md 未定义对应迁移行，
    // docs/events.md 也没有相应事件。补齐规格后此断言需要同步更新。
    expect([...enteredStates(LEAD_TRANSITIONS)].sort()).toEqual([
      'assigned',
      'converted',
      'engaged',
      'new',
      'qualified',
    ]);
  });
});
