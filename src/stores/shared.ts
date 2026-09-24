/**
 * 深度冻结的深拷贝。
 *
 * Event 与 Audit Log 都要求不可变，Store 保存的是快照而非调用方的对象：
 * 传入对象先克隆再逐层冻结，之后调用方修改自己的对象、或修改读取到的返回值，
 * 都不会影响 Store 中已保存的事实。
 */
export function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const target = value as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }

  Object.freeze(value);

  return value;
}

/**
 * 稳定的 JSON 序列化：对象键按字典序排列。
 *
 * 幂等冲突检测依赖它判断两个 payload 是否描述同一事实，
 * 避免仅因键顺序不同而把同一事实误判为冲突。
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`)
    .join(',')}}`;
}