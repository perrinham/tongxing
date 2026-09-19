import { avatarColor, avatarInk, CANVAS_PALETTE } from './format'

/**
 * 海报是 canvas 画的，读不到 CSS 变量，所以颜色必须走字面值。
 * `P` 就是 `CANVAS_PALETTE` 的短别名 —— 它是 theme.css 的唯一镜像，改令牌时同步那边。
 *
 * 历史：这里原本散着一套自己的旧配色（米色底 #F8F7F4、暖黑 #2C2C2A、暖灰 #F1EFE8、
 * 重复绿 #1D9E75），所以 App 全域改成 iOS 扁平风之后，分享出去的海报还是老样子。
 * 现在全部对齐令牌。
 *
 * 纪律：**这个文件里不许出现手写的颜色字面量**，连 `'#FFFFFF'` 都不行 ——
 * 即便它今天正好等于 `bgCard`，`--bg-card` 一变它就变成新的漂移源。
 * 一律写 `P.xxx`；例外只有「按底色算出来的」`avatarInk(bg)` 和按分类取的 `c.color`。
 * `check-tokens` 的 ⑥ 会扫这个文件里的颜色字面量。
 */
const P = CANVAS_PALETTE

export interface PosterData {
  title: string
  destination: string
  range: string
  total: number
  perCapita: number
  peopleCount: number
  balances: { name: string; net: number; colorIndex: number }[]
  transfers: { from: string; to: string; amount: number }[]
  categories: { label: string; amount: number; color: string }[]
}

const W = 750
const PAD = 48
const FONT = '-apple-system, "PingFang SC", "Helvetica Neue", sans-serif'

export function posterWidth(): number {
  return W
}

function money(n: number): string {
  const abs = Math.abs(n)
  const fixed = abs.toFixed(2)
  const [int, dec] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${n < 0 ? '-' : ''}¥${dec === '00' ? grouped : `${grouped}.${dec}`}`
}

function ellipsis(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function roundRect(
  ctx: CanvasRenderingContext2D | any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function font(ctx: CanvasRenderingContext2D | any, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT}`
}

function drawAvatar(
  ctx: CanvasRenderingContext2D | any,
  cx: number,
  cy: number,
  r: number,
  name: string,
  colorIndex: number
) {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  const bg = avatarColor(colorIndex)
  ctx.fillStyle = bg
  ctx.fill()
  // 初始字颜色跟着底色走（白/黑取对比度更高者）—— 海报上写死白字会糊，见 avatarInk 注释
  ctx.fillStyle = avatarInk(bg)
  font(ctx, 500, 22)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const ch = /[\u4e00-\u9fa5]/.test(name) ? name.slice(-1) : name.slice(0, 1).toUpperCase()
  ctx.fillText(ch, cx, cy + 1)
  ctx.textBaseline = 'alphabetic'
}

function sectionTitle(ctx: CanvasRenderingContext2D | any, text: string, y: number) {
  ctx.textAlign = 'left'
  ctx.fillStyle = P.textPrimary
  font(ctx, 500, 30)
  ctx.fillText(text, PAD, y)
}

/** 计算海报高度（与 drawPoster 共用同一套布局常量） */
export function posterHeight(data: PosterData): number {
  const HEADER = 300
  const OVERVIEW = 96
  const TITLE_GAP = 56
  const BAL_ROW = 64
  const BAL_PAD = 26
  const BAL_H = BAL_PAD * 2 + data.balances.length * BAL_ROW
  const TRANS_ROW = 58
  const TRANS_PAD = 28
  const TRANS_H = TRANS_PAD * 2 + Math.max(1, data.transfers.length) * TRANS_ROW
  const CAT_ROW = 50
  const CAT_PAD = 24
  const hasCat = data.categories.length > 0
  const CAT_H = hasCat ? CAT_PAD * 2 + data.categories.length * CAT_ROW : 0
  const FOOTER = 100

  const gap = 34
  let H = HEADER + OVERVIEW + gap
  H += TITLE_GAP + BAL_H + gap
  H += TITLE_GAP + TRANS_H + gap
  if (hasCat) H += TITLE_GAP + CAT_H + gap
  H += FOOTER
  return H
}

