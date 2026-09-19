/**
 * 主要城市中心点坐标（高德 gcj-02）。
 * 用途：
 *   1) 城市足迹地图初次打点，免网络即刻显示；
 *   2) 离线兜底——高德 key 未配或请求失败时，仍能用这张表落点。
 * 表中缺失的城市会在运行时通过 amap.geocode 解析坐标。
 * 坐标为城市中心近似值，仅供「足迹」级别定位，非精确 POI。
 */
export interface CityGeo {
  lat: number
  lng: number
}

export const CITY_GEO: Record<string, CityGeo> = {
  北京: { lat: 39.908, lng: 116.397 },
  上海: { lat: 31.23, lng: 121.473 },
  广州: { lat: 23.129, lng: 113.264 },
  深圳: { lat: 22.543, lng: 114.057 },
  成都: { lat: 30.572, lng: 104.066 },
  重庆: { lat: 29.563, lng: 106.551 },
  杭州: { lat: 30.274, lng: 120.155 },
  西安: { lat: 34.263, lng: 108.948 },
  武汉: { lat: 30.593, lng: 114.305 },
  南京: { lat: 32.06, lng: 118.797 },
  苏州: { lat: 31.299, lng: 120.619 },
  天津: { lat: 39.125, lng: 117.19 },
  长沙: { lat: 28.228, lng: 112.938 },
  青岛: { lat: 36.067, lng: 120.382 },
  厦门: { lat: 24.479, lng: 118.089 },
  昆明: { lat: 24.88, lng: 102.833 },
  大理: { lat: 25.606, lng: 100.267 },
  丽江: { lat: 26.872, lng: 100.233 },
  三亚: { lat: 18.252, lng: 109.511 },
  桂林: { lat: 25.274, lng: 110.299 },
  拉萨: { lat: 29.644, lng: 91.114 },
  哈尔滨: { lat: 45.756, lng: 126.642 },
  沈阳: { lat: 41.805, lng: 123.431 },
  大连: { lat: 38.914, lng: 121.618 },
  济南: { lat: 36.651, lng: 117.0 },
  郑州: { lat: 34.746, lng: 113.625 },
  合肥: { lat: 31.821, lng: 117.227 },
  福州: { lat: 26.074, lng: 119.296 },
  南昌: { lat: 28.683, lng: 115.858 },
  贵阳: { lat: 26.578, lng: 106.713 },
  南宁: { lat: 22.817, lng: 108.367 },
  海口: { lat: 20.044, lng: 110.199 },
  太原: { lat: 37.857, lng: 112.549 },
  石家庄: { lat: 38.042, lng: 114.514 },
  兰州: { lat: 36.061, lng: 103.834 },
  西宁: { lat: 36.617, lng: 101.778 },
  银川: { lat: 38.487, lng: 106.232 },
  乌鲁木齐: { lat: 43.792, lng: 87.617 },
  呼和浩特: { lat: 40.842, lng: 111.751 },
  香港: { lat: 22.32, lng: 114.173 },
  澳门: { lat: 22.198, lng: 113.549 },
  台北: { lat: 25.033, lng: 121.565 },
  香格里拉: { lat: 27.827, lng: 99.707 },
  九寨沟: { lat: 33.26, lng: 103.918 },
  峨眉山: { lat: 29.517, lng: 103.337 },
  黄山: { lat: 30.131, lng: 118.34 },
  张家界: { lat: 29.117, lng: 110.479 },
  凤凰古城: { lat: 27.948, lng: 109.598 },
  婺源: { lat: 29.263, lng: 117.853 }
}

/** 常见别名 -> 标准城市名，便于用户输入「蓉城」「杭州市」等也能命中 */
export const CITY_ALIAS: Record<string, string> = {
  cd: '成都',
  chengdu: '成都',
  蓉城: '成都',
  杭州市: '杭州',
  杭城: '杭州',
  西安市: '西安',
  长安: '西安',
  xian: '西安',
  重庆市: '重庆',
  山城: '重庆',
  cq: '重庆',
  渝: '重庆',
  武汉市: '武汉',
  羊城: '广州',
  穗: '广州',
  鹏城: '深圳',
  昆明市: '昆明',
  春城: '昆明',
  dl: '大理',
  鹭岛: '厦门',
  xm: '厦门',
  椰城: '海口',
  鹿城: '三亚'
}

export function resolveCityName(input: string): string {
  const q = (input || '').trim()
  if (!q) return ''
  if (CITY_GEO[q]) return q
  const lower = q.toLowerCase()
  if (CITY_ALIAS[lower]) return CITY_ALIAS[lower]
  if (CITY_ALIAS[q]) return CITY_ALIAS[q]
  // 去掉「市」「省」等后缀再试一次
  const stripped = q.replace(/(市|省|自治区|特别行政区|地区|自治州)$/g, '')
  if (CITY_GEO[stripped]) return stripped
  return q
}
