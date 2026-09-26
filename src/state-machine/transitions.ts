import { type EventType } from '../events/dictionary';
import {
  isDealTerminal,
  isLeadTerminal,
  isWorkflowTerminal,
  type DealStage,
  type LeadStatus,
  type WorkflowStatus,
} from './states';

/**
 * 状态迁移校验器，把 docs/state-machine.md「状态迁移表」变成可执行规则。
 *
 * 校验顺序：
 * 1. 终态保护：来源状态已是终态时，任何迁移都被拒绝（Resume 规则第 9 条）。
 * 2. 触发器匹配：没有 (from, trigger) 匹配行时拒绝，不得强行推进流程（Resume 规则第 3 条）。
 * 3. 目标校验：请求的目标状态必须落在该行声明的目标集合内。
 *
 * Lead/Deal 的触发器是事件类型；Workflow 的触发器是控制面操作，不一定是 Event。
 */

/** 表示「任意非终态来源」。 */
export const ANY_NON_TERMINAL = '*';

/** 表示「保持当前状态」。 */
export const KEEP_CURRENT = 'unchanged';

export type TransitionRejectionCode =
  | 'terminal_state'
  | 'unsupported_trigger'
  | 'illegal_transition';

export interface TransitionAllowed<TState> {
  readonly allowed: true;
  readonly from: TState | null;
  /** 允许的迁移目标。来源状态唯一确定目标时为单元素；否则调用方需按业务条件选择。 */
  readonly to: readonly TState[];
  /** 迁移条件，取自 docs/state-machine.md 的「条件」列，用于审计与排障。 */
  readonly condition: string;
  /** 迁移后应执行的 Workflow 动作，取自文档的「Workflow 动作」列。 */
  readonly workflow_action: string;
}

export interface TransitionRejected<TState> {
  readonly allowed: false;
  readonly from: TState | null;
  readonly code: TransitionRejectionCode;
  readonly detail: string;
}

export type TransitionResult<TState> = TransitionAllowed<TState> | TransitionRejected<TState>;

export interface TransitionRow<TState, TTrigger extends string> {
  readonly from: TState | typeof ANY_NON_TERMINAL | null;
  readonly trigger: TTrigger;
  readonly to: readonly TState[] | typeof KEEP_CURRENT;
  readonly condition: string;
  readonly workflow_action: string;
}

/** Lead 迁移表，对应 docs/state-machine.md 中 Lead 的行。触发器为事件类型。 */
export const LEAD_TRANSITIONS: readonly TransitionRow<LeadStatus, EventType>[] = [
  {
    from: 'new',
    trigger: 'lead.created',
    to: ['new'],
    condition: '事件首次处理成功',
    workflow_action: '创建或幂等获取 WorkflowInstance，进入分配决策',
  },
  {
    from: 'new',
    trigger: 'lead.assigned',
    to: ['assigned'],
    condition: 'owner_id 有效',
    workflow_action: '从分配节点恢复，计算首次跟进动作',
  },
  {
    from: 'assigned',
    trigger: 'lead.assigned',
    to: ['assigned'],
    condition: '同一分配事实重放（至少一次投递），幂等合并',
    workflow_action: '不重复推进流程，允许处理中断后的恢复',
  },
  {
    from: 'assigned',
    trigger: 'email.sent',
    to: ['assigned'],
    condition: '邮件发出且关联当前 Lead',
    workflow_action: '等待回复或超时结果',
  },
  {
    from: 'assigned',
    trigger: 'email.replied',
    to: ['engaged'],
    condition: '回复可匹配联系人或线程',
    workflow_action: '进入互动结果处理，可能提出会议动作',
  },
  {
    from: 'engaged',
    trigger: 'meeting.scheduled',
    to: ['qualified', 'engaged'],
    condition: '会议属于当前 Lead/Contact',
    workflow_action: '等待会议结果或后续销售动作',
  },
  {
    from: 'qualified',
    trigger: 'deal.created',
    to: ['converted'],
    condition: '由当前 Lead 转化且尚无有效 Deal',
    workflow_action: '创建 Deal 当前事实并关联 Workflow，进入提案准备',
  },
  {
    from: 'qualified',
    trigger: 'proposal.sent',
    to: ['converted'],
    condition: '已关联有效 Deal',
    workflow_action: '将 Deal 推进到 proposal，等待客户反馈',
  },
  {
    from: ANY_NON_TERMINAL,
    trigger: 'task.overdue',
    to: KEEP_CURRENT,
    condition: '任务仍属于当前 Workflow',
    workflow_action: '恢复超时分支，提出补救或人工审核',
  },
];

/**
 * Deal 迁移表，对应 docs/state-machine.md 中 Deal 的行。
 * `from: null` 表示 Deal 尚不存在；Deal 只能通过 `deal.created` 进入系统。
 */
