/** 状态枚举与终态判定，对应 docs/state-machine.md「State 枚举」。 */

export const LEAD_STATUSES = [
  'new',
  'assigned',
  'engaged',
  'qualified',
  'nurturing',
  'disqualified',
  'converted',
  'closed',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const DEAL_STAGES = [
  'qualification',
  'discovery',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const WORKFLOW_STATUSES = [
  'pending',
  'running',
  'waiting_result',
  'needs_review',
  'replanning',
  'completed',
  'cancelled',
  'failed',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * 终态：进入后默认不再自动恢复原 Workflow，对应 docs/state-machine.md「Workflow Resume 规则」第 9 条。
 * `converted` 不算终态，它仍可继续接收结果事件。
 */
export const LEAD_TERMINAL_STATUSES: readonly LeadStatus[] = ['disqualified', 'closed'];

export const DEAL_TERMINAL_STAGES: readonly DealStage[] = ['won', 'lost'];

/** `failed` 不是终态：它等待重试恢复。 */
export const WORKFLOW_TERMINAL_STATUSES: readonly WorkflowStatus[] = ['completed', 'cancelled'];

export function isLeadTerminal(status: LeadStatus): boolean {
  return LEAD_TERMINAL_STATUSES.includes(status);
}

export function isDealTerminal(stage: DealStage): boolean {
  return DEAL_TERMINAL_STAGES.includes(stage);
}

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return WORKFLOW_TERMINAL_STATUSES.includes(status);
}