/**
 * 解析钩子：让 Node 直接的 TypeScript 运行支持本项目的无扩展名相对导入
 * （tsconfig 使用 moduleResolution: Bundler，源码写作 `import './x'`）。
 *
 * 只补全相对/绝对说明符，裸包名与 node: 内置模块交给默认解析，不改变既有语义。
 */
export async function resolve(specifier, context, nextResolve) {
  const isPathLike =
    specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');

  if (!isPathLike) {
    return nextResolve(specifier, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // 继续尝试下一个候选；全部失败时抛原始错误。
      }
    }
    throw error;
  }
}