export const DEAL_TRANSITIONS: readonly TransitionRow<DealStage, EventType>[] = [
  {
    from: null,
    trigger: 'deal.created',
    to: ['qualification'],
    condition: 'lead_id 有效且 initial_stage = qualification',
    workflow_action: '建立 Deal 当前事实，等待资格确认类动作',
  },
  {
    from: 'qualification',
    trigger: 'deal.stage_changed',
    to: ['discovery'],
    condition: 'to_stage = discovery',
    workflow_action: '重新规划发现阶段动作',
  },
  {
    from: 'discovery',
    trigger: 'deal.stage_changed',
    to: ['proposal'],
    condition: 'to_stage = proposal',
    workflow_action: '允许提案相关动作',
  },
  {
    from: 'proposal',
    trigger: 'deal.stage_changed',
    to: ['negotiation'],
    condition: 'to_stage = negotiation',
    workflow_action: '进入商务谈判，允许报价与条款类动作',
  },
  {
    from: 'discovery',
    trigger: 'proposal.sent',
    to: ['proposal'],
    condition: '提案已发送且 Deal 未进入终态',
    workflow_action: '推进到提案阶段并等待客户反馈',
  },
  {
    from: 'proposal',
    trigger: 'proposal.sent',
    to: ['proposal'],
    condition: '提案已发送',
    workflow_action: '等待回复、会议或阶段变更',
  },
  {
    from: ANY_NON_TERMINAL,
    trigger: 'deal.stage_changed',
    to: ['won'],
    condition: 'to_stage = won',
    workflow_action: '完成销售 Workflow，写入审计记录',
  },
  {
    from: ANY_NON_TERMINAL,
    trigger: 'deal.stage_changed',
    to: ['lost'],
    condition: 'to_stage = lost',
    workflow_action: '终止自动动作，保留丢单原因',
  },
];

/**
 * Workflow 触发器。与 Lead/Deal 不同，它既可以是外部事件（`result_event_matched`），
 * 也可以是控制面操作（人工批准/拒绝、取消等）。控制面操作不是 Event。
 */
export const WORKFLOW_TRIGGERS = [
  'started',
  'action_dispatched',
  'awaiting_events',
  'approval_required',
  'result_event_matched',
  'approval_granted',
  'approval_rejected',
  'stale_action',
  'replan_completed',
  'processing_error',
  'retry',
  'workflow_finished',
  'cancel_requested',
] as const;

export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

/** Workflow 迁移表，对应 docs/state-machine.md 中 Workflow 的行。 */
export const WORKFLOW_TRANSITIONS: readonly TransitionRow<WorkflowStatus, WorkflowTrigger>[] = [
  {
    from: 'pending',
    trigger: 'started',
    to: ['running'],
    condition: '依赖数据就绪',
    workflow_action: '进入首个可执行步骤',
  },
  {
    from: 'running',
    trigger: 'action_dispatched',
    to: ['waiting_result'],
    condition: '动作已交给 Executor 且需等待外部结果',
    workflow_action: '记录等待条件与执行幂等 key',
  },
  {
    from: 'running',
    trigger: 'awaiting_events',
    to: ['waiting_result'],
    condition: '当前无可执行动作，但主体仍可被后续事件推进',
    workflow_action: '按当前 State 推导等待事件集合并休眠，而不是结束流程',
  },
  {
    from: 'running',
    trigger: 'approval_required',
    to: ['needs_review'],
    condition: 'Policy 判定为 Human Review',
    workflow_action: '生成待审核 ProposedAction，不直接执行',
  },
  {
    from: 'running',
    trigger: 'processing_error',
    to: ['failed'],
    condition: '可重试错误',
    workflow_action: '保留失败原因，按重试策略恢复',
  },
  {
    from: 'running',
    trigger: 'workflow_finished',
    to: ['completed'],
    condition: '无后续步骤且无待办',
    workflow_action: '结束自动动作，写入审计记录',
  },
  {
    from: 'waiting_result',
    trigger: 'result_event_matched',
    to: ['replanning'],
    condition: '事件满足等待条件',
    workflow_action: '消费结果事件，计算下一节点',
  },
  {
    from: 'needs_review',
    trigger: 'approval_granted',
    to: ['replanning'],
    condition: 'ProposedAction 被批准',
    workflow_action: '按批准结果重新规划，不直接复用旧计划',
  },
  {
    from: 'needs_review',
    trigger: 'approval_rejected',
    to: ['replanning'],
    condition: 'ProposedAction 被拒绝',
    workflow_action: '记录拒绝原因，基于新约束重新规划',
  },
  {
    from: 'needs_review',
    trigger: 'stale_action',
    to: ['replanning'],
    condition: '待审动作已被新事实取代、已过期，或人工要求重新规划',
    workflow_action: '作废待审动作（不写拒绝结论），基于当前 State 重新规划',
  },
  {
    from: 'replanning',
    trigger: 'replan_completed',
    to: ['running', 'waiting_result', 'needs_review'],
    condition: '已生成新的 plan_version，或确认无安全替代动作',
    workflow_action: '进入新计划的首个可执行步骤，或转为等待、人工审核',
  },
  {
    from: 'replanning',
    trigger: 'workflow_finished',
    to: ['completed'],
    condition: '无后续步骤且无待办',
    workflow_action: '结束自动动作，写入审计记录',
  },
  {
    from: 'failed',
    trigger: 'retry',
    to: ['running'],
    condition: '重试策略允许',
    workflow_action: '复用同一 idempotency_key 重试',
  },
  {
    from: ANY_NON_TERMINAL,
    trigger: 'cancel_requested',
    to: ['cancelled'],
    condition: '明确取消',
    workflow_action: '不再自动执行未批准动作',
  },
];

