import type { EventType } from '../events/dictionary';
import { isDealTerminal, isLeadTerminal, isWorkflowTerminal, type WorkflowStatus } from '../state-machine/states';
import { deepFreezeClone } from '../stores/shared';
import type { DecisionContext } from './context';
import type { Decider } from './interfaces';
import { ACTION_METADATA, type ActionType, type ProposedAction, type ProposedActionDraft } from './types';

/**
 * 确定性规则版 Decider，对应 docs/decision-policy.md「Decision 边界」。
 *
 * 设计原则：
 * - 只基于 Context 中已有的事实产出建议，任何不确定的输入都导致「不提出动作」，
 *   而不是猜一个默认值；缺少参数时留给人工或后续事件。
 * - 相同 Context 产出相同建议，便于审计与复现（`action_id` 由注入的生成器决定）。
 * - 已被人工拒绝的动作类型不再重复提出，拒绝原因作为新的规划约束生效。
 */

/** 允许提出动作的 Workflow 状态；等待结果或待审核时不重复规划。 */
const DECIDABLE_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['running', 'replanning'];

type DecisionRule = (context: DecisionContext) => readonly ProposedActionDraft[];

export interface RuleBasedDeciderOptions {
  /**
   * 动作标识生成器。默认按实例内计数递增，
   * 测试与审计可注入固定实现以获得完全可复现的输出。
   */
  readonly createActionId?: () => string;
}

export class RuleBasedDecider implements Decider {
  readonly #createActionId: () => string;
  #counter = 0;

  constructor(options: RuleBasedDeciderOptions = {}) {
    this.#createActionId = options.createActionId ?? (() => `action_${++this.#counter}`);
  }

  decide(context: DecisionContext): readonly ProposedAction[] {
    if (!isDecidable(context)) {
      return [];
    }

    const rejectedActionTypes = new Set(
      context.previous_decisions
        .filter((decision) => decision.status === 'rejected')
        .map((decision) => decision.action_type),
    );

    for (const rule of DECISION_RULES) {
      const drafts = rule(context).filter((draft) => !rejectedActionTypes.has(draft.action_type));

      if (drafts.length > 0) {
        return drafts.map((draft) => this.#materialize(draft));
      }
    }

    return [];
  }

  #materialize(draft: ProposedActionDraft): ProposedAction {
    const actionId = this.#createActionId();

    return deepFreezeClone({
      ...draft,
      action_id: actionId,
      execution_idempotency_key: `exec:${draft.subject_id}:${draft.action_type}:${draft.plan_version}:${actionId}`,
    }) as ProposedAction;
  }
}

function isDecidable(context: DecisionContext): boolean {
  const { workflow_instance: workflow, lead_state: lead, deal_state: deal } = context;

  if (isWorkflowTerminal(workflow.status)) {
    return false;
  }

  if (!DECIDABLE_WORKFLOW_STATUSES.includes(workflow.status)) {
    return false;
  }

  if (lead === null || isLeadTerminal(lead.status)) {
    return false;
  }

  return deal === null || !isDealTerminal(deal.stage);
}

/** 规则按优先级排列，取第一个能产出动作的规则，保证同一 Context 下建议稳定。 */
const DECISION_RULES: readonly DecisionRule[] = [
  overdueRemedyRule,
  firstTouchEmailRule,
  meetingAfterReplyRule,
  proposalRule,
  qualificationAdvanceRule,
];

function actionBase(context: DecisionContext, actionType: ActionType) {
  const { workflow_instance: workflow, policy_context: policy, lead_state: lead, contact_state: contact, deal_state: deal } =
    context;
  const metadata = ACTION_METADATA[actionType];

  return {
    subject_type: workflow.subject_type,
    subject_id: workflow.subject_id,
    workflow_instance_id: workflow.workflow_instance_id,
    lead_id: lead?.lead_id ?? null,
    contact_id: contact?.contact_id ?? null,
    deal_id: deal?.deal_id ?? null,
    risk_level: metadata.risk_level,
    policy_version: policy.policy_version,
    plan_version: workflow.plan_version,
    expires_at: addHours(policy.evaluated_at, metadata.default_ttl_hours),
  };
}

/** 逾期任务：恢复超时分支，提出补救任务而不是继续等待。 */
function overdueRemedyRule(context: DecisionContext): readonly ProposedActionDraft[] {
  const overdueTask = context.pending_tasks.find((task) => task.status === 'overdue');

  if (overdueTask === undefined) {
    return [];
  }

  return [
    {
      ...actionBase(context, 'create_task'),
      action_type: 'create_task',
      parameters: {
        task_type: 'overdue_remedy',
        assigned_to: overdueTask.assigned_to,
        due_at: addHours(context.policy_context.evaluated_at, 24),
        note: `任务 ${overdueTask.task_id} 已逾期，请确认是否仍需要跟进`,
      },
      reason: `任务 ${overdueTask.task_id}（类型 ${overdueTask.task_type}）已于 ${overdueTask.due_at} 逾期，仍属于当前 Workflow`,
      expected_outcome: '负责人重新跟进该任务，或由人工确认任务已失效',
      requires_approval: false,
      parameter_source: 'state',
    },
  ];
}

