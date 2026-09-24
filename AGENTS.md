# 项目规则

- 技术栈：TypeScript + Zod + Vitest（如果使用 Python 就改成 Pydantic + pytest）
- Event 不可变，必须有 event\_id, type, version, occurred\_at, idempotency\_key, payload
- State 只存当前事实
- Memory 存历史互动、摘要、偏好
- Audit Log 只追加，不可修改
- Decision 只输出 ProposedAction，不能直接 Execute
- Policy 决定 Auto、Human Review 还是 Reject
- 所有 Store / Executor 必须接口化，先提供 InMemory 实现
- 每个模块先写测试，再写实现

