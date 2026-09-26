export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** 被限流时建议的等待秒数；未被限流为 0。 */
  readonly retry_after_seconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit_per_window: number;
  readonly window_ms: number;
  readonly now?: () => number;
  /** 记录上限，超过后按窗口清理，保证内存有界。 */
  readonly max_keys?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

/**
 * 基础限流：固定窗口计数，纯进程内实现，不引入 Redis 等外部基础设施。
 *
 * 固定窗口实现简单且内存有界；代价是窗口边界附近可能短暂放行约两倍流量。
 * 对本场景（保护 webhook 入口）足够，且不引入额外依赖。
 */
export class FixedWindowRateLimiter implements RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Window>();

  constructor(options: FixedWindowRateLimiterOptions) {
    this.#limit = options.limit_per_window;
    this.#windowMs = options.window_ms;
    this.#now = options.now ?? (() => Date.now());
    this.#maxKeys = Math.max(1, options.max_keys ?? 10_000);
  }

  get size(): number {
    return this.#buckets.size;
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
    const current = this.#buckets.get(key);

    if (current === undefined || current.windowStart !== windowStart) {
      // 先清理再插入，保证插入后仍然不超过 max_keys。
      this.#prune(windowStart);
      this.#buckets.set(key, { windowStart, count: 1 });
      return { allowed: true, limit: this.#limit, remaining: this.#limit - 1, retry_after_seconds: 0 };
    }

    if (current.count >= this.#limit) {
      return {
        allowed: false,
        limit: this.#limit,
        remaining: 0,
        retry_after_seconds: Math.max(1, Math.ceil((windowStart + this.#windowMs - now) / 1_000)),
      };
    }

    current.count += 1;
    return {
      allowed: true,
      limit: this.#limit,
      remaining: this.#limit - current.count,
      retry_after_seconds: 0,
    };
  }

  /**
   * 两级清理，确保内存**严格**有界：
   * 1. 先删掉上一个窗口的过期条目（正常情况下这一级就够了）；
   * 2. 仍在上限之上时按插入顺序淘汰——只靠第 1 级挡不住「同一窗口内不断换 key」的攻击者，
   *    那会让每个新来源都留下一条永不淘汰的记录，Map 随来源数无限增长。
   *
   * 第 2 级的代价是被淘汰的 key 会重新拿到完整配额；在「内存被撑爆」和「偶尔多放行一次」
   * 之间，必须选后者。
   */
  #prune(currentWindowStart: number): void {
    for (const [key, window] of this.#buckets) {
      if (window.windowStart < currentWindowStart) {
        this.#buckets.delete(key);
      }
    }

    while (this.#buckets.size >= this.#maxKeys && this.#buckets.size > 0) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#buckets.delete(oldest.value);
    }
  }
}
