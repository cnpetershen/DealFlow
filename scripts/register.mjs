/** 注册 TypeScript 解析钩子；配合 node --experimental-transform-types 直接运行 src/main.ts。 */
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
