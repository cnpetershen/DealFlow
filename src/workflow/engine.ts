import type { DecisionContext, MemorySummary, PendingTask, PolicyContext, PreviousDecision, VerifiedConfig } from '../decision/context';
import { randomUUID } from 'node:crypto';
import type { Decider } from '../decision/interfaces';
import type { ProposedAction } from '../decision/types';
import type { EventType, ParsedEvent } from '../events/dictionary';
import type { Executor } from '../executor/interfaces';
import { classifyExecutionError, type ErrorClassification } from '../executor/interfaces';
import type { PolicyEvaluator } from '../policy/interfaces';
import type { PolicyOutcome } from '../policy/types';
import { validateDealTransition, validateLeadTransition, validateWorkflowTransition, type WorkflowTrigger } from '../state-machine/transitions';
import { isWorkflowTerminal, type WorkflowStatus } from '../state-machine/states';
import type { AuditLogStore, ContactStateStore, DealStateStore, EventStore, ExceptionQueueStore, LeadStateStore, WorkflowStateStore } from '../stores/interfaces';
import { isClaimableEventStore } from '../stores/interfaces';
import type { ContactState, DealState, ExceptionReason, NewAuditEntry, WorkflowInstanceState } from '../stores/types';
import { workflowBusinessKey } from '../stores/types';
import { deepFreezeClone } from '../stores/shared';

export interface WorkflowEngineOptions {
  readonly event_store: EventStore; readonly audit_log: AuditLogStore; readonly exception_queue: ExceptionQueueStore;
  readonly lead_store: LeadStateStore; readonly contact_store: ContactStateStore; readonly deal_store: DealStateStore;
  readonly workflow_store: WorkflowStateStore; readonly executor: Executor; readonly decider: Decider; readonly policy: PolicyEvaluator;
  readonly workflow_type?: string; readonly now?: () => string; readonly verified_config?: VerifiedConfig;
  readonly policy_context?: (workflow: WorkflowInstanceState, now: string) => PolicyContext;
  readonly memory?: (workflow: WorkflowInstanceState) => MemorySummary;
  readonly pending_tasks?: (workflow: WorkflowInstanceState) => readonly PendingTask[];
  readonly contact_defaults?: (contactId: string) => ContactState;
}
export type HandleEventResult = { status: 'processed'|'duplicate'|'unmatched'|'failed'; workflow: WorkflowInstanceState|null } | { status: 'conflict' };
const RESULT: Partial<Record<ProposedAction['action_type'], readonly EventType[]>> = { send_email:['email.sent'], schedule_meeting:['meeting.scheduled'], create_task:['task.overdue'], send_proposal:['proposal.sent'], advance_deal_stage:['deal.stage_changed'] };
/**
 * 引擎按业务字段（lead_id / deal_id / to_stage…）读取 payload，这些字段跨多个事件类型共享。
 * ParsedEvent 已是以 type 为判别键的联合，但联合上无法直接读取「部分成员才有」的字段，
 * 因此在引擎内部用 Omit 重写 payload 换成一个统一的业务字段视图。
 * `type` 仍取自判别键（EventType），传给状态机校验器时无需断言。
 */
type AnyEvent = Omit<ParsedEvent, 'payload'> & { payload: Record<string, any> };

/** #facts 判定事实不可安全合并时抛出，携带写入异常队列的原因。 */
class FactsRejectedError extends Error {
  constructor(readonly reason: ExceptionReason, message: string) { super(message); this.name = 'FactsRejectedError'; }
}

