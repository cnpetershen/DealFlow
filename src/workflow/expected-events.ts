import type { EventType, ParsedEvent } from '../events/dictionary';
import {
  isDealTerminal,
  isLeadTerminal,
  isWorkflowTerminal,
  type WorkflowStatus,
} from '../state-machine/states';
import type { DealState, LeadState } from '../stores/types';

/**
 * 等待事件集推导。
 *
 * 对应 docs/state-machine.md「Workflow Resume 规则」第 3 条：只有匹配等待条件的事件才推进流程。
 * 当 Decider 暂时提不出动作时，流程**不应直接结束**，而要按当前 State 推导「还有哪些事件能推进它」，
 * 进入 `waiting_result` 休眠等待；只有当主体已进入终态、确实没有后续事件时才 `completed`。
 *
 * 推导结果同时是 Resume 的匹配条件，因此必须只包含「确实能让流程前进」的事件：
 * - 已经发生过且不会重复的入口事件（`deal.created`、`email.sent` 等）会被过滤掉；
 * - 已进入终态的 Lead / Deal 返回空集合（此时才允许结束 Workflow）。
 */

export interface ExpectedEventsInput {
  readonly workflow_status: WorkflowStatus;
  readonly lead: LeadState | null;
  readonly deal: DealState | null;
  readonly recent_events: readonly ParsedEvent[];
}

/**
 * 由 Lead 当前状态推导的可推进事件。
 * `hasDeal` 为真时过滤掉与 Deal 绑定的事件：它们只能由 Deal 当前阶段决定。
 */
function leadCandidatesFor(status: LeadState['status'], hasDeal: boolean): readonly EventType[] {
  const candidates = leadCandidates(status);
  return hasDeal ? candidates.filter((type) => !DEAL_BOUND_EVENTS.includes(type)) : candidates;
}

/** 由 Lead 当前状态推导的可推进事件。 */
function leadCandidates(status: LeadState['status']): readonly EventType[] {
  switch (status) {
    case 'new':
      return ['lead.assigned'];
    case 'assigned':
      return ['email.sent', 'email.replied'];
    case 'engaged':
      return ['email.replied', 'meeting.scheduled'];
    case 'qualified':
      return ['deal.created', 'proposal.sent'];
    case 'nurturing':
      return ['email.replied'];
    case 'converted':
      return ['proposal.sent'];
    case 'disqualified':
    case 'closed':
      return [];
  }
}

/** 由 Deal 当前阶段推导的可推进事件。 */
function dealCandidates(stage: DealState['stage']): readonly EventType[] {
  switch (stage) {
    case 'qualification':
    case 'discovery':
    case 'proposal':
      return ['deal.stage_changed', 'proposal.sent'];
    case 'negotiation':
      return ['deal.stage_changed'];
    case 'won':
    case 'lost':
      return [];
  }
}

/**
 * 与 Deal 生命周期绑定的事件。
 * Deal 一旦存在，就由「Deal 当前阶段」决定它还能接受哪些事件：
 * 例如 Deal 处于 negotiation 时，`proposal.sent` 已不是合法迁移，
 * 因此不能因为 Lead 状态还停在 qualified 就继续等待它。
 */
const DEAL_BOUND_EVENTS: readonly EventType[] = ['deal.created', 'proposal.sent'];

/**
 * 已经发生过、且同一事实不会再次出现的事件不再进入等待集合，
 * 否则流程会一直等待一个永远不会再来的事件。
 */
function alreadyHappened(
  type: EventType,
  input: { lead: LeadState | null; deal: DealState | null; recent_events: readonly ParsedEvent[] },
): boolean {
  const { lead, deal, recent_events } = input;

  if (type === 'deal.created') {
    return deal !== null;
  }

  if (type === 'lead.assigned') {
    return lead === null || lead.status !== 'new';
  }

  const leadId = lead?.lead_id ?? null;

  switch (type) {
    case 'email.sent':
    case 'email.replied':
    case 'meeting.scheduled':
      return recent_events.some((event) => event.type === type && event.payload.lead_id === leadId);
    case 'proposal.sent':
      return recent_events.some(
        (event) =>
          event.type === 'proposal.sent' &&
          (deal !== null ? event.payload.deal_id === deal.deal_id : event.payload.lead_id === leadId),
      );
    default:
      return false;
  }
}

export function expectedEventsFor(input: ExpectedEventsInput): readonly EventType[] {
  if (isWorkflowTerminal(input.workflow_status)) {
    return [];
  }
  if (input.lead !== null && isLeadTerminal(input.lead.status)) {
    return [];
  }
  if (input.deal !== null && isDealTerminal(input.deal.stage)) {
    return [];
  }

  const candidates: EventType[] = [
    ...(input.deal === null ? [] : dealCandidates(input.deal.stage)),
    ...(input.lead === null ? [] : leadCandidatesFor(input.lead.status, input.deal !== null)),
    'task.overdue',
  ];

  const seen = new Set<EventType>();
  const result: EventType[] = [];

  for (const type of candidates) {
    if (seen.has(type) || alreadyHappened(type, input)) {
      continue;
    }
    seen.add(type);
    result.push(type);
  }

  return result;
}
