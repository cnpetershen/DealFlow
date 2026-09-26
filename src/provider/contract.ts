import { proposedAction } from '../testing/fixtures';
import type { ProviderAdapter } from './types';

/**
 * Provider Adapter 契约用例。任何实现（HTTP、SDK 等）与 InMemory 参考实现必须一致。
 * 每个用例独立失败，具体边界的失败分类见 `src/executor/error-classification.test.ts`。
 *
 * 这里**不 import 测试框架**：本文件不是 `.test.ts`，却可能被生产依赖安装
 * （`npm ci --omit=dev` 后没有 vitest）时的 typecheck 编译到。
 * 契约只负责「观测并归一化」，断言由各测试文件用 `expect(...).toMatchObject(expected)` 执行。
 */
export interface ProviderAdapterContractCase {
  /** 用例名，直接用作测试用例标题。 */
  readonly name: string;
  /** 执行一次契约流程，返回可 JSON 比较的观测值（动态标识一律归一化成布尔/空值判断）。 */
  readonly observe: () => Promise<Readonly<Record<string, unknown>>>;
  /** 期望值，纯数据。 */
  readonly expected: Readonly<Record<string, unknown>>;
}

export function providerAdapterContractCases(
  create: () => ProviderAdapter,
): readonly ProviderAdapterContractCase[] {
  return [
    {
      name: '声明 provider 与支持的动作类型',
      observe: async () => {
        const adapter = create();
        return {
          provider_set: typeof adapter.provider === 'string' && adapter.provider.length > 0,
          action_types_non_empty: adapter.action_types.length > 0,
        };
      },
      expected: { provider_set: true, action_types_non_empty: true },
    },
    {
      name: '提交成功返回 accepted 并携带 provider_reference',
      observe: async () => {
        const adapter = create();
        const outcome = await adapter.submit(proposedAction());
        return {
          status: outcome.status,
          receipt_provider_matches:
            outcome.status === 'accepted' && outcome.receipt.provider === adapter.provider,
          has_reference:
            outcome.status === 'accepted' &&
            typeof outcome.receipt.provider_reference === 'string' &&
            outcome.receipt.provider_reference.length > 0,
        };
      },
      expected: { status: 'accepted', receipt_provider_matches: true, has_reference: true },
    },
    {
      name: '同一执行幂等 key 重复提交返回 duplicate，并复用第一次回执',
      observe: async () => {
        const adapter = create();
        const action = proposedAction();
        const first = await adapter.submit(action);
        const second = await adapter.submit(action);
        return {
          first_status: first.status,
          second_status: second.status,
          same_reference:
            first.status === 'accepted' &&
            second.status === 'duplicate' &&
            second.receipt.provider_reference === first.receipt.provider_reference,
        };
      },
      expected: { first_status: 'accepted', second_status: 'duplicate', same_reference: true },
    },
    {
      name: '提交成功后 reconcile 判定 submitted=true 并携带 provider_reference',
      observe: async () => {
        const adapter = create();
        const action = proposedAction();
        await adapter.submit(action);
        const reconciliation = await adapter.reconcile(action);
        return {
          submitted: reconciliation.submitted,
          has_reference:
            typeof reconciliation.provider_reference === 'string' &&
            reconciliation.provider_reference.length > 0,
        };
      },
      expected: { submitted: true, has_reference: true },
    },
    {
      name: '未提交时 reconcile 判定 submitted=false 且回执为空',
      observe: async () => {
        const adapter = create();
        const reconciliation = await adapter.reconcile(proposedAction());
        return {
          submitted: reconciliation.submitted,
          reference: reconciliation.provider_reference,
        };
      },
      expected: { submitted: false, reference: null },
    },
  ];
}
