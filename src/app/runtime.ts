/**
 * 固定的 Node.js 版本要求，见 `.nvmrc` 与 `docs/deployment.md`。
 * 该版本同时满足：`node:sqlite` 无需额外 flag 即可加载、`--experimental-transform-types`
 * 支持参数属性等需要代码生成的 TypeScript 语法（本项目以此直接运行 TS 入口）。
 */
export const PINNED_NODE_VERSION = '22.22.0';
export const MINIMUM_NODE_VERSION = '22.22.0';

export interface RuntimeCheck {
  readonly ok: boolean;
  readonly version: string;
  readonly minimum: string;
  readonly detail: string | null;
}

/** 语义化版本比较（只比较 major.minor.patch）。 */
export function meetsMinimum(version: string, minimum: string): boolean {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (actual === null || required === null) {
    return false;
  }

  for (let index = 0; index < 3; index += 1) {
    const left = actual[index]!;
    const right = required[index]!;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }
  return true;
}

/** 启动前校验运行时；不满足时返回明确原因，由入口 fail fast。 */
export function checkRuntime(version: string = process.versions.node): RuntimeCheck {
  const ok = meetsMinimum(version, MINIMUM_NODE_VERSION);

  return {
    ok,
    version,
    minimum: MINIMUM_NODE_VERSION,
    detail: ok
      ? null
      : `Node ${version} 低于最低要求 ${MINIMUM_NODE_VERSION}：node:sqlite 与 --experimental-transform-types 需要该版本起可用`,
  };
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