export class WorkflowEngine {
  readonly #o: WorkflowEngineOptions; readonly #type: string; readonly #now: () => string; readonly #actions = new Map<string, ProposedAction>(); readonly #previousDecisions = new Map<string, PreviousDecision[]>(); readonly #failureClassifications = new Map<string, ErrorClassification>();
  /** 同一 idempotency_key 的在途 handleEvent 合并为一次处理，避免并发重复业务效果。 */
  readonly #inFlight = new Map<string, Promise<HandleEventResult>>();
  constructor(options: WorkflowEngineOptions) { this.#o=options; this.#type=options.workflow_type ?? 'lead_follow_up'; this.#now=options.now ?? (()=>new Date().toISOString()); }
  async handleEvent(input: ParsedEvent): Promise<HandleEventResult> {
    const key = input.idempotency_key;
    const inflight = this.#inFlight.get(key);
    if (inflight) return inflight;
    const run = this.#handleEventOnce(input).finally(() => { this.#inFlight.delete(key); });
    this.#inFlight.set(key, run);
    return run;
  }
  async #handleEventOnce(input: ParsedEvent): Promise<HandleEventResult> {
    const e=input as AnyEvent, stored=this.#o.event_store.append(input);
    if(stored.status==='conflict'){ this.#o.exception_queue.enqueue({occurred_at:this.#now(),reason:'idempotency_conflict',event_id:e.event_id,event:e,subject:null}); return {status:'conflict'}; }
    if(stored.status==='duplicate') return {status:'duplicate',workflow:this.#workflow(e) ?? null};
    return this.#withClaim(e, async () => {
      try { const workflow=await this.#process(e); this.#o.event_store.markProcessed(e.idempotency_key); return workflow?{status:'processed',workflow}:{status:'unmatched',workflow:null}; }
      catch(error){ const workflow=this.#workflow(e); if(workflow?.status==='running') this.#save(this.#transition(workflow,'processing_error',undefined,msg(error))); this.#o.exception_queue.enqueue({occurred_at:this.#now(),reason:error instanceof FactsRejectedError?error.reason:'processing_error',event_id:e.event_id,event:e,subject:workflow?this.#subject(workflow):null}); return {status:'failed',workflow:workflow??null}; }
    });
  }
  /**
   * 跨进程处理租约：同一 idempotency_key 仅一个 worker 处理中；
   * 等待期间若他人完成，则返回 duplicate，避免双写业务效果。
   */
  async #withClaim(e: AnyEvent, run: () => Promise<HandleEventResult>): Promise<HandleEventResult> {
    const store = this.#o.event_store;
    if (!isClaimableEventStore(store)) return run();
    const claimId = randomUUID();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (store.tryClaim(e.idempotency_key, claimId, Date.now(), 30_000)) {
        try {
          return await run();
        } finally {
          store.releaseClaim(e.idempotency_key, claimId);
        }
      }
      const current = store.getByIdempotencyKey(e.idempotency_key);
      if (current?.processing_status === 'processed') {
        return { status: 'duplicate', workflow: this.#workflow(e) ?? null };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`获取事件处理租约超时: ${e.idempotency_key}`);
  }
  /**
   * 崩溃恢复：按 sequence 顺序用 EventStore 中的全部事件重建内存 State / Audit / Exception。
   * 仅应在空 State Store 上调用；已处理事件重新应用事实，pending 事件完整处理并 markProcessed。
   */
  async recoverFromEventLog(): Promise<readonly HandleEventResult[]> {
    const results: HandleEventResult[] = [];
    for (const { event } of this.#o.event_store.list()) {
      results.push(await this.#replay(event));
    }
    return results;
  }
  async #replay(input: ParsedEvent): Promise<HandleEventResult> {
    const e=input as AnyEvent;
    const stored=this.#o.event_store.getByIdempotencyKey(e.idempotency_key);
    // 已 processed 的事件：崩溃恢复仍需重建 State，无需再争用处理租约。
    if(stored?.processing_status==='processed') return this.#runProcess(e);
    return this.#withClaim(e, () => this.#runProcess(e));
  }
  async #runProcess(e:AnyEvent):Promise<HandleEventResult>{
    try { const workflow=await this.#process(e); this.#o.event_store.markProcessed(e.idempotency_key); return workflow?{status:'processed',workflow}:{status:'unmatched',workflow:null}; }
    catch(error){ const workflow=this.#workflow(e); if(workflow?.status==='running') this.#save(this.#transition(workflow,'processing_error',undefined,msg(error))); this.#o.exception_queue.enqueue({occurred_at:this.#now(),reason:error instanceof FactsRejectedError?error.reason:'processing_error',event_id:e.event_id,event:e,subject:workflow?this.#subject(workflow):null}); return {status:'failed',workflow:workflow??null}; }
  }
  async retry(id:string):Promise<WorkflowInstanceState>{
    const inflight = this.#retryInFlight.get(id);
    if (inflight) return inflight;
    const run = this.#retryOnce(id).finally(() => { this.#retryInFlight.delete(id); });
    this.#retryInFlight.set(id, run);
    return run;
  }
  readonly #retryInFlight = new Map<string, Promise<WorkflowInstanceState>>();
  async #retryOnce(id:string):Promise<WorkflowInstanceState>{ const w=this.#require(id); if(w.status!=='failed') throw new Error('Workflow 当前不可重试'); const classification=w.failure_classification ?? this.#failureClassifications.get(id) ?? null; if(classification==='permanent') throw new Error('永久性失败不允许自动重试'); if(w.failure_submitted==='unknown') throw new Error('提交状态未知，需先对账后才能自动重试'); const entry=this.#o.event_store.list().find(x=>x.event.event_id===w.last_processed_event_id); if(!entry) throw new Error('Workflow 没有可重试事件'); const running=this.#save(this.#transition(w,'retry')); const result=await this.#plan(running,entry.event as AnyEvent); this.#o.event_store.markProcessed(entry.event.idempotency_key); return result; }
  approve(id:string,actionId:string,actorId:string){return this.#review(id,actionId,actorId,true,null)}
  reject(id:string,actionId:string,actorId:string,reason:string){return this.#review(id,actionId,actorId,false,reason)}
  cancel(id:string,actorId='system'){const next=this.#save(this.#transition(this.#require(id),'cancel_requested')); this.#audit(null,next,'state_transitioned',null,`cancelled by ${actorId}`,'succeeded'); return next;}
  async #process(e:AnyEvent):Promise<WorkflowInstanceState|null>{ if(e.type==='lead.created') return this.#create(e); const w=this.#workflow(e); if(!w){this.#unmatched(e);return null;} if(isWorkflowTerminal(w.status)||(w.status==='waiting_result'&&!this.#matches(w,e))){this.#unmatched(e,w);return null;} this.#facts(e); let current:WorkflowInstanceState={...w,last_processed_event_id:e.event_id,updated_at:this.#now()}; if(current.status==='failed') current=this.#transition(current,'retry'); else if(w.status==='waiting_result') current=this.#transition(current,'result_event_matched'); current=this.#save(current); this.#audit(e,current,'event_processed',null,null,'succeeded'); return this.#plan(current,e); }
  #create(e:AnyEvent){const p=e.payload; if(!this.#o.lead_store.get(p.lead_id)){this.#o.lead_store.save({lead_id:p.lead_id,source_channel:p.source_channel,source_record_id:p.source_record_id,company_name:p.company_name,contact_id:p.contact_id,owner_id:p.initial_owner_id,status:'new',created_at:e.occurred_at,updated_at:e.occurred_at}); if(p.contact_id&&this.#o.contact_defaults)this.#o.contact_store.save(this.#o.contact_defaults(p.contact_id));} const key=workflowBusinessKey({workflow_type:this.#type,subject_type:'lead',subject_id:p.lead_id}), old=this.#o.workflow_store.findByBusinessKey(key); if(old)return old; const pending:WorkflowInstanceState={workflow_instance_id:`wf_${this.#type}_${p.lead_id}`,workflow_type:this.#type,subject_type:'lead',subject_id:p.lead_id,status:'pending',current_step:'assignment',awaiting_event_types:[],plan_version:1,last_processed_event_id:e.event_id,failure_classification:null,failure_submitted:null,failure_retry_after:null,created_at:e.occurred_at,updated_at:this.#now()}; return this.#save(this.#transition(pending,'started'));}
  #facts(e:AnyEvent){const p=e.payload;if(['lead.assigned','email.sent','email.replied','meeting.scheduled','task.overdue'].includes(e.type)){const lead=this.#o.lead_store.get(p.lead_id);if(!lead)throw new Error('Lead 不存在');const t=validateLeadTransition(lead.status,e.type);if(!t.allowed)throw new FactsRejectedError('invalid_transition',t.detail);this.#o.lead_store.save({...lead,owner_id:e.type==='lead.assigned'?p.owner_id:lead.owner_id,status:t.to[0]!,updated_at:e.occurred_at});return;} if(e.type==='deal.created'){if(this.#o.deal_store.get(p.deal_id))return;const t=validateDealTransition(null,e.type,p.initial_stage);if(!t.allowed)throw new FactsRejectedError('invalid_transition',t.detail);this.#o.deal_store.save({deal_id:p.deal_id,lead_id:p.lead_id,contact_id:p.contact_id,owner_id:p.owner_id,stage:p.initial_stage,amount:p.amount,currency:p.currency,expected_close_at:p.expected_close_at,outcome:null,created_at:e.occurred_at,updated_at:e.occurred_at});return;} const deal=this.#o.deal_store.get(p.deal_id);if(!deal)throw new Error('Deal 不存在');const to=e.type==='proposal.sent'?'proposal':p.to_stage;if(e.type==='deal.stage_changed'&&deal.stage!==p.from_stage)throw new FactsRejectedError('stale_event','Deal 当前阶段与事件冲突');const t=validateDealTransition(deal.stage,e.type,to);if(!t.allowed)throw new FactsRejectedError('invalid_transition',t.detail);this.#o.deal_store.save({...deal,stage:to,outcome:to==='won'||to==='lost'?(p.reason??deal.outcome):deal.outcome,updated_at:e.occurred_at});}
  async #plan(w:WorkflowInstanceState,e:AnyEvent|null):Promise<WorkflowInstanceState>{const base=w.status==='running'||w.status==='replanning'?w:this.#transition(w,'result_event_matched');const current=this.#save({...base,plan_version:base.plan_version+1,updated_at:this.#now()}),ctx=this.#context(current,e?.occurred_at??this.#now()),actions=this.#o.decider.decide(ctx);if(!actions.length){if(e?.type==='email.sent')return this.#save({...current,status:'waiting_result',current_step:'await_reply',awaiting_event_types:['email.replied','task.overdue']});return this.#save(this.#transition(current,'workflow_finished'));}let result=current;for(const action of actions){this.#actions.set(action.action_id,deepFreezeClone(action));this.#audit(e,result,'decision_proposed',action,action.reason,'pending');const outcome=this.#o.policy.evaluate(action,ctx);this.#audit(e,result,outcome.decision==='reject'?'policy_rejected':'policy_evaluated',action,reason(outcome),outcome.decision==='auto'?'succeeded':outcome.decision==='reject'?'failed':'pending');if(outcome.decision==='reject')continue;if(outcome.decision==='human_review'){result=this.#save(result.status==='replanning'?this.#transition(result,'replan_completed','needs_review'):this.#transition(result,'approval_required'));continue;}try{if(result.status==='replanning')result=this.#transition(result,'replan_completed','running');await this.#o.executor.execute(action);this.#failureClassifications.delete(result.workflow_instance_id);result=this.#save({...this.#transition(result,'action_dispatched'),current_step:action.action_type,awaiting_event_types:RESULT[action.action_type]??[],failure_classification:null,failure_submitted:null,failure_retry_after:null});this.#audit(e,result,'action_dispatched',action,null,'succeeded');}catch(error){const classified=classifyExecutionError(error);this.#failureClassifications.set(result.workflow_instance_id,classified.classification);this.#audit(e,result,'action_failed',action,`${classified.classification}: ${classified.message}`,'failed');result=this.#save({...this.#transition(result,'processing_error',undefined,msg(error)),failure_classification:classified.classification,failure_submitted:classified.submitted,failure_retry_after:classified.retry_after});}}return result;}
  async #review(id:string,actionId:string,actor:string,approved:boolean,why:string|null):Promise<WorkflowInstanceState>{const w=this.#require(id),action=this.#actions.get(actionId);if(!action||action.workflow_instance_id!==id||w.status!=='needs_review')throw new Error('审核动作不可用');this.#audit(null,w,approved?'action_approved':'action_rejected',action,why??actor,approved?'succeeded':'skipped');const next=this.#save({...this.#transition(w,approved?'approval_granted':'approval_rejected'),plan_version:w.plan_version+1});if(!approved){this.#recordRejection(id,action,actor,why);return this.#plan(next,null);}const running=this.#transition(next,'replan_completed','running');await this.#o.executor.execute(action);return this.#save({...this.#transition(running,'action_dispatched'),current_step:action.action_type,awaiting_event_types:RESULT[action.action_type]??[]});}
  /**
   * 判定时刻 `evaluated_at` 来自触发事件的事实时间 `occurred_at`，而不是服务器本地时钟：
   * 事件驱动路径必须可复现，同一事件在任何时刻处理都得到同一结论。
   * 只有控制面操作（approve/reject/cancel 等没有事件的操作）才回退到注入时钟。
   */
  #context(w:WorkflowInstanceState,evaluatedAt:string):DecisionContext{const lead=this.#o.lead_store.get(w.subject_id)??null,defaults:VerifiedConfig={first_touch_email_template_id:'tpl_first_touch',proposal_document_reference:null,default_meeting_duration_minutes:30},policy=this.#o.policy_context?.(w,evaluatedAt)??({policy_version:'policy_v1',evaluated_at:evaluatedAt,automation_whitelist:['send_email','create_task'],permitted_action_types:['send_email','schedule_meeting','create_task','send_proposal','advance_deal_stage'],permitted_actor_ids:lead?.owner_id?[lead.owner_id]:[],business_timezone_offset_minutes:480,send_window:{start_hour:9,end_hour:18},max_auto_actions_per_day:100,auto_actions_today:0,key_account_lead_ids:[],high_value_deal_threshold:500000} satisfies PolicyContext);return {workflow_instance:w,lead_state:lead,contact_state:lead?.contact_id?this.#o.contact_store.get(lead.contact_id)??null:null,deal_state:this.#o.deal_store.list().find(x=>x.lead_id===w.subject_id)??null,verified_config:this.#o.verified_config??defaults,recent_events:this.#o.event_store.list().map(x=>x.event),memory:this.#o.memory?.(w)??{interaction_count:0,last_interaction_at:null,preferences:[]},pending_tasks:this.#o.pending_tasks?.(w)??[],policy_context:policy,previous_decisions:this.#previousDecisions.get(w.workflow_instance_id)??[],idempotency_context:{input_event_id:w.last_processed_event_id??'',processed_idempotency_keys:[]},data_conflicts:[]};}
  #workflow(e:AnyEvent){const id=typeof e.payload.lead_id==='string'?e.payload.lead_id:null;return id?this.#o.workflow_store.findByBusinessKey(workflowBusinessKey({workflow_type:this.#type,subject_type:'lead',subject_id:id})):undefined;}
  /** 结果事件必须匹配等待条件、实例与主体；payload 缺失 lead_id 时以 workflow_instance_id 绑定主体。 */
  #matches(w:WorkflowInstanceState,e:AnyEvent){if(!w.awaiting_event_types.includes(e.type))return false;const instanceId=e.payload.workflow_instance_id;if(instanceId&&instanceId!==w.workflow_instance_id)return false;const leadId=e.payload.lead_id;return leadId!=null?leadId===w.subject_id:Boolean(instanceId);}
  /** 人工拒绝后登记被拒动作类型，使其成为新的规划约束，不再被重新提出。 */
  #recordRejection(id:string,action:ProposedAction,actor:string,why:string|null){const list=this.#previousDecisions.get(id)??[];list.push({action_id:action.action_id,action_type:action.action_type,status:'rejected',plan_version:action.plan_version,decided_by:actor,reason:why,decided_at:this.#now()});this.#previousDecisions.set(id,list);}
  #require(id:string){const w=this.#o.workflow_store.get(id);if(!w)throw new Error('Workflow 不存在');return w;}
  #save<T extends WorkflowInstanceState>(s:T){return this.#o.workflow_store.save(deepFreezeClone(s)) as T;}
  #transition(w:WorkflowInstanceState,tr:WorkflowTrigger,target?:WorkflowStatus,why?:string){const r=validateWorkflowTransition(w.status,tr);if(!r.allowed)throw new FactsRejectedError('invalid_transition',why??r.detail);const status=target??r.to[0]!;if(!r.to.includes(status))throw new Error('非法 Workflow 状态');return {...w,status,updated_at:this.#now(),awaiting_event_types:status==='waiting_result'?w.awaiting_event_types:[]};}
  #unmatched(e:AnyEvent,w?:WorkflowInstanceState){this.#o.exception_queue.enqueue({occurred_at:this.#now(),reason:'unmatched_event',event_id:e.event_id,event:e,subject:w?this.#subject(w):null});}
  #subject(w:WorkflowInstanceState){return {subject_type:w.subject_type,subject_id:w.subject_id,workflow_instance_id:w.workflow_instance_id};}
  #audit(e:AnyEvent|null,w:WorkflowInstanceState|null,action:NewAuditEntry['action'],a:ProposedAction|null,why:string|null,result:NewAuditEntry['result']){this.#o.audit_log.append({occurred_at:this.#now(),actor:{actor_type:'system',actor_id:'workflow_engine'},action,subject:w?this.#subject(w):{subject_type:'event',subject_id:e?.event_id??'unknown',workflow_instance_id:null},event_id:e?.event_id??null,action_id:a?.action_id??null,before_state:null,after_state:w?.status??null,reason:why,policy_version:a?.policy_version??null,plan_version:a?.plan_version??w?.plan_version??null,source:e?.source??'workflow_engine',result,provider_reference:typeof e?.payload.provider_reference==='string'?e.payload.provider_reference:null});}
}
function reason(o:PolicyOutcome){return o.decision==='auto'?o.satisfied_conditions.join(','):o.reasons.map(x=>`${x.code}: ${x.detail}`).join('; ')}
function msg(e:unknown){return e instanceof Error?e.message:String(e)}
