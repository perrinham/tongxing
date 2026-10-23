/**
 * 预算智能分配 —— 按目的地消费档位 + 天数 + 人数 + 节奏，估一份「分项预算」。
 *
 * 与 AA 记账互不干扰：Trip.budget 仍是用户手填的人均预算（可选），
 * 这里只给**参考值**——新建行程页在预算输入下方展示 + 一键填入。
 *
 * 口径：
 *  · 城市消费档位（一线 / 热门景区 / 海岛 / 高原边疆 / 港澳台 / 默认），taste 同款
 *    「拿不准的不标」思路——目的地不在表里走通用档兜底，不硬猜；
 *  · 有真实行程项时门票用真实值（本地库 POI 带票价），在线库（多为 0）用档位估；
 *  · 住宿按标间摊（ceil(人数/2) 间），人均 = 档位房价 × 间数 ÷ 人数；
 *  · 节奏只动门票与餐饮（relax 0.8/0.9，packed 1.15/1.1），交通住宿不动；
 *  · 全部纯函数，无副作用、无网络。
 */

export interface CostTier {
  /** 档位名（展示用） */
  name: string
  /** 标间每晚 */
  stay: number
  /** 每人每天餐饮 */
  food: number
  /** 每人每天市内交通 */
  transit: number
  /** 每人每天门票/活动（无真实行程项时的估算） */
  ticket: number
}

const DEFAULT_TIER: CostTier = { name: '一般城市', stay: 280, food: 110, transit: 35, ticket: 60 }

const TIERS: Record<string, CostTier> = {
  一线都市: { name: '一线都市', stay: 400, food: 160, transit: 50, ticket: 80 },
  热门景区度假: { name: '热门景区度假', stay: 320, food: 130, transit: 45, ticket: 110 },
  海岛度假: { name: '海岛度假', stay: 450, food: 150, transit: 60, ticket: 120 },
  高原边疆: { name: '高原边疆', stay: 250, food: 95, transit: 55, ticket: 70 },
  港澳台: { name: '港澳台', stay: 520, food: 210, transit: 70, ticket: 130 }
}

/** 档位 → 城市名单（destination includes 前缀匹配，容「三亚湾」「黄山北站」式输入） */
const TIER_CITIES: Record<string, string[]> = {
  一线都市: ['北京', '上海', '深圳', '广州', '杭州', '南京', '成都', '重庆', '武汉', '西安', '天津', '长沙'],
  热门景区度假: ['黄山', '桂林', '张家界', '婺源', '厦门', '青岛', '大连', '九寨沟', '峨眉山', '香格里拉', '稻城', '西双版纳', '凤凰', '敦煌', '洛阳', '大理', '丽江'],
  海岛度假: ['三亚', '海口', '北海', '万宁', '陵水', '涠洲岛'],
  高原边疆: ['拉萨', '西宁', '乌鲁木齐', '呼和浩特', '兰州', '银川', '喀什'],
  港澳台: ['香港', '澳门', '台北']
}

export function tierFor(destination: string): CostTier {
  const d = (destination || '').trim()
  if (!d) return DEFAULT_TIER
  const key = Object.keys(TIER_CITIES).find((k) => TIER_CITIES[k].some((c) => d.includes(c)))
  return key ? TIERS[key] : DEFAULT_TIER
}

export interface BudgetParts {
  label: string
  /** 人均 */
  pp: number
}

export interface BudgetEstimate {
  tier: CostTier
  days: number
  nights: number
  peopleCount: number
  /** 人均全程（四项合计，十位取整） */
  perPerson: number
  /** 全组合计 */
  group: number
  /** 分项（人均）：住宿 / 门票 / 餐饮 / 交通 */
  parts: BudgetParts[]
}

export interface EstimateInput {
  destination: string
  days: number
  peopleCount: number
  /** 默认 normal */
  pace?: 'relax' | 'normal' | 'packed'
  /**
   * 已生成的行程项（可传）。type==='spot' 且 cost>0 的真实门票累计；
   * 空值/缺省回档位估算。
   */
  items?: { cost: number; type?: string }[]
}

/** 十位取整：1352 → 1350，128 → 130 */
function round10(n: number): number {
  return Math.round(n / 10) * 10
}

export function estimateBudget(input: EstimateInput): BudgetEstimate {
  const tier = tierFor(input.destination)
  const days = Math.max(1, Math.round(input.days) || 1)
  const people = Math.max(1, Math.round(input.peopleCount) || 1)
  const nights = Math.max(0, days - 1)
  const pace = input.pace || 'normal'

  // 住宿：标间（两人一摊）× 晚数，人均分摊
  const rooms = Math.ceil(people / 2)
  const stayPP = (tier.stay * nights * rooms) / people

  // 门票：真实行程项优先（type spot 且 cost>0），否则档位 × 天数 × 节奏
  let tickets: number | null = null
  if (input.items) {
    const sum = input.items
      .filter((i) => (!i.type || i.type === 'spot') && i.cost > 0)
      .reduce((a, i) => a + i.cost, 0)
    if (sum > 0) tickets = sum
  }
  if (tickets === null) {
    tickets = tier.ticket * days * (pace === 'relax' ? 0.8 : pace === 'packed' ? 1.15 : 1)
  }

  const food = tier.food * days * (pace === 'relax' ? 0.9 : pace === 'packed' ? 1.1 : 1)
  const transit = tier.transit * days

  const parts: BudgetParts[] = [
    { label: '住宿', pp: round10(stayPP) },
    { label: '门票', pp: round10(tickets) },
    { label: '餐饮', pp: round10(food) },
    { label: '交通', pp: round10(transit) }
  ]
  const perPerson = round10(parts.reduce((a, p) => a + p.pp, 0))
  return {
    tier,
    days,
    nights,
    peopleCount: people,
    perPerson,
    group: round10(perPerson * people),
    parts
  }
}

/** 一行文案：'一线都市 3 天（2 人）：人均约 ¥1,270 / 全组 ¥2,540 —— 住宿 400 · 门票 240 · 餐饮 480 · 交通 150' */
export function budgetBrief(est: BudgetEstimate): string {
  const partsText = est.parts.map((p) => `${p.label} ${p.pp}`).join(' · ')
  return `${est.tier.name} ${est.days} 天（${est.peopleCount} 人）：人均约 ¥${est.perPerson} / 全组 ¥${est.group} —— ${partsText}`
}
