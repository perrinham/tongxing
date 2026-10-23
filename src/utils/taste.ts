/**
 * 个性化口味画像 —— 「按足迹推荐」的依据。
 *
 * 用户定的方向：生成下一份行程时，读城市足迹（src/stores/city passports），
 * 从「去过哪些城市 + 给的评分 + 心愿单」推断兴趣画像（山水 / 人文 / 都市 / 亲子
 * 四个维度的权重），生成选点时温和加权（utils/itinerary.ruleEnginePlan）。
 *
 * 原则：
 *  · 样本不足（<2 个有效足迹）不生效——避免「去过一个城就乱猜喜欢什么的噪音」；
 *  · 只在打分阶段加权重排，**不碰地理聚类**（顺路优先的口径不动）；
 *  · 攻略（真人玩法）模式不参与，主题序照旧；
 *  · 显式偏好（生成页勾选的）仍是主声部，画像只是隐式的加成/减分。
 */
import type { CityPassport } from '@/types'

export type TasteTag = 'nature' | 'history' | 'city' | 'family'

export const TASTE_LABELS: Record<TasteTag, string> = {
  nature: '山水自然',
  history: '历史人文',
  city: '都市打卡',
  family: '亲子场馆'
}

export interface Taste {
  /** 每维权重：正 = 偏爱（评分高/心心念念），负 = 踩过雷（评分 ≤2） */
  weights: Record<TasteTag, number>
  /** 能贡献信号的有效足迹数（城市在标签表里才算数） */
  sample: number
  /** 一句话简述，空串 = 没有可说的画像（UI 不展示） */
  brief: string
}

/**
 * 知名城市 → 兴趣标签。只标注「定位明确」的城市，拿不准的不标
 * （未标注的城市对画像不贡献、也不算样本）。
 */
export const CITY_TAGS: Record<string, TasteTag[]> = {
  // 山水
  桂林: ['nature'],
  九寨沟: ['nature'],
  峨眉山: ['nature'],
  黄山: ['nature'],
  香格里拉: ['nature'],
  大理: ['nature'],
  昆明: ['nature'],
  西双版纳: ['nature'],
  丽江: ['nature', 'history'],
  杭州: ['nature', 'city'],
  兰州: ['nature'],
  西宁: ['nature'],
  乌鲁木齐: ['nature'],
  贵阳: ['nature'],
  南宁: ['nature'],
  济南: ['nature'],
  福州: ['nature'],
  // 人文
  北京: ['history'],
  西安: ['history'],
  南京: ['history'],
  洛阳: ['history'],
  苏州: ['history', 'nature'],
  拉萨: ['history'],
  澳门: ['history'],
  南昌: ['history'],
  郑州: ['history'],
  沈阳: ['history'],
  太原: ['history'],
  // 都市
  上海: ['city'],
  深圳: ['city'],
  广州: ['city', 'family'],
  重庆: ['city'],
  天津: ['city'],
  香港: ['city'],
  台北: ['city'],
  合肥: ['city'],
  长沙: ['city', 'family'],
  // 亲子/海滨度假
  成都: ['family', 'nature'],
  三亚: ['nature', 'family'],
  厦门: ['nature', 'city'],
  青岛: ['nature', 'city'],
  大连: ['nature', 'city'],
  海口: ['nature', 'family'],
  珠海: ['nature', 'family']
}

/** POI 名 → 兴趣标签（关键词推断，城市内/在线库通用； indoor 同款「一把尺子」思路） */
const NAME_HINTS: [TasteTag, string[]][] = [
  [
    'nature',
    ['山', '湖', '海', '江', '河', '溪', '泉', '潭', '谷', '峡', '峰', '瀑', '湿地', '森林', '地质', '岛', '洲', '草原', '沙漠', '公园', '水库', '竹']
  ],
  [
    'history',
    ['博物馆', '纪念', '遗址', '古城', '古镇', '寺', '塔', '庙', '祠', '陵', '石窟', '故居', '城墙', '钟楼', '鼓楼', '书院', '宫廷', '王府']
  ],
  [
    'city',
    ['外滩', '环岛', '中心', '环球', '天台', '广场', '步行街', '太古', '万象', '天街', 'SKP', 'CBD', '国金', '金茂', '之眼']
  ],
  [
    'family',
    ['海洋', '海底', '动物园', '乐园', '游乐园', '水世界', '水上', '熊猫', '科技馆', '恐龙', '亲子', '儿童', '迪士尼', '长隆', '乐高']
  ]
]

export function poiTasteTags(name: string): TasteTag[] {
  const out: TasteTag[] = []
  for (const [tag, kws] of NAME_HINTS) {
    if (kws.some((k) => name.includes(k))) out.push(tag)
  }
  return out
}

/** 足迹 → 画像：温和正样本（到访/想去/4 分起）+ 负样本（≤2 分的雷） */
export function computeTaste(passports: CityPassport[]): Taste {
  const weights = { nature: 0, history: 0, city: 0, family: 0 } as Record<TasteTag, number>
  let sample = 0
  for (const p of passports || []) {
    const tags = CITY_TAGS[p.name]
    if (!tags || !tags.length || !p.name) continue
    // 到访本身即温和正样本；评分把幅度拉开；≤2 分是雷；心愿单是轻量正样本
    let w = 0.75
    if (p.status === 'wish') w = 0.5
    else if (typeof p.rating === 'number' && p.rating > 0) {
      if (p.rating >= 5) w = 2
      else if (p.rating >= 4) w = 1
      else if (p.rating <= 2) w = -1.25
      else w = 0.5 // 3 分：中性偏温
    }
    for (const t of tags) weights[t] += w
    sample += 1
  }

  // 只有画像「有结论」再写 UI 文案（lead 维度 ± 踩雷维度）
  const briefParts: string[] = []
  if (sample >= 2) {
    const like = (Object.keys(weights) as TasteTag[])
      .filter((t) => weights[t] >= 2)
      .sort((a, b) => weights[b] - weights[a])
      .map((t) => TASTE_LABELS[t])
    const dislike = (Object.keys(weights) as TasteTag[])
      .filter((t) => weights[t] <= -2)
      .map((t) => TASTE_LABELS[t])
    if (like.length) briefParts.push(`偏爱${like.slice(0, 2).join('、')}`)
    if (dislike.length) briefParts.push(`弱化${dislike.slice(0, 2).join('、')}`)
  }

  return {
    weights,
    sample,
    brief: briefParts.join(' · ') + (briefParts.length && sample ? `（来自 ${sample} 城足迹）` : '')
  }
}

/** POI 打分用的加成：±4 封顶、温和系数 0.9，只对景点生效（餐饮本就不进行程） */
export function tasteBoost(poi: { name: string; type?: string }, taste?: Taste | null): number {
  if (!taste || taste.sample < 2 || (poi.type && poi.type !== 'spot')) return 0
  let s = 0
  for (const tag of poiTasteTags(poi.name)) s += (taste.weights[tag] ?? 0) * 0.9
  return Math.max(-4, Math.min(4, s))
}
