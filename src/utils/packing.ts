/**
 * 行李清单生成器 —— 按行程的「天数 / 季节 / 温度 / 交通 / 住宿 / 目的地关键词」
 * 推一份确定性的打包模板。
 *
 * 为什么是规则而不是 AI 接口：这类模板的正确性来自清单性常识而非模型能力，
 * 规则给出的结果**可预测、可单测、零延迟零成本**；生成的行程本身（applyGenerate）
 * 已经给了天/时段/交通/住宿这些结构化信号，直接用就行。
 *
 * 没有温度信号时退到按月季的粗糙估计（真拿天气是行程页的事，见 weather.ts）；
 * 生成结果全部可被用户增删勾选 —— 模板只管起个头，不管定终身。
 *
 * 纯函数模块：无 uni / store 依赖，esbuild 打包即可在 Node 里单测
 * （scripts/packing-test.mjs）。
 */
import type { PackingItem } from '@/types'

export interface PackingInput {
  destination?: string
  /** 行程天数（会夹到 1..30） */
  days: number
  /** 起始日期（ISO yyyy-mm-dd），只用来推季节；拿不到就按平季 */
  startDate?: string
  /** 行程里有住宿项 → 加酒店订单/拖鞋 */
  hasStay?: boolean
  /** 行程里有城际交通 → 加车票订单/晕车药 */
  hasTransit?: boolean
  /** 温度信号（行程页有天气缓存时传进来） */
  tempHigh?: number
  tempLow?: number
  rainDays?: number
}

/** 分组 key 与展示名。生成顺序按这个数组，页面分组渲染靠「相邻项组变化」推断 */
export const PACKING_GROUPS: Array<{ key: string; label: string }> = [
  { key: 'docs', label: '证件票单' },
  { key: 'wear', label: '衣物' },
  { key: 'care', label: '洗护' },
  { key: 'elec', label: '电子' },
  { key: 'meds', label: '药品' },
  { key: 'misc', label: '其他' }
]

export function packGroupLabel(key: string): string {
  return PACKING_GROUPS.find((g) => g.key === key)?.label || key
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** 没真数据时的季节默认（粗略，中国多数城市适用） */
function seasonDefault(month: number): { cold: number; hot: number; rain: number; summer: boolean } {
  if (month === 0) return { cold: 14, hot: 24, rain: 0, summer: false } // 无日期 → 平季
  if (month >= 11 || month <= 2) return { cold: 2, hot: 12, rain: 0, summer: false } // 冬
  if (month <= 5) return { cold: 12, hot: 24, rain: 1, summer: false } // 春
  if (month <= 8) return { cold: 24, hot: 32, rain: 2, summer: true } // 夏
  return { cold: 14, hot: 25, rain: 1, summer: false } // 秋
}

/** 生成清单：条数硬上限 40（与服务端裁剪孪生一致，客户端先守住） */
export const PACKING_MAX_ITEMS = 40

export function buildPackingList(input: PackingInput): PackingItem[] {
  const days = clamp(Math.round(input.days || 1), 1, 30)
  const dest = (input.destination || '').trim()
  const month = input.startDate ? Number(input.startDate.slice(5, 7)) || 0 : 0
  const season = seasonDefault(month)
  const cold = input.tempLow ?? season.cold
  const hot = input.tempHigh ?? season.hot
  const rain = input.rainDays ?? season.rain

  const items: PackingItem[] = []
  const add = (title: string, group: string) => {
    if (items.length < PACKING_MAX_ITEMS) items.push({ title, group, done: false })
  }

  // ── 证件票单 ──
  add('身份证', 'docs')
  if (/香港|澳门|港澳/.test(dest)) add('港澳通行证 / 签注', 'docs')
  if (input.hasStay) add('酒店订单', 'docs')
  if (input.hasTransit) add('车票 / 机票订单', 'docs')

  // ── 衣物 ──
  const sets = clamp(Math.ceil(days * 0.7), 2, 6)
  add(`内衣裤 ×${sets}`, 'wear')
  add(`袜子 ×${sets}`, 'wear')
  add('运动鞋', 'wear')
  if (cold <= 5) {
    add('羽绒服 / 厚外套', 'wear')
    add('围巾手套', 'wear')
  } else if (cold <= 16) {
    add('外套 1 件', 'wear')
  }
  if (hot >= 30) add(`短袖 ×${Math.min(days, 4)}`, 'wear')
  if (season.summer) add('防晒衣', 'wear')
  if (/海|岛|湾/.test(dest)) {
    add('泳装 / 沙滩鞋', 'wear')
  }

  // ── 洗护 ──
  add('牙刷牙膏', 'care')
  add('洗漱包', 'care')
  add('毛巾', 'care')
  if (hot >= 26 || season.summer) add('防晒霜（SPF50）', 'care')
  if (input.hasStay) add('一次性拖鞋', 'care')

  // ── 电子 ──
  add('手机充电器', 'elec')
  add('充电宝（≤2万毫安）', 'elec')
  add('耳机', 'elec')
  if (days >= 3) add('多口充电头', 'elec')

  // ── 药品 ──
  add('感冒药', 'meds')
  add('肠胃药', 'meds')
  add('创可贴', 'meds')
  if (input.hasTransit) add('晕车药', 'meds')
  if (season.summer || rain >= 3) add('驱蚊液', 'meds')

  // ── 其他 ──
  if (rain > 0) add('折叠伞', 'misc')
  add('水杯', 'misc')
  add('纸巾湿巾', 'misc')
  add('少量现金', 'misc')
  if (days >= 2) add('双肩包', 'misc')

  return items
}
