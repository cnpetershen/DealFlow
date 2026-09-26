import { describe, expect, it } from 'vitest';

import { JsonLogger } from './logger';

function collector(): { lines: string[]; logger: JsonLogger } {
  const lines: string[] = [];
  const logger = new JsonLogger({ sink: (line) => lines.push(line), now: () => '2026-09-24T10:00:00+08:00' });
  return { lines, logger };
}

describe('JsonLogger', () => {
  it('默认不过滤，各级别都会输出', () => {
    const { lines, logger } = collector();

    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');

    expect(lines).toHaveLength(4);
    expect(logger.level).toBeNull();
  });

  it('按 level 过滤低级别日志', () => {
    const { lines, logger } = collectorWithLevel('warn');

    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', message: 'c' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', message: 'd' });
  });

  it('level=null 与缺省等价，都不过滤', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ sink: (line) => lines.push(line), level: null });

    logger.log('debug', 'a');
    logger.log('error', 'b');

    expect(lines).toHaveLength(2);
  });

  it('error 级别只保留 error', () => {
    const { lines, logger } = collectorWithLevel('error');

    logger.log('warn', 'a');
    logger.log('error', 'b');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: 'b' });
  });
});

function collectorWithLevel(level: 'debug' | 'info' | 'warn' | 'error'): { lines: string[]; logger: JsonLogger } {
  const lines: string[] = [];
  const logger = new JsonLogger({ sink: (line) => lines.push(line), now: () => 't', level });
  return { lines, logger };
}
