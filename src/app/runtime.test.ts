import { describe, expect, it } from 'vitest';

import { checkRuntime, meetsMinimum, MINIMUM_NODE_VERSION, PINNED_NODE_VERSION } from './runtime';

describe('meetsMinimum', () => {
  it('相同版本视为满足', () => {
    expect(meetsMinimum('22.22.0', '22.22.0')).toBe(true);
  });

  it('更高版本满足', () => {
    expect(meetsMinimum('22.22.1', '22.22.0')).toBe(true);
    expect(meetsMinimum('22.23.0', '22.22.0')).toBe(true);
    expect(meetsMinimum('23.0.0', '22.22.0')).toBe(true);
    expect(meetsMinimum('v22.22.0', '22.22.0')).toBe(true);
  });

  it('更低版本不满足', () => {
    expect(meetsMinimum('22.21.9', '22.22.0')).toBe(false);
    expect(meetsMinimum('22.7.0', '22.22.0')).toBe(false);
    expect(meetsMinimum('20.11.0', '22.22.0')).toBe(false);
  });

  it('无法解析的版本不满足', () => {
    expect(meetsMinimum('not-a-version', '22.22.0')).toBe(false);
  });
});

describe('checkRuntime', () => {
  it('当前运行环境满足固定版本要求', () => {
    const check = checkRuntime();

    expect(check.ok).toBe(true);
    expect(check.detail).toBeNull();
    expect(meetsMinimum(check.version, PINNED_NODE_VERSION)).toBe(true);
  });

  it('版本过低时给出明确原因', () => {
    const check = checkRuntime('20.11.0');

    expect(check.ok).toBe(false);
    expect(check.minimum).toBe(MINIMUM_NODE_VERSION);
    expect(check.detail).toContain('20.11.0');
    expect(check.detail).toContain(MINIMUM_NODE_VERSION);
  });
});
