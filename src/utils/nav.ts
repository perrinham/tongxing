/**
 * 小程序导航助手：替代 vue-router。
 * uni-app 没有 vue-router，路由全部走 uni 的页面 API。
 * 页面路径与 src/pages.json 中的 path 一一对应（不带扩展名）。
 */
export const ROUTES: Record<string, string> = {
  welcome: '/pages/WelcomePage',
  itinerary: '/pages/ItineraryPage',
  expense: '/pages/ExpensePage',
  settle: '/pages/SettlePage',
  profile: '/pages/ProfilePage',
  'trip-create': '/pages/TripCreatePage',
  'trip-generate': '/pages/TripGeneratePage',
  'expense-edit': '/pages/ExpenseEditPage',
  'item-edit': '/pages/ItemEditPage',
  'trip-members': '/pages/MembersPage',
  map: '/pages/MapPage',
  'city-map': '/pages/CityMapPage',
  'my-guides': '/pages/MyGuidesPage',
  sync: '/pages/SyncPage',
  discover: '/pages/DiscoverPage',
  'trip-view': '/pages/TripViewPage'
}

type RouteName = keyof typeof ROUTES | string

function withQuery(path: string, params?: Record<string, string | number>): string {
  if (!params || !Object.keys(params).length) return path
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${path}?${q}`
}

function resolve(name: RouteName): string {
  return ROUTES[name] ?? (name as string)
}

export const nav = {
  /** 打开新页面（保留返回栈） */
  to(name: RouteName, params?: Record<string, string | number>) {
    uni.navigateTo({ url: withQuery(resolve(name), params) })
  },
  /** 替换当前页面（无返回） */
  replace(name: RouteName, params?: Record<string, string | number>) {
    uni.redirectTo({ url: withQuery(resolve(name), params) })
  },
  /** 重启到某页（清空返回栈，用于 tab 切换 / 回首页） */
  reLaunch(name: RouteName, params?: Record<string, string | number>) {
    uni.reLaunch({ url: withQuery(resolve(name), params) })
  },
  /** 返回上一页 */
  back(delta = 1) {
    uni.navigateBack({ delta })
  }
}