function matchesFrom<TState>(
  row: TransitionRow<TState, string>,
  from: TState | null,
  isTerminal: (state: TState) => boolean,
): boolean {
  if (row.from === ANY_NON_TERMINAL) {
    return from !== null && !isTerminal(from);
  }

  return row.from === from;
}

function resolveTargets<TState>(
  row: TransitionRow<TState, string>,
  from: TState | null,
): readonly TState[] {
  if (row.to !== KEEP_CURRENT) {
    return row.to;
  }

  return from === null ? [] : [from];
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

interface TransitionInput<TState> {
  readonly from: TState | null;
  readonly trigger: string;
  /** 明确请求的目标状态；为 null 时表示由迁移表决定目标。 */
  readonly requestedTo: TState | null;
  readonly rows: readonly TransitionRow<TState, string>[];
  readonly isTerminal: (state: TState) => boolean;
  readonly subject: string;
}

function resolveTransition<TState>(input: TransitionInput<TState>): TransitionResult<TState> {
  const { from, trigger, requestedTo, rows, isTerminal, subject } = input;
  const fromLabel = from ?? '(不存在)';

  if (from !== null && isTerminal(from)) {
    return {
      allowed: false,
      from,
      code: 'terminal_state',
      detail: `${subject} ${fromLabel} 已是终态，按终态保护规则拒绝触发器 ${trigger}。`,
    };
  }

  const candidates = rows.filter(
    (row) => row.trigger === trigger && matchesFrom(row, from, isTerminal),
  );

  if (candidates.length === 0) {
    return {
      allowed: false,
      from,
      code: 'unsupported_trigger',
      detail: `${subject} ${fromLabel} 不接受触发器 ${trigger}，事件不得强行推进流程。`,
    };
  }

  const allowedTargets = unique(candidates.flatMap((row) => resolveTargets(row, from)));

  const matched =
    requestedTo === null
      ? candidates[0]
      : candidates.find((row) => resolveTargets(row, from).includes(requestedTo));

  if (matched === undefined) {
    return {
      allowed: false,
      from,
      code: 'illegal_transition',
      detail: `${subject} ${fromLabel} 在触发器 ${trigger} 下不允许迁移到 ${requestedTo}，允许的目标为 ${allowedTargets.join(' / ')}。`,
    };
  }

  return {
    allowed: true,
    from,
    to: requestedTo === null ? allowedTargets : [requestedTo],
    condition: matched.condition,
    workflow_action: matched.workflow_action,
  };
}

export function validateLeadTransition(
  from: LeadStatus,
  eventType: EventType,
): TransitionResult<LeadStatus> {
  return resolveTransition({
    from,
    trigger: eventType,
    requestedTo: null,
    rows: LEAD_TRANSITIONS,
    isTerminal: isLeadTerminal,
    subject: 'Lead',
  });
}

export function validateDealTransition(
  from: DealStage | null,
  eventType: EventType,
  toStage: DealStage,
): TransitionResult<DealStage> {
  return resolveTransition({
    from,
    trigger: eventType,
    requestedTo: toStage,
    rows: DEAL_TRANSITIONS,
    isTerminal: isDealTerminal,
    subject: 'Deal',
  });
}

export function validateWorkflowTransition(
  from: WorkflowStatus,
  trigger: WorkflowTrigger,
): TransitionResult<WorkflowStatus> {
  return resolveTransition({
    from,
    trigger,
    requestedTo: null,
    rows: WORKFLOW_TRANSITIONS,
    isTerminal: isWorkflowTerminal,
    subject: 'Workflow',
  });
}
