/**
 * HTTP 层：响应封装、CORS 白名单、请求体读取（带体积上限）、安全响应头。
 */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // 共享空间的响应不该被任何中间层缓存
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache'
}

/**
 * @param {object} opts
 * @param {number} opts.maxBodyBytes  请求体上限，超限返回 413
 * @param {string[]} opts.allowedOrigins  CORS 白名单；含 '*' 表示放开（仅建议开发用）
 */
export function createHttp({ maxBodyBytes = 2 * 1024 * 1024, allowedOrigins = [] } = {}) {
  const wildcard = allowedOrigins.includes('*')

  function resolveOrigin(origin) {
    if (!origin) return null
    if (wildcard) return '*'
    return allowedOrigins.includes(origin) ? origin : null
  }

  function headersFor(req, extra) {
    const h = { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS }
    const allow = resolveOrigin(req.headers.origin)
    if (allow) {
      h['Access-Control-Allow-Origin'] = allow
      h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      // ⚠️ 这里必须列出客户端会发的**每一个**自定义头，漏一个就会让 H5 的预检失败。
      // `X-Session-Token` 曾经漏掉过：小程序不执行 CORS，所以只在 H5 / 浏览器调试时
      // 表现为「带身份的请求全部失败」，而匿名请求照常 —— 极难联想到 CORS。
      h['Access-Control-Allow-Headers'] =
        'Content-Type,Authorization,X-Api-Key,X-Session-Token,X-Conn-Id,X-Request-Id'
      h['Access-Control-Max-Age'] = '600'
      // 按 Origin 变化的响应必须声明 Vary，否则中间缓存会串味
      h['Vary'] = 'Origin'
    }
    if (req.requestId) h['X-Request-Id'] = req.requestId
    return extra ? { ...h, ...extra } : h
  }

  /** 三个响应方法统一返回 true，路由里可直接 `return http.fail(...)` 表示「已处理」 */
  function send(req, res, status, data, extraHeaders) {
    const body = JSON.stringify(data === undefined ? {} : data)
    res.writeHead(status, headersFor(req, extraHeaders))
    res.end(body)
    return true
  }

  function fail(req, res, status, message, extra) {
    return send(req, res, status, { error: message, ...(extra || {}) })
  }

  /** 405 必须带 Allow 头（RFC 7231） */
  function methodNotAllowed(req, res, allow) {
    return send(req, res, 405, { error: 'method not allowed', allow }, { Allow: allow.join(', ') })
  }

  /**
   * 读取并解析 JSON 请求体。
   * @returns {Promise<{ok:true,value:any}|{ok:false,status:number,error:string}>}
   */
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let tooLarge = false
      let settled = false

      const finish = (r) => {
        if (settled) return
        settled = true
        resolve(r)
      }

      req.on('data', (c) => {
        size += c.length
        if (size > maxBodyBytes) {
          // 不立刻 destroy：先把剩余数据排空，否则没法把 413 回给客户端
          tooLarge = true
          chunks.length = 0
          return
        }
        if (!tooLarge) chunks.push(c)
      })

      req.on('end', () => {
        if (tooLarge) {
          return finish({
            ok: false,
            status: 413,
            error: `payload too large (limit ${maxBodyBytes} bytes)`
          })
        }
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (!raw.trim()) return finish({ ok: true, value: {} })
        try {
          const value = JSON.parse(raw)
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return finish({ ok: false, status: 400, error: 'body must be a JSON object' })
          }
          finish({ ok: true, value })
        } catch {
          finish({ ok: false, status: 400, error: 'invalid JSON body' })
        }
      })

      req.on('error', () => finish({ ok: false, status: 400, error: 'request stream error' }))
      req.on('aborted', () => finish({ ok: false, status: 499, error: 'client aborted' }))
    })
  }

  return { send, fail, methodNotAllowed, readBody, resolveOrigin, maxBodyBytes }
}
