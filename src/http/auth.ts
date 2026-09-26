import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer Token 校验。
 *
 * 必须与 HMAC 路径一样使用常数时间比较：`!==` 会在第一个不同字节处返回，
 * 攻击者可以按字节把 `Authorization` 头逐位试出来——同一条链路里签名用 `timingSafeEqual`
 * 而 token 用 `!==`，是自相矛盾的弱化点。
 *
 * 比较双方先各自过 sha256：`timingSafeEqual` 只接受等长输入，直接比较会因为长度不同
 * 提前返回（等于泄漏 token 长度），哈希把两者固定成 32 字节后再比。
 * `token` 为 null 表示未启用 Token 校验，调用方本就不应进入该分支。
 */
export function bearerTokenMatches(header: string | undefined, token: string | null): boolean {
  if (token === null || typeof header !== 'string') {
    return false;
  }

  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
