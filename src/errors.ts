/**
 * 业务层错误与 HTTP 状态映射。
 *
 * HTTP 层必须能区分两类失败：
 * - **业务拒绝**（状态不允许、参数不合法、资源不存在）→ 回 4xx + 原始原因，客户端据此修正；
 * - **服务端故障**（SQLite busy、TypeError、连接中断）→ 回 500 + 通用文案，细节只进日志。
 *
 * 没有这个标记时，控制面会把一切异常都报成 409：真实故障被伪装成「业务冲突」，
 * 客户端拿到的是 `database is locked` 这类内部文本，既掩盖了故障，也泄露了实现细节。
 */
export class BusinessError extends Error {
  /**
   * @param status 可回传给客户端的 HTTP 状态。默认 409（与当前事实冲突），
   *               资源不存在的子类用 404，请求体不合法用 400。
   */
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** 分类结果：4xx 直接回传 `message`，500 只回通用文案。 */
export interface ClassifiedError {
  readonly status: number;
  readonly message: string;
}

/**
 * 把异常映射成可回传给客户端的状态与文案。
 *
 * 未识别的异常一律按服务端故障处理：宁可把一个漏标业务错误报成 500（下次修正），
 * 也不能把 `TypeError` / 数据库错误当 409 回出去。
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof BusinessError) {
    return { status: error.status, message: error.message };
  }

  return { status: 500, message: 'internal error' };
}
