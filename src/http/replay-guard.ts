/**
 * 重放保护：时间戳窗口内，同一签名只接受一次。
 *
 * 纯进程内实现（Map + TTL 清理），不引入 Redis 等外部基础设施。
 * 多实例部署时每个实例各自记录，配合时间戳窗口仍能拒绝明显的重复投递。
 */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(ttlMs: number, now: () => number, maxEntries = 10_000) {
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /** 首次见到该指纹返回 true；在 TTL 内重复出现返回 false。 */
  accept(fingerprint: string): boolean {
    const now = this.#now();
    this.#pruneExpired(now);

    const expiresAt = this.#seen.get(fingerprint);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    this.#seen.set(fingerprint, now + this.#ttlMs);
    // 插入后再收敛，保证 size 永远不超过上限。
    this.#enforceBound();
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }

  #pruneExpired(now: number): void {
    for (const [fingerprint, expiresAt] of this.#seen) {
      if (expiresAt <= now) {
        this.#seen.delete(fingerprint);
      }
    }
  }

  /** 极端流量下兜底：仍超上限时丢弃最旧的记录，保证内存有界。 */
  #enforceBound(): void {
    if (this.#seen.size <= this.#maxEntries) {
      return;
    }

    const excess = this.#seen.size - this.#maxEntries;
    let removed = 0;
    for (const fingerprint of this.#seen.keys()) {
      this.#seen.delete(fingerprint);
      removed += 1;
      if (removed >= excess) {
        break;
      }
    }
  }
}