/** 在已有的 2D 上下文上绘制结算海报（坐标系已按 dpr 缩放，绘制使用逻辑像素 W×H） */
export function drawPoster(
  ctx: CanvasRenderingContext2D | any,
  _W: number,
  H: number,
  data: PosterData
): void {
  // 背景
  ctx.fillStyle = P.bgPage
  ctx.fillRect(0, 0, W, H)

  /* 顶部品牌区 —— 用 brandDeep 而不是 brand：
     这只海报是要发出去的、会被压图、会在手机上缩到 1/4 看，
     所以它比 App 内更不该出现「看得见但费劲」的字。
       底 = brand     → 白字只有 3.18:1（22px 的「总支出」这类根本不过）
       底 = brandDeep → 所有字号都过
     具体两个比值由 `check-tokens` 的 ⑥ 从令牌**算出来打印** ——
     这里原来抄的是 `#15795A / 5.37:1`，而 `--brand-deep` 早已是 `#12724F`（5.92:1），
     一个过期快照同时污染了「值」和「结论」。**别在这儿写数字。**
     同时把三处半透明白（0.78 / 0.86 / 0.92）全部改成实白：
     半透明会把白往绿里拉，实测只有 2.51 ~ 2.92:1 —— 是本来最糊的一批。 */
  ctx.fillStyle = P.brandDeep
  ctx.fillRect(0, 0, W, 300)

  ctx.textAlign = 'left'
  ctx.fillStyle = P.textInverse
  font(ctx, 400, 24)
  ctx.fillText('结算单', PAD, 62)

  ctx.fillStyle = P.textInverse
  font(ctx, 500, 40)
  ctx.fillText(ellipsis(data.title, 13), PAD, 116)

  ctx.fillStyle = P.textInverse
  font(ctx, 400, 22)
  ctx.fillText(`${ellipsis(data.destination, 6)} · ${data.range}`, PAD, 154)

  // 总支出行
  ctx.fillStyle = P.textInverse
  font(ctx, 400, 22)
  ctx.fillText('总支出', PAD, 218)

  ctx.fillStyle = P.textInverse
  font(ctx, 500, 52)
  ctx.textAlign = 'right'
  ctx.fillText(money(data.total), W - PAD, 220)

  // 概览条
  ctx.fillStyle = P.bgCard
  roundRect(ctx, PAD, 276, W - PAD * 2, 96, 22)
  ctx.fill()

  const cellW = (W - PAD * 2) / 2
  const drawStat = (label: string, value: string, cx: number) => {
    ctx.textAlign = 'left'
    ctx.fillStyle = P.textSecondary
    font(ctx, 400, 21)
    ctx.fillText(label, cx, 314)
    ctx.fillStyle = P.textPrimary
    font(ctx, 500, 27)
    ctx.fillText(value, cx, 348)
  }
  drawStat('人均', money(data.perCapita), PAD + 28)
  drawStat('人数', `${data.peopleCount} 人`, PAD + 28 + cellW)

  let y = 300 + 96 + 34

  // 各自净额
  sectionTitle(ctx, '各自净额', y + 22)
  y += 56

  ctx.fillStyle = P.bgCard
  roundRect(ctx, PAD, y, W - PAD * 2, 52 + data.balances.length * 64, 22)
  ctx.fill()

  const maxAbs = Math.max(1, ...data.balances.map((b) => Math.abs(b.net)))
  const trackX = PAD + 84
  const netW = 150
  const trackW = W - PAD * 2 - 84 - 28 - netW

  data.balances.forEach((b, i) => {
    const ry = y + 26 + i * 64
    drawAvatar(ctx, PAD + 46, ry + 20, 22, b.name, b.colorIndex)

    ctx.textAlign = 'left'
    ctx.fillStyle = P.textPrimary
    font(ctx, 500, 26)
    ctx.fillText(ellipsis(b.name, 8), PAD + 84, ry + 18)

    ctx.textAlign = 'right'
    // 金额是海报上最该看清的东西 —— 负额走 accentDeep（6.17:1），不是 accent（3.05:1）
    ctx.fillStyle = b.net > 0.005 ? P.brandDeep : b.net < -0.005 ? P.accentDeep : P.textSecondary
    font(ctx, 500, 26)
    const sign = b.net > 0.005 ? '+' : b.net < -0.005 ? '-' : ''
    ctx.fillText(`${sign}${money(Math.abs(b.net))}`, W - PAD - 28, ry + 18)

    const barY = ry + 34
    ctx.fillStyle = P.bgSubtle
    roundRect(ctx, trackX, barY, trackW, 7, 3.5)
    ctx.fill()
    ctx.fillStyle = b.net > 0.005 ? P.brand : P.accent
    const bw = Math.max(5, (Math.abs(b.net) / maxAbs) * trackW)
    roundRect(ctx, trackX, barY, bw, 7, 3.5)
    ctx.fill()
  })

  y += 52 + data.balances.length * 64 + 34

  // 转账方案
  sectionTitle(ctx, `最少转账（${data.transfers.length} 笔）`, y + 22)
  y += 56

  ctx.fillStyle = P.bgCard
  roundRect(ctx, PAD, y, W - PAD * 2, 56 + Math.max(1, data.transfers.length) * 58, 22)
  ctx.fill()

  if (data.transfers.length) {
    data.transfers.forEach((t, i) => {
      const ry = y + 28 + i * 58
      const baseY = ry + 22

      let x = PAD + 28
      ctx.textAlign = 'left'
      ctx.fillStyle = P.textPrimary
      font(ctx, 400, 25)
      const from = ellipsis(t.from, 6)
      ctx.fillText(from, x, baseY)
      x += ctx.measureText(from).width + 14

      // 箭头是文字字形，不是图形 → 同一条「浅底上的字用 -deep」规则
      ctx.fillStyle = P.brandDeep
      ctx.fillText('→', x, baseY)
      x += ctx.measureText('→').width + 14

      ctx.fillStyle = P.textPrimary
      ctx.fillText(ellipsis(t.to, 6), x, baseY)

      ctx.textAlign = 'right'
      ctx.fillStyle = P.textPrimary
      font(ctx, 500, 26)
      ctx.fillText(money(t.amount), W - PAD - 28, baseY)
    })
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = P.brandDeep
    font(ctx, 500, 26)
    ctx.fillText('账已平，无需转账', PAD + 28, y + 28 + 24)
  }

  y += 56 + Math.max(1, data.transfers.length) * 58 + 34

  // 分类
  if (data.categories.length) {
    sectionTitle(ctx, '花在哪儿了', y + 22)
    y += 56

    ctx.fillStyle = P.bgCard
    roundRect(ctx, PAD, y, W - PAD * 2, 48 + data.categories.length * 50, 22)
    ctx.fill()

    const barX = PAD + 130
    const barW = W - PAD * 2 - 130 - 28 - 190

    data.categories.forEach((c, i) => {
      const ry = y + 24 + i * 50
      const cy = ry + 12

      ctx.beginPath()
      ctx.arc(PAD + 36, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = c.color
      ctx.fill()

      ctx.textAlign = 'left'
      ctx.fillStyle = P.textSecondary
      font(ctx, 400, 24)
      ctx.fillText(c.label, PAD + 54, cy + 8)

      ctx.fillStyle = P.bgSubtle
      roundRect(ctx, barX, cy - 1, barW, 12, 6)
      ctx.fill()
      ctx.fillStyle = c.color
      roundRect(ctx, barX, cy - 1, Math.max(6, (c.amount / Math.max(1, data.total)) * barW), 12, 6)
      ctx.fill()

      ctx.textAlign = 'right'
      ctx.fillStyle = P.textPrimary
      font(ctx, 500, 24)
      ctx.fillText(money(c.amount), W - PAD - 28, cy + 8)
    })

    y += 48 + data.categories.length * 50 + 34
  }

  // 页脚
  ctx.textAlign = 'center'
  ctx.fillStyle = P.textSecondary
  font(ctx, 400, 22)
  ctx.fillText('由「同行」生成 · 行程与分摊一站式', W / 2, H - 44)
}
