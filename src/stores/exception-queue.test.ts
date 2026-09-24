import { beforeEach, describe, expect, it } from 'vitest';

import { exceptionInput } from '../testing/fixtures';
import { InMemoryExceptionQueue } from './in-memory';
import { ExceptionNotFoundError } from './interfaces';

describe('InMemoryExceptionQueue', () => {
  let queue: InMemoryExceptionQueue;

  beforeEach(() => {
    queue = new InMemoryExceptionQueue();
  });

  it('入队后生成 exception_id 且初始状态为 open', () => {
    const record = queue.enqueue(exceptionInput());

    expect(record.exception_id).toBe('exc_1');
    expect(record.status).toBe('open');
    expect(record.resolution).toBeNull();
    expect(queue.get('exc_1')).toEqual(record);
  });

  it('保留原始事件的完整信封副本', () => {
    const record = queue.enqueue(exceptionInput());

    expect(record.event_id).toBe('evt_0002');
    expect(record.event).toEqual(exceptionInput().event);
  });

  it('异常记录不可被修改', () => {
    const record = queue.enqueue(exceptionInput());

    expect(() => {
      (record as { resolution: string | null }).resolution = 'tampered';
    }).toThrow(TypeError);
    expect(queue.get('exc_1')?.resolution).toBeNull();
  });

  it('listOpen 只返回未处理的异常', () => {
    queue.enqueue(exceptionInput({ reason: 'idempotency_conflict' }));
    const second = queue.enqueue(exceptionInput({ reason: 'stale_event' }));
    queue.resolve(second.exception_id, '已按当前事实重建');

    expect(queue.listOpen().map((record) => record.reason)).toEqual(['idempotency_conflict']);
    expect(queue.list()).toHaveLength(2);
  });

  it('resolve 记录人工处理结论', () => {
    const record = queue.enqueue(exceptionInput());
    const resolved = queue.resolve(record.exception_id, '人工确认按新事实处理');

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('人工确认按新事实处理');
    expect(queue.get(record.exception_id)?.status).toBe('resolved');
  });

  it('discard 记录丢弃结论', () => {
    const record = queue.enqueue(exceptionInput());
    const discarded = queue.discard(record.exception_id, '重复投递，无需处理');

    expect(discarded.status).toBe('discarded');
    expect(discarded.resolution).toBe('重复投递，无需处理');
    expect(queue.listOpen()).toHaveLength(0);
  });

  it('处理不存在的异常抛出 ExceptionNotFoundError', () => {
    expect(() => queue.resolve('exc_404', 'x')).toThrow(ExceptionNotFoundError);
    expect(() => queue.discard('exc_404', 'x')).toThrow(ExceptionNotFoundError);
  });

  it('list 返回副本，外部修改不影响队列', () => {
    queue.enqueue(exceptionInput());

    const listed = queue.list() as unknown[];
    listed.length = 0;

    expect(queue.list()).toHaveLength(1);
  });
});