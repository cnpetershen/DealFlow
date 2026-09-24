import { describe, expect, it } from 'vitest';

import { canonicalStringify, deepFreezeClone } from './shared';

describe('deepFreezeClone', () => {
  it('返回的副本被冻结，修改会抛错', () => {
    const clone = deepFreezeClone({ a: 1 });

    expect(() => {
      (clone as { a: number }).a = 2;
    }).toThrow(TypeError);
  });

  it('嵌套对象同样被冻结', () => {
    const clone = deepFreezeClone({ nested: { a: 1 } });

    expect(() => {
      (clone.nested as { a: number }).a = 2;
    }).toThrow(TypeError);
  });

  it('数组元素同样被冻结', () => {
    const clone = deepFreezeClone([{ a: 1 }]);
    const [first] = clone;

    expect(() => {
      (first as { a: number }).a = 2;
    }).toThrow(TypeError);
  });

  it('修改原始对象不影响副本', () => {
    const original = { a: 1 };
    const clone = deepFreezeClone(original);

    original.a = 2;

    expect(clone.a).toBe(1);
  });
});

describe('canonicalStringify', () => {
  it('键顺序不同但内容相同的对象序列化结果一致', () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it('嵌套对象同样忽略键顺序', () => {
    expect(canonicalStringify({ x: { a: 1, b: 2 } })).toBe(
      canonicalStringify({ x: { b: 2, a: 1 } }),
    );
  });

  it('内容不同的对象序列化结果不同', () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });

  it('数组顺序敏感', () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });

  it('区分 null 与字段缺失', () => {
    expect(canonicalStringify({ a: null })).not.toBe(canonicalStringify({}));
  });
});