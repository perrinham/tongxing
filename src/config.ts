/**
 * 高德开放平台配置。
 *
 * ⚠️ 这里要用「Web 服务」key，不是 JS API / 地图 JS 的 key。
 * 申请地址：https://console.amap.com/dev/key/app  （创建应用 -> 添加 key -> 服务平台选「Web服务」）
 *
 * 微信小程序还要求在小程序后台「开发 -> 开发设置 -> 服务器域名 -> request 合法域名」
 * 添加：https://restapi.amap.com
 * （manifest.json 里已设 urlCheck:false，开发期用微信开发者工具的「不校验合法域名」即可直接试）
 */
function amapKeyFromEnv(): string {
  const vite = import.meta.env?.VITE_AMAP_WEB_KEY
  if (vite) return String(vite)
  // Node 测试环境（esbuild 打包，没有 import.meta.env）回退到进程环境变量。
  // 浏览器构建里 Vite 会把上面那行替换成字面量，走不到这里。
  const procEnv = (globalThis as { process?: { env?: Record<string, string> } }).process?.env
  return String(procEnv?.VITE_AMAP_WEB_KEY ?? '')
}

export const AMAP_WEB_KEY = amapKeyFromEnv()

/** 是否启用高德（key 为空时自动降级为本地点位库，保证离线可用） */
export const AMAP_ENABLED = AMAP_WEB_KEY.trim().length > 0

/**
 * 城市攻略共享 + 行程同步后端配置。
 *
 * 后端提供两块能力（见 server/index.mjs）：
 *   1. 城市攻略 / 评价按城市聚合、多人可见 —— 想去的人读到去过的人写的内容。
 *   2. 行程空间同步 —— 一次旅行的行程、成员、行程项、账单在多人多端之间合并。
 *
 * - 本地开发 / H5：填 http://localhost:8787 即可（先 `npm run server` 起服务）。
 * - 微信小程序正式版：必须是 https 且加入小程序后台「request 合法域名」
 *   （开发期可在微信开发者工具勾选「不校验合法域名」直接试）。
 * - **真机调试**连不上电脑的 localhost，要把地址改成电脑的局域网 IP，
 *   例如 http://192.168.1.8:8787（手机与电脑需在同一 Wi-Fi）。
 *
 * 若后端不可达，App 会自动回退到纯本地，不会崩。
 */
export const BACKEND_ENABLED = true
export const BACKEND_BASE_URL = 'http://localhost:8787'

/**
 * 后端共享密钥，对应服务端的 AUTH_TOKEN。
 * 服务端未配置 AUTH_TOKEN 时留空即可；配置了就必须一致，否则所有请求 401。
 *
 * ⚠️ 放在客户端代码里的密钥是**可被反编译取出**的，它只能挡住「扫到端口就写」
 * 这类最低成本的风险，不能当作真正的账号体系。要多用户隔离请接微信 openid。
 */
export const BACKEND_TOKEN = ''

/** 是否开启行程 / 账单云端同步（关闭时 App 行为与纯本地版完全一致） */
export const SYNC_ENABLED = BACKEND_ENABLED

/** 本地改动后延迟多久自动推送（毫秒）。避免连续编辑时把请求打得太密 */
export const SYNC_DEBOUNCE_MS = 1800

// ───────────────────────── 实时同步（WebSocket）─────────────────────────

/**
 * 是否开启实时同步。
 *
 * 开启后，同行的人一改，本机在百毫秒量级就能看到 —— 不再依赖「我这边正好在拉」。
 * 关掉它没有任何功能损失：改动仍然会在 `SYNC_DEBOUNCE_MS` 之后推上去，
 * 只是别人只能在自己推送 / 回到前台时才看到。
 *
 * ⚠️ 它是**加速层**而不是可靠层：断线、错过通知都不影响正确性 ——
 * 服务端在订阅响应里会带上每个空间当前的 rev，客户端发现有对不上的就补拉一次
 * （见 stores/trip.ts 的 onSubscribed）。所以这里不做「必须连上」的保证。
 */
export const REALTIME_ENABLED = SYNC_ENABLED

/** 实时端点路径，必须与服务端 `WS_PATH` 一致 */
export const REALTIME_PATH = '/api/ws'

/** 应用层心跳间隔（毫秒）。服务端 `WS_PING_MS` 应与之相近 */
export const REALTIME_PING_MS = 25_000

/**
 * 多久没收到**任何**消息就认为连接已死、主动重连。
 *
 * 比心跳间隔的 2 倍再多留 5 秒：服务端在连续两个心跳周期没收到任何帧时才判死，
 * 客户端判得比它早会造成「其实还活着但我先断了」。留出余量让服务端先出手，
 * 客户端只在**真的静默**（对端进程被杀、NAT 超时）时才自断。
 */
export const REALTIME_IDLE_TIMEOUT_MS = REALTIME_PING_MS * 2 + 5_000

/** 重连退避：首次延迟与上限（指数增长，带抖动） */
export const REALTIME_RETRY_BASE_MS = 1_000
export const REALTIME_RETRY_MAX_MS = 30_000

/** 建连后多久没等到 ready 就认为握手失败（服务端 WS_AUTH_GRACE_MS 是 5s） */
export const REALTIME_HELLO_TIMEOUT_MS = 8_000

/**
 * 允许时间戳超前本机 / 服务端的上限（毫秒），超出即封顶。
 *
 * 挡的是「手机时钟快 3 小时」这类设备：它们的时间戳永远压过别人，而且**不可恢复** ——
 * 别人怎么改都赢不回来。封顶之后它的排序权重最多到 `now + 这个值`，
 * 剩下的偏差在 1 分钟量级，正常时钟很快就能追上并超过它。
 *
 * 必须与后端 `MAX_CLOCK_SKEW_MS`（server/index.mjs）保持一致：
 * 客户端用它封顶「收进来的别家戳」，服务端用它封顶「比较时的双方戳」，
 * 两侧口径不同会让同一份数据在两处得到不同的先后结论。
 */
export const CLOCK_MAX_SKEW_MS = 60_000

/** 单次请求超时（毫秒） */
export const REQUEST_TIMEOUT_MS = 12000
