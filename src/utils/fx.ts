/**
 * 汇率换算 —— 记账页的「快抄」辅助：旅途中手里拿的是外币小票，
 * 帐单要按行程币种（¥）入账，先在这里折一下再记。
 *
 * 为什么是内置静态表而不是在线拉实时汇率：
 *   · 记账用不上「实时」—— 参考中间价与现实成交汇率的偏差，通常比行程里
 *     各人对小票金额的眼花误差还小，AA 已完不需要分毫必争到那一档；
 *   · 离线可用（出境漫游经常连不上）+ 可单测 + 零后端依赖。
 *   以后真要实时，加一个 weather 式的服务端代理 + TTL 缓存即可，换算入口不变。
 *
 * 口径：**1 单位外币 ≈ x 元人民币**。行程币种目前只有 '¥'（TripCreatePage
 * 硬编码、服务端 normTrip 白名单兜底也是 '¥'），所以折算目标就是 CNY；
 * 将来行程级支持多币种，这张表的交叉换算也要跟着改造 —— 到时必须带单测。
 */

export interface FxCurrency {
  /** ISO 4217 代码，UI 与结果显示都用它 */
  code: string
  name: string
  /** 1 单位 ≈ ? 元人民币（参考中间价） */
  cny: number
}

/** 常见出境目的地前置排序 */
export const FX_CURRENCIES: FxCurrency[] = [
  { code: 'USD', name: '美元', cny: 7.16 },
  { code: 'EUR', name: '欧元', cny: 7.85 },
  { code: 'JPY', name: '日元', cny: 0.048 },
  { code: 'HKD', name: '港币', cny: 0.92 },
  { code: 'KRW', name: '韩元', cny: 0.0052 },
  { code: 'TWD', name: '新台币', cny: 0.23 },
  { code: 'THB', name: '泰铢', cny: 0.21 },
  { code: 'SGD', name: '新加坡元', cny: 5.3 },
  { code: 'MYR', name: '林吉特', cny: 1.62 },
  { code: 'GBP', name: '英镑', cny: 9.1 },
  { code: 'PHP', name: '菲律宾比索', cny: 0.125 },
  { code: 'VND', name: '越南盾', cny: 0.00028 }
]

/** 汇率的批次说明（显示在面板底部，明示「不实时」） */
export const FX_STAMP = '2026-09 参考中间价 · 不实时，记实际支付'

export function fxRateOf(code: string): number | null {
  const c = FX_CURRENCIES.find((x) => x.code === code)
  return c ? c.cny : null
}

/**
 * 外币金额 → 元人民币，保留两位小数（帐单入账的最小精度）。
 * 未知币种或非有限数 → null（由调用方决定展示口径）。
 * 允许负数：与金额算式求值器同一口径，保存层再拦 >0。
 */
export function fxToCny(amount: number, code: string): number | null {
  const rate = fxRateOf(code)
  if (rate === null || !Number.isFinite(amount)) return null
  return Math.round(amount * rate * 100) / 100
}
