/**
 * 在 Node 里模拟 uni 运行时，供 client-sync-entry.ts 驱动真实 store 逻辑。
 * 只实现被同步链路用到的几个 API。
 */

const TEST_BASE = process.env.TEST_BASE || 'http://localhost:8790'
/** 注定连不上的地址，用来模拟「离线」 */
const DEAD_BASE = 'http://127.0.0.1:9'
/** 源码里配置的后端地址，运行时替换成测试实例 */
const CONFIGURED_BASE = 'http://localhost:8787'

/**
 * 把 URL 的 host 换成测试实例的 host，协议与路径保持不变。
 *
 * 用于实时通道（`ws://`）：那里没法用「子串替换」把配置基址换掉，
 * 因为协议不同（http vs ws），前缀对不上。
 */
function rewriteHost(url: string, testBase: string): string {
  try {
    const u = new URL(url)
    const dev = new URL(CONFIGURED_BASE)
    if (u.host === dev.host) u.host = new URL(testBase).host
    return u.toString()
  } catch {
    return url // 不是合法 URL 就原样交出，让 WebSocket 自己去报错
  }
}

const sheets = new Map<string, Map<string, string>>()
const state = { device: 'A', online: true, offlineAll: false, loginFail: false, loginSeq: 0 }

function sheetOf(dev: string): Map<string, string> {
  let m = sheets.get(dev)
  if (!m) {
    m = new Map()
    sheets.set(dev, m)
  }
  return m
}

export const mock = {
  state,
  /** 切换到某台「设备」（独立本地存储） */
  useDevice(dev: string) {
    state.device = dev
    sheetOf(dev)
  },
  setOnline(v: boolean) {
    state.online = v
  },
  /**
   * 完全断网：连外部 API（高德）也走死地址。测「离线生成回退」时用。
   * setOnline(false) 只模拟后端不可达，外部请求照常。
   */
  setOfflineAll(v: boolean) {
    state.online = !v
    state.offlineAll = v
  },
  /** 让接下来的 uni.login 直接失败（验证「登录失败要能看见」这条路径） */
  setLoginFail(v: boolean) {
    state.loginFail = v
  },
  raw(dev: string): Map<string, string> {
    return sheetOf(dev)
  },
  /** 直接读某台设备的本地存储（断言「数据真的落到本地了」用） */
  read(dev: string, key: string): string {
    return sheetOf(dev).get(key) || ''
  },
  /**
   * 返回固定到某台设备 sheet 的存储后端（uni 三件套同形）。
   * 给 storage.createStorage() 注入用：store 实例的读写从此「创建时定终身」，
   * 不再依赖调用时刻的 state.device —— 去抖定时器 / 异步链晚点触发也写不串。
   */
  deviceBackend(dev: string) {
    return {
      getStorageSync: (key: string) => sheetOf(dev).get(key) ?? '',
      setStorageSync: (key: string, value: string) => {
        sheetOf(dev).set(key, String(value))
      },
      removeStorageSync: (key: string) => {
        sheetOf(dev).delete(key)
      }
    }
  }
}

