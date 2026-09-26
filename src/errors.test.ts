import { describe, expect, it } from 'vitest';

import { BusinessError, classifyError } from './errors';

describe('BusinessError', () => {
  it('默认按「与当前事实冲突」的 409 回传', () => {
    const error = new BusinessError('Workflow 当前不可重试');

    expect(error.status).toBe(409);
    expect(error.name).toBe('BusinessError');
    expect(error).toBeInstanceOf(Error);
  });

  it('资源不存在与参数不合法分别标记为 404 / 400', () => {
    expect(new BusinessError('Workflow 不存在: wf_x', 404).status).toBe(404);
    expect(new BusinessError('action_id is required', 400).status).toBe(400);
  });
});

describe('classifyError', () => {
  it('业务错误原样回传状态与原因，供客户端修正', () => {
    expect(classifyError(new BusinessError('异常已被处理过', 409))).toEqual({
      status: 409,
      message: '异常已被处理过',
    });
    expect(classifyError(new BusinessError('Workflow 不存在: wf_x', 404))).toEqual({
      status: 404,
      message: 'Workflow 不存在: wf_x',
    });
  });

  it('未识别异常按服务端故障处理，只回通用文案不泄露内部细节', () => {
    expect(classifyError(new TypeError('SQLITE_BUSY: database is locked'))).toEqual({
      status: 500,
      message: 'internal error',
    });
    expect(classifyError(new Error('SELECT * FROM entity_states'))).toEqual({
      status: 500,
      message: 'internal error',
    });
  });

  it('非 Error 抛出物（字符串、对象）同样不会原样回传', () => {
    expect(classifyError('boom')).toEqual({ status: 500, message: 'internal error' });
    expect(classifyError(undefined)).toEqual({ status: 500, message: 'internal error' });
  });
});
