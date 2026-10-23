import type { ItemType } from '@/types'

export interface PoiSeed {
  name: string
  type: ItemType
  lng: number
  lat: number
  /** 建议停留分钟 */
  duration: number
  /** 每人预估花费 */
  cost: number
  best?: 'morning' | 'afternoon' | 'evening' | 'night' | 'any'
  /** 室内点位（雨天优先排前的依据）；缺省按名字推断，见 utils/indoor.ts */
  indoor?: boolean
  /** 远郊，单独占一天 */
  dayTrip?: boolean
  area: string
  address?: string
  /** 高德评分（在线库专用，0-5），用于排序加权 */
  rating?: number
}

export interface CitySeed {
  name: string
  /** 别名，用于匹配用户输入 */
  alias: string[]
  intro: string
  pois: PoiSeed[]
}

export const CITIES: CitySeed[] = [
  {
    name: '成都',
    alias: ['chengdu', 'cd', '蓉城'],
    intro: '慢节奏、重烟火。市内景点密集，远郊有都江堰青城山可以拉满一整天。',
    pois: [
      { name: '大熊猫繁育研究基地', type: 'spot', lng: 104.1455, lat: 30.7333, duration: 180, cost: 55, best: 'morning', area: '成华·北郊', address: '成华区熊猫大道1375号' },
      { name: '宽窄巷子', type: 'spot', lng: 104.0555, lat: 30.6699, duration: 90, cost: 0, best: 'afternoon', area: '青羊·天府广场' },
      { name: '锦里古街', type: 'spot', lng: 104.0363, lat: 30.6448, duration: 90, cost: 0, best: 'evening', area: '武侯·武侯祠' },
      { name: '武侯祠', type: 'spot', lng: 104.0357, lat: 30.6457, duration: 90, cost: 50, best: 'afternoon', area: '武侯·武侯祠' },
      { name: '杜甫草堂', type: 'spot', lng: 104.0217, lat: 30.6637, duration: 90, cost: 50, best: 'morning', area: '青羊·草堂' },
      { name: '人民公园', type: 'spot', lng: 104.0595, lat: 30.664, duration: 90, cost: 0, best: 'afternoon', area: '青羊·天府广场' },
      { name: '文殊院', type: 'spot', lng: 104.072, lat: 30.675, duration: 60, cost: 0, best: 'morning', area: '青羊·文殊院' },
      { name: '太古里', type: 'spot', lng: 104.0826, lat: 30.6527, duration: 90, cost: 0, best: 'afternoon', area: '锦江·春熙路' },
      { name: '春熙路', type: 'spot', lng: 104.081, lat: 30.657, duration: 60, cost: 0, best: 'afternoon', area: '锦江·春熙路' },
      { name: '青羊宫', type: 'spot', lng: 104.035, lat: 30.669, duration: 60, cost: 10, best: 'morning', area: '青羊·草堂' },
      { name: '四川博物院', type: 'spot', lng: 104.024, lat: 30.666, duration: 120, cost: 0, best: 'afternoon', area: '青羊·草堂' },
      { name: '天府广场', type: 'spot', lng: 104.065, lat: 30.657, duration: 30, cost: 0, area: '青羊·天府广场' },
      { name: '九眼桥', type: 'spot', lng: 104.089, lat: 30.639, duration: 90, cost: 0, best: 'night', area: '锦江·九眼桥' },
      { name: '安顺廊桥', type: 'spot', lng: 104.083, lat: 30.644, duration: 45, cost: 0, best: 'night', area: '锦江·九眼桥' },
      { name: '望平街', type: 'spot', lng: 104.09, lat: 30.662, duration: 60, cost: 0, best: 'night', area: '成华·猛追湾' },
      { name: '东郊记忆', type: 'spot', lng: 104.141, lat: 30.669, duration: 120, cost: 0, best: 'afternoon', area: '成华·东郊' },
      { name: '奎星楼街', type: 'spot', lng: 104.057, lat: 30.672, duration: 60, cost: 0, best: 'evening', area: '青羊·宽窄' },
      { name: '环球中心', type: 'spot', lng: 104.064, lat: 30.576, duration: 120, cost: 0, best: 'afternoon', area: '高新·天府大道' },
      { name: '都江堰景区', type: 'spot', lng: 103.618, lat: 31.002, duration: 300, cost: 80, best: 'morning', dayTrip: true, area: '都江堰' },
      { name: '青城山', type: 'spot', lng: 103.568, lat: 30.902, duration: 300, cost: 80, best: 'morning', dayTrip: true, area: '都江堰' },
      { name: '陈麻婆豆腐（总店）', type: 'food', lng: 104.075, lat: 30.669, duration: 60, cost: 60, best: 'evening', area: '青羊·骡马市' },
      { name: '蜀九香火锅', type: 'food', lng: 104.08, lat: 30.66, duration: 90, cost: 100, best: 'evening', area: '锦江·春熙路' },
      { name: '建设巷小吃街', type: 'food', lng: 104.103, lat: 30.669, duration: 60, cost: 40, best: 'night', area: '成华·建设路' },
      { name: '玉林串串香', type: 'food', lng: 104.059, lat: 30.63, duration: 90, cost: 70, best: 'night', area: '武侯·玉林' }
    ]
  },
  {
    name: '西安',
    alias: ['xian', 'xa', '长安', '西安市'],
    intro: '一天城墙内，一天曲江，一天临潼兵马俑。历史密度极高。',
    pois: [
      { name: '秦始皇兵马俑', type: 'spot', lng: 109.2785, lat: 34.3841, duration: 180, cost: 120, best: 'morning', dayTrip: true, area: '临潼' },
      { name: '华清宫', type: 'spot', lng: 109.2137, lat: 34.3619, duration: 150, cost: 120, best: 'afternoon', dayTrip: true, area: '临潼' },
      { name: '骊山', type: 'spot', lng: 109.226, lat: 34.366, duration: 150, cost: 70, best: 'afternoon', dayTrip: true, area: '临潼' },
      { name: '华山', type: 'spot', lng: 110.084, lat: 34.487, duration: 480, cost: 160, best: 'morning', dayTrip: true, area: '华山' },
      { name: '陕西历史博物馆', type: 'spot', lng: 108.948, lat: 34.2255, duration: 180, cost: 0, best: 'morning', area: '雁塔·小寨' },
      { name: '大雁塔', type: 'spot', lng: 108.964, lat: 34.2186, duration: 90, cost: 50, best: 'afternoon', area: '雁塔·曲江' },
      { name: '大唐不夜城', type: 'spot', lng: 108.959, lat: 34.2178, duration: 120, cost: 0, best: 'night', area: '雁塔·曲江' },
      { name: '大唐芙蓉园', type: 'spot', lng: 108.982, lat: 34.22, duration: 150, cost: 120, best: 'evening', area: '雁塔·曲江' },
      { name: '曲江池遗址公园', type: 'spot', lng: 108.974, lat: 34.201, duration: 90, cost: 0, best: 'afternoon', area: '雁塔·曲江' },
      { name: '西安城墙·永宁门', type: 'spot', lng: 108.9451, lat: 34.2515, duration: 120, cost: 54, best: 'afternoon', area: '碑林·南门' },
      { name: '碑林博物馆', type: 'spot', lng: 108.949, lat: 34.254, duration: 90, cost: 65, best: 'morning', area: '碑林·南门' },
      { name: '钟楼', type: 'spot', lng: 108.947, lat: 34.261, duration: 45, cost: 30, best: 'evening', area: '碑林·钟楼' },
      { name: '鼓楼', type: 'spot', lng: 108.943, lat: 34.2625, duration: 45, cost: 30, best: 'evening', area: '莲湖·钟楼' },
      { name: '高家大院', type: 'spot', lng: 108.942, lat: 34.264, duration: 60, cost: 30, best: 'afternoon', area: '莲湖·回民街' },
      { name: '化觉巷清真大寺', type: 'spot', lng: 108.939, lat: 34.265, duration: 45, cost: 25, best: 'afternoon', area: '莲湖·回民街' },
      { name: '小雁塔', type: 'spot', lng: 108.928, lat: 34.245, duration: 60, cost: 0, best: 'morning', area: '碑林·小雁塔' },
      { name: '大明宫国家遗址公园', type: 'spot', lng: 108.972, lat: 34.299, duration: 120, cost: 60, best: 'morning', area: '新城·大明宫' },
      { name: '汉城湖', type: 'spot', lng: 108.925, lat: 34.302, duration: 90, cost: 0, best: 'afternoon', area: '未央·汉城湖' },
      { name: '白鹿原影视城', type: 'spot', lng: 109.1, lat: 34.15, duration: 240, cost: 120, best: 'morning', dayTrip: true, area: '蓝田' },
      { name: '回民街', type: 'food', lng: 108.941, lat: 34.2632, duration: 90, cost: 60, best: 'evening', area: '莲湖·回民街' },
      { name: '永兴坊', type: 'food', lng: 108.959, lat: 34.268, duration: 90, cost: 60, best: 'evening', area: '新城·中山门' },
      { name: '洒金桥', type: 'food', lng: 108.933, lat: 34.265, duration: 60, cost: 35, best: 'morning', area: '莲湖·洒金桥' },
      { name: '老孙家泡馍', type: 'food', lng: 108.945, lat: 34.262, duration: 60, cost: 50, best: 'any', area: '碑林·钟楼' },
      { name: '长安大牌档', type: 'food', lng: 108.96, lat: 34.22, duration: 90, cost: 80, best: 'evening', area: '雁塔·曲江' }
    ]
  },
  {
    name: '大理',
    alias: ['dali', 'dl', '大理市'],
    intro: '环洱海是主线。适合慢下来，一天跑两三个点就够。',
    pois: [
      { name: '大理古城', type: 'spot', lng: 100.167, lat: 25.693, duration: 150, cost: 0, best: 'afternoon', area: '古城' },
      { name: '洱海生态廊道', type: 'spot', lng: 100.19, lat: 25.68, duration: 180, cost: 0, best: 'morning', area: '洱海西' },
      { name: '崇圣寺三塔', type: 'spot', lng: 100.148, lat: 25.702, duration: 120, cost: 75, best: 'morning', area: '古城·苍山' },
      { name: '苍山感通索道', type: 'spot', lng: 100.14, lat: 25.66, duration: 240, cost: 130, best: 'morning', area: '古城·苍山' },
      { name: '喜洲古镇', type: 'spot', lng: 100.137, lat: 25.856, duration: 180, cost: 0, best: 'afternoon', area: '喜洲' },
      { name: '海舌生态公园', type: 'spot', lng: 100.147, lat: 25.87, duration: 90, cost: 0, best: 'afternoon', area: '喜洲' },
      { name: '蝴蝶泉', type: 'spot', lng: 100.153, lat: 25.859, duration: 90, cost: 40, best: 'afternoon', area: '喜洲' },
      { name: '双廊古镇', type: 'spot', lng: 100.2, lat: 25.91, duration: 180, cost: 0, best: 'afternoon', area: '双廊' },
      { name: '小普陀', type: 'spot', lng: 100.223, lat: 25.86, duration: 60, cost: 0, best: 'afternoon', area: '挖色' },
      { name: '挖色镇', type: 'spot', lng: 100.213, lat: 25.816, duration: 90, cost: 0, best: 'afternoon', area: '挖色' },
      { name: '才村码头', type: 'spot', lng: 100.174, lat: 25.679, duration: 90, cost: 0, best: 'evening', area: '洱海西' },
      { name: '龙龛码头', type: 'spot', lng: 100.183, lat: 25.664, duration: 90, cost: 0, best: 'morning', area: '洱海西' },
      { name: '磻溪村 S 湾', type: 'spot', lng: 100.129, lat: 25.81, duration: 90, cost: 0, best: 'morning', area: '喜洲' },
      { name: '大理床单厂艺术区', type: 'spot', lng: 100.162, lat: 25.69, duration: 60, cost: 0, best: 'afternoon', area: '古城' },
      { name: '龙尾关', type: 'spot', lng: 100.149, lat: 25.635, duration: 60, cost: 0, best: 'morning', area: '下关' },
      { name: '兴盛大桥', type: 'spot', lng: 100.183, lat: 25.61, duration: 45, cost: 0, best: 'night', area: '下关' },
      { name: '沙溪古镇', type: 'spot', lng: 99.851, lat: 26.317, duration: 300, cost: 0, best: 'morning', dayTrip: true, area: '剑川' },
      { name: '段公子餐厅', type: 'food', lng: 100.166, lat: 25.695, duration: 90, cost: 60, best: 'evening', area: '古城' },
      { name: '酸辣鱼农家菜', type: 'food', lng: 100.14, lat: 25.85, duration: 90, cost: 50, best: 'any', area: '喜洲' },
      { name: '古城烤乳扇摊', type: 'food', lng: 100.165, lat: 25.692, duration: 45, cost: 25, best: 'night', area: '古城' }
    ]
  },
  {
    name: '厦门',
    alias: ['xiamen', 'xm', '鹭岛'],
    intro: '岛内紧凑，鼓浪屿和集美需要单独安排半天到一天。',
    pois: [
      { name: '鼓浪屿', type: 'spot', lng: 118.067, lat: 24.447, duration: 300, cost: 100, best: 'morning', area: '鼓浪屿' },
      { name: '日光岩', type: 'spot', lng: 118.07, lat: 24.443, duration: 60, cost: 50, best: 'morning', area: '鼓浪屿' },
      { name: '菽庄花园', type: 'spot', lng: 118.065, lat: 24.442, duration: 60, cost: 30, best: 'afternoon', area: '鼓浪屿' },
      { name: '南普陀寺', type: 'spot', lng: 118.1, lat: 24.443, duration: 90, cost: 0, best: 'morning', area: '思明·厦大' },
      { name: '厦门大学', type: 'spot', lng: 118.096, lat: 24.438, duration: 90, cost: 0, best: 'afternoon', area: '思明·厦大' },
      { name: '曾厝垵', type: 'spot', lng: 118.129, lat: 24.429, duration: 120, cost: 0, best: 'night', area: '思明·环岛路' },
      { name: '环岛路', type: 'spot', lng: 118.14, lat: 24.43, duration: 120, cost: 0, best: 'afternoon', area: '思明·环岛路' },
      { name: '椰风寨', type: 'spot', lng: 118.16, lat: 24.428, duration: 90, cost: 0, best: 'afternoon', area: '思明·环岛路' },
      { name: '沙坡尾', type: 'spot', lng: 118.085, lat: 24.443, duration: 90, cost: 0, best: 'night', area: '思明·沙坡尾' },
      { name: '猫街', type: 'spot', lng: 118.085, lat: 24.442, duration: 45, cost: 0, best: 'afternoon', area: '思明·沙坡尾' },
      { name: '演武大桥观景台', type: 'spot', lng: 118.089, lat: 24.432, duration: 45, cost: 0, best: 'night', area: '思明·厦大' },
      { name: '中山路步行街', type: 'spot', lng: 118.082, lat: 24.452, duration: 120, cost: 0, best: 'evening', area: '思明·中山路' },
      { name: '第八市场', type: 'spot', lng: 118.078, lat: 24.456, duration: 90, cost: 0, best: 'morning', area: '思明·中山路' },
      { name: '园林植物园', type: 'spot', lng: 118.108, lat: 24.451, duration: 150, cost: 30, best: 'morning', area: '思明·万石山' },
      { name: '钟鼓索道', type: 'spot', lng: 118.102, lat: 24.448, duration: 60, cost: 70, best: 'afternoon', area: '思明·万石山' },
      { name: '五缘湾湿地公园', type: 'spot', lng: 118.17, lat: 24.535, duration: 120, cost: 0, best: 'afternoon', area: '湖里·五缘湾' },
      { name: '集美学村', type: 'spot', lng: 118.098, lat: 24.568, duration: 150, cost: 0, best: 'morning', dayTrip: true, area: '集美' },
      { name: '园博苑', type: 'spot', lng: 118.06, lat: 24.59, duration: 180, cost: 60, best: 'morning', dayTrip: true, area: '集美' },
      { name: '黄则和花生汤', type: 'food', lng: 118.08, lat: 24.453, duration: 45, cost: 20, best: 'morning', area: '思明·中山路' },
      { name: '局口拌面', type: 'food', lng: 118.081, lat: 24.452, duration: 45, cost: 20, best: 'any', area: '思明·中山路' }
    ]
  },
  {
    name: '三亚',
    alias: ['sanya', 'sy', '鹿城'],
    intro: '海湾各自成片，选一个湾住下来，每天往一个方向玩。',
    pois: [
      { name: '亚龙湾', type: 'spot', lng: 109.64, lat: 18.227, duration: 240, cost: 0, best: 'morning', area: '亚龙湾' },
      { name: '亚龙湾热带天堂森林公园', type: 'spot', lng: 109.655, lat: 18.24, duration: 180, cost: 158, best: 'morning', area: '亚龙湾' },
      { name: '大东海', type: 'spot', lng: 109.515, lat: 18.226, duration: 180, cost: 0, best: 'afternoon', area: '大东海' },
      { name: '三亚湾椰梦长廊', type: 'spot', lng: 109.49, lat: 18.265, duration: 120, cost: 0, best: 'evening', area: '三亚湾' },
      { name: '鹿回头公园', type: 'spot', lng: 109.501, lat: 18.219, duration: 90, cost: 42, best: 'evening', area: '大东海' },
      { name: '天涯海角', type: 'spot', lng: 109.347, lat: 18.298, duration: 150, cost: 81, best: 'afternoon', area: '三亚湾西' },
      { name: '南山文化旅游区', type: 'spot', lng: 109.19, lat: 18.308, duration: 240, cost: 129, best: 'morning', dayTrip: true, area: '崖州' },
      { name: '大小洞天', type: 'spot', lng: 109.156, lat: 18.311, duration: 180, cost: 90, best: 'afternoon', dayTrip: true, area: '崖州' },
      { name: '崖州古城', type: 'spot', lng: 109.172, lat: 18.362, duration: 120, cost: 0, best: 'afternoon', dayTrip: true, area: '崖州' },
      { name: '蜈支洲岛', type: 'spot', lng: 109.762, lat: 18.313, duration: 300, cost: 168, best: 'morning', dayTrip: true, area: '海棠湾' },
      { name: '后海村', type: 'spot', lng: 109.72, lat: 18.313, duration: 150, cost: 0, best: 'afternoon', area: '海棠湾' },
      { name: '亚特兰蒂斯水世界', type: 'spot', lng: 109.71, lat: 18.308, duration: 300, cost: 418, best: 'morning', dayTrip: true, area: '海棠湾' },
      { name: '西岛', type: 'spot', lng: 109.379, lat: 18.24, duration: 240, cost: 98, best: 'morning', dayTrip: true, area: '三亚湾西' },
      { name: '千古情景区', type: 'spot', lng: 109.618, lat: 18.293, duration: 240, cost: 300, best: 'evening', area: '海棠湾' },
      { name: '第一市场', type: 'food', lng: 109.505, lat: 18.246, duration: 90, cost: 0, best: 'evening', area: '大东海' },
      { name: '海鲜大排档', type: 'food', lng: 109.498, lat: 18.24, duration: 120, cost: 150, best: 'night', area: '大东海' },
      { name: '商品街夜市', type: 'food', lng: 109.51, lat: 18.253, duration: 90, cost: 50, best: 'night', area: '大东海' },
      { name: '抱罗粉老店', type: 'food', lng: 109.506, lat: 18.25, duration: 45, cost: 25, best: 'morning', area: '大东海' }
    ]
  },
  {
    name: '重庆',
    alias: ['chongqing', 'cq', '山城', '渝'],
    intro: '立体城市，景点集中但爬坡多。夜景是重头戏。',
    pois: [
      { name: '洪崖洞', type: 'spot', lng: 106.583, lat: 29.565, duration: 90, cost: 0, best: 'night', area: '渝中·解放碑' },
      { name: '解放碑', type: 'spot', lng: 106.577, lat: 29.558, duration: 60, cost: 0, best: 'evening', area: '渝中·解放碑' },
      { name: '长江索道', type: 'spot', lng: 106.59, lat: 29.564, duration: 60, cost: 30, best: 'afternoon', area: '渝中·小什字' },
      { name: '朝天门来福士', type: 'spot', lng: 106.588, lat: 29.567, duration: 90, cost: 0, best: 'night', area: '渝中·朝天门' },
      { name: '山城步道', type: 'spot', lng: 106.562, lat: 29.557, duration: 90, cost: 0, best: 'morning', area: '渝中·七星岗' },
      { name: '十八梯', type: 'spot', lng: 106.572, lat: 29.552, duration: 90, cost: 0, best: 'afternoon', area: '渝中·较场口' },
      { name: '白象居', type: 'spot', lng: 106.586, lat: 29.559, duration: 60, cost: 0, best: 'afternoon', area: '渝中·白象街' },
      { name: '皇冠大扶梯', type: 'spot', lng: 106.548, lat: 29.554, duration: 30, cost: 2, best: 'morning', area: '渝中·两路口' },
      { name: '中山四路', type: 'spot', lng: 106.557, lat: 29.559, duration: 60, cost: 0, best: 'afternoon', area: '渝中·上清寺' },
      { name: '三峡博物馆', type: 'spot', lng: 106.552, lat: 29.562, duration: 150, cost: 0, best: 'morning', area: '渝中·上清寺' },
      { name: '磁器口古镇', type: 'spot', lng: 106.449, lat: 29.582, duration: 150, cost: 0, best: 'afternoon', area: '沙坪坝' },
      { name: '李子坝轻轨站', type: 'spot', lng: 106.524, lat: 29.554, duration: 45, cost: 0, best: 'morning', area: '渝中·李子坝' },
      { name: '鹅岭二厂', type: 'spot', lng: 106.539, lat: 29.553, duration: 90, cost: 0, best: 'afternoon', area: '渝中·鹅岭' },
      { name: '南山一棵树', type: 'spot', lng: 106.597, lat: 29.535, duration: 90, cost: 30, best: 'night', area: '南岸' },
      { name: '弹子石老街', type: 'spot', lng: 106.593, lat: 29.573, duration: 90, cost: 0, best: 'night', area: '南岸·弹子石' },
      { name: '武隆天生三桥', type: 'spot', lng: 107.82, lat: 29.41, duration: 360, cost: 135, best: 'morning', dayTrip: true, area: '武隆' },
      { name: '珮姐老火锅', type: 'food', lng: 106.579, lat: 29.559, duration: 120, cost: 120, best: 'evening', area: '渝中·解放碑' },
      { name: '花市豌杂面', type: 'food', lng: 106.572, lat: 29.562, duration: 45, cost: 20, best: 'morning', area: '渝中·较场口' }
    ]
  }
]

/** 按名称或别名模糊匹配城市，匹配失败时回退到第一个城市 */
export function matchCity(input: string): CitySeed {
  const q = (input || '').trim().toLowerCase()
  if (!q) return CITIES[0]
  const exact = CITIES.find(
    (c) => c.name === input.trim() || c.alias.some((a) => a === q)
  )
  if (exact) return exact
  const loose = CITIES.find(
    (c) => input.includes(c.name) || c.alias.some((a) => q.includes(a))
  )
  if (loose) return loose
  return CITIES[0]
}

export function isKnownCity(input: string): boolean {
  const q = (input || '').trim().toLowerCase()
  if (!q) return false
  return CITIES.some(
    (c) => c.name === input.trim() || c.alias.some((a) => q.includes(a) || a === q)
  )
}