const uniMock = {
  getStorageSync(key: string): string {
    return sheetOf(state.device).get(key) || ''
  },
  setStorageSync(key: string, value: string): void {
    sheetOf(state.device).set(key, String(value))
  },
  removeStorageSync(key: string): void {
    sheetOf(state.device).delete(key)
  },
  getSystemInfoSync() {
    return { pixelRatio: 2, platform: 'devtools' }
  },

  /**
   * 微信登录。真实小程序里返回一个一次性 code，这里用**递增序号**模拟：
   * 同一个序号不会重复出现，正好能表达「code 是一次性的」这件事 ——
   * 测试里拿它验证「登录不能重试」。
   */
  login(opts: {
    provider?: string
    success?: (r: { code: string; errMsg: string }) => void
    fail?: (e: { errMsg: string }) => void
  }): void {
    if (state.loginFail) {
      opts.fail?.({ errMsg: 'login:fail mock' })
      return
    }
    state.loginSeq += 1
    const dev = state.device
    opts.success?.({ code: `${dev}-code-${state.loginSeq}`, errMsg: 'login:ok' })
  },
  showToast(): void {},
  hideToast(): void {},
  showLoading(): void {},
  hideLoading(): void {},
  setClipboardData(): void {},
  openLocation(): void {},

  /** 把 uni.request 的 callback 风格映射到 fetch */
  request(opts: {
    url: string
    method?: string
    data?: unknown
    header?: Record<string, string>
    success?: (r: { statusCode: number; data: unknown }) => void
    fail?: (e: { errMsg: string }) => void
  }): void {
    // 高德等外部 API 默认不受「离线」开关影响；offlineAll 时一并断掉。
    // ⚠️ 本地后端与外部 API 要分开重写：本地后端是「域名替换」
    // （TEST_BASE ⇄ CONFIGURED_BASE），外部 API 的 URL 根本不含 CONFIGURED_BASE，
    // replace 对它**不生效** —— 之前 offlineAll 只改了 base 没改 URL，
    // 高德请求原样发往真实 API，「断网回退」测试全绿但什么都没测到。
    const isExternal = !String(opts.url).startsWith(CONFIGURED_BASE)
    let url = String(opts.url)
    if (isExternal) {
      if (state.offlineAll) url = DEAD_BASE // 外部 API 断网：直接指向死地址
    } else {
      url = url.replace(CONFIGURED_BASE, state.online ? TEST_BASE : DEAD_BASE)
    }

    // ⚠️ uni.request 在 GET 下会把 data 对象序列化成 query string 拼到 URL 上，
    // 小程序/浏览器运行时都这样；Node 桥必须自己补，否则像高德这种「全靠 query
    // 传参」的 API 会丢掉所有参数（key 都没带 → 静默失败）。
    if (
      opts.data &&
      typeof opts.data === 'object' &&
      (!opts.method || opts.method.toUpperCase() === 'GET')
    ) {
      const qs = new URLSearchParams(
        Object.entries(opts.data as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ).toString()
      if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    fetch(url, {
      method: opts.method || 'GET',
      headers: opts.header || {},
      body: opts.data === undefined || (!opts.method || opts.method.toUpperCase() === 'GET')
        ? undefined
        : JSON.stringify(opts.data),
      signal: ac.signal
    })
      .then(async (r) => {
        clearTimeout(timer)
        const text = await r.text()
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
        opts.success?.({ statusCode: r.status, data })
      })
      .catch((e: unknown) => {
        clearTimeout(timer)
        opts.fail?.({ errMsg: String((e as Error)?.message || e) })
      })
  },

  /**
   * WebSocket。**不 mock 协议** —— 直接用 Node 22 的全局 `WebSocket`
   * （undici 实现）去连测试实例，所以这里跑的是真实的握手、真实的帧、
   * 真实的掩码与心跳。用一个假的 socket 去测实时同步，等于什么都没测。
   *
   * 与真实 `uni.connectSocket` 的差别只剩一点：不支持 `header`
   * （我们本来就不用 —— 会话令牌走首帧 hello）。
   *
   * ⚠️ 但**返回值形状必须照实模拟**：uni-app 只有在传了 success/fail/complete
   * 回调时才把平台的 SocketTask 原样返回；不传回调就把接口 Promise 化，返回 Promise。
   * 早期这个 mock 无论怎样都返回 SocketTask，于是「忘了传回调 → 小程序里
   * `next.onOpen is not a function` → onLaunch 被截断」这个 bug 在 138 条断言下
   * 照样溜过去了（只有真机/开发者工具才暴露）。这里照样还原，让测试能拦住它。
   */
  connectSocket(opts: {
    url: string
    success?: () => void
    fail?: () => void
    complete?: () => void
  }): unknown {
    // ⚠️ 不能像 uni.request 那样直接做字符串替换：实时地址是 `ws://localhost:8787/...`，
    // 而配置里的基址是 `http://localhost:8787` —— 子串根本匹配不上，替换会静默失效，
    // 结果就是「连不上」而看不出为什么。这里按 host 比对来改，协议前缀无关。
    const url = rewriteHost(String(opts.url), TEST_BASE)

    // 跟着 uni-app 的约定走：没给回调就 Promise 化。调用方要是拿返回值当 SocketTask 用，
    // 就会在这里拿到 Promise 并在注册监听时炸掉 —— 这正是线上真实发生过的故障形态。
    if (typeof opts?.success !== 'function' && typeof opts?.fail !== 'function') {
      return Promise.resolve({ errMsg: 'connectSocket:ok' })
    }

    const ws = new WebSocket(url)
    const onOpen: Array<(res: unknown) => void> = []
    const onMessage: Array<(res: { data: unknown }) => void> = []
    const onClose: Array<(res: { code?: number; reason?: string }) => void> = []
    const onError: Array<(err: { errMsg?: string }) => void> = []
    let isOpen = false

    ws.addEventListener('open', () => {
      isOpen = true
      opts.success?.()
      for (const cb of onOpen) cb({})
    })
    ws.addEventListener('message', (ev: { data: unknown }) => {
      for (const cb of onMessage) cb({ data: ev.data })
    })
    ws.addEventListener('close', (ev: { code?: number; reason?: string }) => {
      isOpen = false
      opts.complete?.()
      for (const cb of onClose) cb({ code: ev.code, reason: ev.reason })
    })
    ws.addEventListener('error', () => {
      opts.fail?.()
      for (const cb of onError) cb({ errMsg: 'socket error' })
    })

    return {
      onOpen: (cb: (res: unknown) => void) => onOpen.push(cb),
      onMessage: (cb: (res: { data: unknown }) => void) => onMessage.push(cb),
      onClose: (cb: (res: { code?: number; reason?: string }) => void) => onClose.push(cb),
      onError: (cb: (err: { errMsg?: string }) => void) => onError.push(cb),
      send: (o: { data: string }) => {
        if (isOpen) ws.send(o.data)
      },
      close: (o?: { code?: number; reason?: string }) => {
        try {
          ws.close(o?.code ?? 1000, o?.reason ?? '')
        } catch {
          /* 已经关了 */
        }
      }
    }
  }
}

;(globalThis as unknown as { uni: unknown }).uni = uniMock

export { TEST_BASE, DEAD_BASE }
