/**
 * 极简 bearer / api-key 鉴权。
 *
 * 现实定位：这是给「熟人小圈子」用的共享空间，不是多租户 SaaS。
 * 一个共享密钥能挡住「扫到端口就能写」这类最基本的风险，
 * 但**不提供**按用户隔离、按资源授权。要真实用户体系请接微信 openid 或自有账号。
 *
 * 环境变量：
 *   AUTH_TOKEN      共享密钥；不配置则完全不校验（仅适合本地开发）
 *   ALLOW_ANONYMOUS 设为 1 时，即使配了 AUTH_TOKEN 也允许不带密钥的只读探针
 *                   （用来给健康检查、内网探活留口子；默认不开启）
 */

import { createHash, timingSafeEqual } from 'node:crypto'

function digest(s) {
  return createHash('sha256').update(String(s), 'utf-8').digest()
}

/** 定长摘要比较，避免长度/前缀泄漏 */
function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}

export function createAuth({ token = '', allowAnonymous = false } = {}) {
  const enabled = String(token).trim().length > 0
  const secret = String(token).trim()

  return {
    enabled,
    /** 返回 { ok, reason } */
    check(req) {
      if (!enabled) return { ok: true, reason: 'no-token-configured' }

      const header = String(req.headers.authorization || '')
      const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
      const apiKey = String(req.headers['x-api-key'] || '').trim()
      const provided = bearer || apiKey

      if (provided && safeEqual(provided, secret)) return { ok: true, reason: 'token' }
      if (provided) return { ok: false, reason: 'bad-token' }
      if (allowAnonymous) return { ok: true, reason: 'anonymous-allowed' }
      return { ok: false, reason: 'missing-token' }
    }
  }
}
