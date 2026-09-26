import { describe, expect, it } from 'vitest';

import {
  dealCreatedEvent,
  dealState,
  emailRepliedEvent,
  emailSentEvent,
  leadState,
} from '../testing/fixtures';
import type { ParsedEvent } from '../events/dictionary';
import { expectedEventsFor } from './expected-events';

describe('expectedEventsFor', () => {
  it('未分配的 Lead 等待 lead.assigned', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'new' }),
        deal: null,
        recent_events: [],
      }),
    ).toEqual(['lead.assigned', 'task.overdue']);
  });

  it('已分配但尚未发出邮件时同时等待 email.sent 与 email.replied', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'assigned', owner_id: 'user_7' }),
        deal: null,
        recent_events: [],
      }),
    ).toEqual(['email.sent', 'email.replied', 'task.overdue']);
  });

  it('已经收到 email.sent 后不再等待它，避免永久等待不会再来的事件', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'waiting_result',
        lead: leadState({ status: 'assigned' }),
        deal: null,
        recent_events: [emailSentEvent()] as readonly ParsedEvent[],
      }),
    ).toEqual(['email.replied', 'task.overdue']);
  });

  it('回复后等待会议或第二次回复', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'engaged' }),
        deal: null,
        recent_events: [emailSentEvent(), emailRepliedEvent()] as readonly ParsedEvent[],
      }),
    ).toEqual(['meeting.scheduled', 'task.overdue']);
  });

  it('资格确认后的 Lead 等待 Deal 建立，即使 Deal 尚未出现', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'qualified' }),
        deal: null,
        recent_events: [],
      }),
    ).toEqual(['deal.created', 'proposal.sent', 'task.overdue']);
  });

  it('Deal 已建立后不再等待 deal.created，改为等待阶段变更', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'qualified' }),
        deal: dealState({ stage: 'qualification' }),
        recent_events: [dealCreatedEvent()] as readonly ParsedEvent[],
      }),
    ).toEqual(['deal.stage_changed', 'proposal.sent', 'task.overdue']);
  });

  it('谈判阶段只等待阶段变更与超时', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'converted' }),
        deal: dealState({ stage: 'negotiation' }),
        recent_events: [],
      }),
    ).toEqual(['deal.stage_changed', 'task.overdue']);
  });

  it('主体进入终态后返回空集合，表示流程可以结束', () => {
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'qualified' }),
        deal: dealState({ stage: 'won' }),
        recent_events: [],
      }),
    ).toEqual([]);
    expect(
      expectedEventsFor({
        workflow_status: 'running',
        lead: leadState({ status: 'disqualified' }),
        deal: null,
        recent_events: [],
      }),
    ).toEqual([]);
    expect(
      expectedEventsFor({
        workflow_status: 'completed',
        lead: leadState({ status: 'assigned' }),
        deal: null,
        recent_events: [],
      }),
    ).toEqual([]);
  });

  it('没有 Lead 事实时至少还能等待超时事件', () => {
    expect(
      expectedEventsFor({ workflow_status: 'running', lead: null, deal: null, recent_events: [] }),
    ).toEqual(['task.overdue']);
  });
});