/** 首次跟进：Lead 已有负责人、联系人可联系且配置了模板时才提出。 */
function firstTouchEmailRule(context: DecisionContext): readonly ProposedActionDraft[] {
  const lead = context.lead_state;
  const contact = context.contact_state;
  const templateId = context.verified_config.first_touch_email_template_id;

  if (lead === null || lead.status !== 'assigned' || lead.owner_id === null) {
    return [];
  }

  if (contact === null || contact.email === null || templateId === null) {
    return [];
  }

  if (hasLeadEvent(context, 'email.sent')) {
    return [];
  }

  return [
    {
      ...actionBase(context, 'send_email'),
      action_type: 'send_email',
      parameters: { template_id: templateId, recipient_email: contact.email, subject: null },
      reason: `Lead ${lead.lead_id} 已分配给 ${lead.owner_id}，尚无首次跟进邮件`,
      expected_outcome: '客户收到首次跟进邮件，Workflow 转入等待回复',
      requires_approval: false,
      parameter_source: 'verified_config',
    },
  ];
}

/** 客户已回复：提出会议动作，具体时段由 Executor 与日历协商。 */
function meetingAfterReplyRule(context: DecisionContext): readonly ProposedActionDraft[] {
  const lead = context.lead_state;
  const contact = context.contact_state;

  if (lead === null || lead.status !== 'engaged' || contact === null) {
    return [];
  }

  if (!hasLeadEvent(context, 'email.replied') || hasLeadEvent(context, 'meeting.scheduled')) {
    return [];
  }

  return [
    {
      ...actionBase(context, 'schedule_meeting'),
      action_type: 'schedule_meeting',
      parameters: {
        agenda: `与 ${contact.full_name ?? '客户'} 确认需求范围与时间安排`,
        duration_minutes: context.verified_config.default_meeting_duration_minutes,
        earliest_start_at: context.policy_context.evaluated_at,
      },
      reason: `Lead ${lead.lead_id} 已收到客户回复，下一步建议安排会议`,
      expected_outcome: '与客户确认会议时间，获得更明确的资格判断',
      requires_approval: true,
      parameter_source: 'state',
    },
  ];
}

/** 方案发送：Deal 处于发现或提案阶段且存在已验证的文档引用时才提出。 */
function proposalRule(context: DecisionContext): readonly ProposedActionDraft[] {
  const deal = context.deal_state;
  const documentReference = context.verified_config.proposal_document_reference;

  if (deal === null || documentReference === null) {
    return [];
  }

  if (deal.stage !== 'discovery' && deal.stage !== 'proposal') {
    return [];
  }

  if (hasDealEvent(context, 'proposal.sent', deal.deal_id)) {
    return [];
  }

  return [
    {
      ...actionBase(context, 'send_proposal'),
      action_type: 'send_proposal',
      parameters: {
        document_reference: documentReference,
        amount: deal.amount,
        currency: deal.currency,
      },
      reason: `Deal ${deal.deal_id} 处于 ${deal.stage} 阶段，尚无已发送的方案`,
      expected_outcome: '客户收到方案并进入反馈或谈判流程',
      requires_approval: true,
      parameter_source: 'verified_config',
    },
  ];
}

/** 阶段推进：只推进状态机允许的相邻阶段，谈判与成交由人工主导。 */
function qualificationAdvanceRule(context: DecisionContext): readonly ProposedActionDraft[] {
  const deal = context.deal_state;

  if (deal === null || deal.stage !== 'qualification') {
    return [];
  }

  return [
    {
      ...actionBase(context, 'advance_deal_stage'),
      action_type: 'advance_deal_stage',
      parameters: { to_stage: 'discovery' },
      reason: `Deal ${deal.deal_id} 仍处于 qualification，资格确认已完成`,
      expected_outcome: 'Deal 进入 discovery，允许发现阶段动作',
      requires_approval: false,
      parameter_source: 'state',
    },
  ];
}

function addHours(isoTimestamp: string, hours: number): string {
  return new Date(Date.parse(isoTimestamp) + hours * 3_600_000).toISOString();
}

/**
 * ParsedEvent 是以 type 为判别键的联合，payload 随 type 收窄，
 * 因此这里按字段是否存在直接读取，无需断言。
 */
function hasLeadEvent(context: DecisionContext, type: EventType): boolean {
  const leadId = context.lead_state?.lead_id;

  return (
    leadId !== undefined &&
    context.recent_events.some((event) => event.type === type && event.payload.lead_id === leadId)
  );
}

function hasDealEvent(context: DecisionContext, type: EventType, dealId: string): boolean {
  return context.recent_events.some(
    (event) => event.type === type && 'deal_id' in event.payload && event.payload.deal_id === dealId,
  );
}