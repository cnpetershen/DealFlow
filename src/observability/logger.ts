export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * 结构化日志：输出单行 JSON，便于容器/日志系统采集。
 * 接口化以便测试注入 sink，不引入额外日志基础设施。
 */
export interface StructuredLogger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type LogSink = (line: string) => void;

export interface JsonLoggerOptions {
  readonly sink?: LogSink;
  readonly now?: () => string;
  /**
   * 最低输出级别；`null` / 缺省表示不过滤（全部输出）。
   * 对应 `observability.log_level` / `DEALFLOW_LOG_LEVEL`。
   * 把它设为 `warn` / `error` 可关掉每请求一条的 `http.access` 访问日志，
   * 高 QPS 场景下这是访问日志唯一的降噪开关（没有单独的 access_log 开关）。
   */
  readonly level?: LogLevel | null;
}

export class JsonLogger implements StructuredLogger {
  readonly #sink: LogSink;
  readonly #now: () => string;
  readonly #threshold: number | null;

  constructor(options: JsonLoggerOptions = {}) {
    this.#sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#threshold =
      options.level === undefined || options.level === null ? null : LOG_LEVELS.indexOf(options.level);
  }

  get level(): LogLevel | null {
    return this.#threshold === null ? null : LOG_LEVELS[this.#threshold] ?? null;
  }

  log(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (this.#threshold !== null && LOG_LEVELS.indexOf(level) < this.#threshold) {
      return;
    }
    this.#sink(JSON.stringify({ timestamp: this.#now(), level, message, ...fields }));
  }
}
