<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { walkingRoute, drivingRoute } from '@/services/amap'
import { AMAP_ENABLED } from '@/config'
import { shortDate, weekday, CANVAS_PALETTE, avatarColor, avatarInk } from '@/utils/format'
import type { ItineraryItem } from '@/types'
import AppNav from '@/components/AppNav.vue'

const store = useTripStore()

const dayId = ref('')
const mode = ref<'walking' | 'driving'>('walking')
const polyline = ref<{ points: { latitude: number; longitude: number }[]; color: string; width: number; arrowLine: boolean }[]>([])
const routeDist = ref(0)
const routeDur = ref(0)
const routing = ref(false)

const trip = computed(() => store.activeTrip)
const day = computed(() => {
  if (!trip.value) return null
  if (dayId.value) return store.daysOf(trip.value.id).find((d) => d.id === dayId.value) || null
  return store.daysOf(trip.value.id)[0] || null
})

const geoItems = computed(() => {
  if (!day.value) return []
  return store.itemsOfDay(day.value.id).filter((i) => i.lat && i.lng)
})

/** 集合点与共享中的成员位置（叠加在当日行程点之上） */
const meetup = computed(() => (trip.value ? store.meetupOf(trip.value.id) : null))
const memberLocs = computed(() => {
  if (!trip.value) return []
  const members = store.membersOf(trip.value.id)
  return store.memberLocationsOf(trip.value.id).map((loc) => ({
    loc,
    member: members.find((m) => m.id === loc.memberId)
  }))
})

/** marker 点击的载荷：按 marker 顺序对应，点谁开谁的 openLocation */
const markerActs = computed(() => {
  const acts: (
    | { kind: 'item'; it: ItineraryItem }
    | { kind: 'meetup'; name: string; address: string; lat: number; lng: number }
    | { kind: 'member'; name: string; colorIndex: number; lat: number; lng: number }
  )[] = geoItems.value.map((it) => ({ kind: 'item', it }))
  if (meetup.value) {
    acts.push({
      kind: 'meetup',
      name: meetup.value.title,
      address: meetup.value.address,
      lat: meetup.value.lat,
      lng: meetup.value.lng
    })
  }
  for (const ml of memberLocs.value) {
    acts.push({
      kind: 'member',
      name: ml.member?.name || '成员',
      colorIndex: ml.member?.colorIndex ?? 0,
      lat: ml.loc.lat,
      lng: ml.loc.lng
    })
  }
  return acts
})

const center = computed(() => {
  const it = geoItems.value[0] ?? (meetup.value ? { lat: meetup.value.lat, lng: meetup.value.lng } : null) ??
    (memberLocs.value[0] ? { lat: memberLocs.value[0].loc.lat, lng: memberLocs.value[0].loc.lng } : null)
  return it ? { latitude: it.lat, longitude: it.lng } : { latitude: 34.0, longitude: 108.0 }
})

/** 地图 label 文字：与 AppAvatar 同规则（中文末字 / 英文首字母），限 4 字 */
function labelNameOf(name: string): string {
  const n = (name || '?').trim()
  if (!n) return '?'
  const s = /[\u4e00-\u9fa5]/.test(n) ? n.slice(-1) : n.slice(0, 1).toUpperCase()
  return s.slice(0, 4)
}

const markers = computed(() => {
  let itemNo = 0
  return markerActs.value.map((a, i) => {
    const isItem = a.kind === 'item'
    /* 底色按 marker 类别取：行程点 = 品牌绿（序号），集合点 = 强调橙（「集合」），
       成员位置 = 各自头像色 + 名字，扫一眼能对上「同行的人」里的色块。
       序号标记：原来写死白字压品牌绿 = 3.18:1 —— 压在色块上的文字必须走
       avatarInk(底色)，和城市地图的 callout 用同一个机制，两处不再有两种写法。 */
    const bg = isItem
      ? CANVAS_PALETTE.brand
      : a.kind === 'meetup'
        ? CANVAS_PALETTE.accent
        : avatarColor(a.colorIndex)
    const content = isItem
      ? String((itemNo += 1))
      : a.kind === 'meetup'
        ? '集合'
        : labelNameOf(a.name)
    return {
      id: i,
      latitude: isItem ? a.it.lat : a.lat,
      longitude: isItem ? a.it.lng : a.lng,
      width: 22,
      height: 22,
      label: {
        content,
        color: avatarInk(bg),
        bgColor: bg,
        padding: 4,
        borderRadius: 8,
        textAlign: 'center' as const,
        anchorX: 0,
        anchorY: -26
      }
    }
  })
})

const summary = computed(() => {
  if (!routeDist.value) return '暂未规划路线'
  const d = routeDist.value < 1000 ? `${routeDist.value} 米` : `${(routeDist.value / 1000).toFixed(1)} 公里`
  const m = Math.round(routeDur.value / 60)
  const t = m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  return `${d} · 约 ${t}（${mode.value === 'walking' ? '步行' : '驾车'}）`
})

// 路线规划代数：switchMode / 刷新不看在途任务，步行→驾车连点时后发先至，
// 旧任务的慢响应晚回来会把新路线覆盖回旧结果。每个 await 后写回前先比对代数。
let routeSeq = 0

async function buildRoute() {
  const seq = ++routeSeq
  const pts = geoItems.value
  if (pts.length < 2 || !AMAP_ENABLED) {
    polyline.value = []
    routeDist.value = 0
    routeDur.value = 0
    return
  }
  routing.value = true
  try {
    const all: { latitude: number; longitude: number }[] = []
    let dist = 0
    let dur = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const a = { latitude: pts[i].lat, longitude: pts[i].lng }
      const b = { latitude: pts[i + 1].lat, longitude: pts[i + 1].lng }
      const r = mode.value === 'walking' ? await walkingRoute(a, b) : await drivingRoute(a, b)
      if (seq !== routeSeq) return // 已有更新的规划在途：本任务作废，什么都不写回
      if (r) {
        dist += r.distance
        dur += r.duration
        if (!all.length) all.push(...r.points)
        else all.push(...r.points.slice(1))
      }
    }
    if (seq !== routeSeq) return
    polyline.value = all.length
      ? [{ points: all, color: CANVAS_PALETTE.brand, width: 5, arrowLine: true }]
      : []
    routeDist.value = dist
    routeDur.value = dur
  } finally {
    // routing 归位只许最后一次规划做：旧任务的 finally 不能替新任务关掉 loading
    if (seq === routeSeq) routing.value = false
  }
}

function switchMode(m: 'walking' | 'driving') {
  if (mode.value === m) return
  mode.value = m
  void buildRoute()
}

function onMarkerTap(e: { detail: { markerId: number } }) {
  const a = markerActs.value[e.detail.markerId]
  if (!a) return
  if (a.kind === 'item') {
    uni.openLocation({
      latitude: a.it.lat,
      longitude: a.it.lng,
      name: a.it.title,
      address: a.it.address || '',
      fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
    })
    return
  }
  uni.openLocation({
    latitude: a.lat,
    longitude: a.lng,
    name: a.kind === 'meetup' ? a.name : `${a.name}的位置`,
    address: a.kind === 'meetup' ? a.address : '',
    fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
  })
}

onLoad((options: Record<string, any> | undefined) => {
  dayId.value = options?.dayId || ''
  if (day.value) void buildRoute()
})
</script>

<template>
  <div class="page">
    <AppNav :title="day ? day.title : '行程路线'" :subtitle="day ? `${shortDate(day.date)} ${weekday(day.date)}` : ''" back border>
      <template #right>
        <button class="nav-refresh" :disabled="routing" @click="buildRoute">
          <AppIcon v-if="!routing" name="refresh" :size="18" />
          <span v-else class="spin">↻</span>
        </button>
      </template>
    </AppNav>

    <div class="map-wrap">
      <map
        v-if="geoItems.length || meetup || memberLocs.length"
        class="map"
        :latitude="center.latitude"
        :longitude="center.longitude"
        :scale="12"
        :markers="markers"
        :polyline="polyline"
        :show-location="true"
        @markertap="onMarkerTap"
      />
      <div v-else class="map-empty">
        <AppIcon name="map" :size="34" color="var(--text-tertiary)" />
        <p>这一天还没有可定位的安排</p>
        <span>给行程项填上地址或坐标后，这里会画出路线</span>
      </div>
    </div>

    <!-- 交通方式 + 路线概览。复用 global.css 的 .seg（灰凹槽 + 白色滑块），
         不再本地造一套 —— 两套分段控件会长得不一样。 -->
    <div class="bar">
      <div class="seg">
        <button class="seg-item" :class="{ active: mode === 'walking' }" @click="switchMode('walking')">
          <AppIcon name="transport" :size="16" />
          步行
        </button>
        <button class="seg-item" :class="{ active: mode === 'driving' }" @click="switchMode('driving')">
          <AppIcon name="transport" :size="16" />
          驾车
        </button>
      </div>
      <span class="summary">{{ summary }}</span>
    </div>

    <!-- 当日行程清单 -->
    <div class="list">
      <div v-if="geoItems.length" class="stops">
        <template v-for="(it, i) in geoItems" :key="it.id">
          <div v-if="i" class="list-sep indent-no" />
          <div class="stop" @click="onMarkerTap({ detail: { markerId: i } })">
            <span class="stop-no">{{ i + 1 }}</span>
            <div class="stop-main">
              <p class="stop-title">{{ it.title }}</p>
              <p v-if="it.address" class="stop-addr ellipsis">{{ it.address }}</p>
            </div>
            <AppIcon name="location" :size="15" color="var(--brand)" />
          </div>
        </template>
      </div>
      <p v-else class="no-geo">行程里有几个点没有坐标，先回行程页补全地址。</p>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-page);
  display: flex;
  flex-direction: column;
}

.nav-refresh {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 导航栏按钮统一成灰底圆形，不加描边不投影（iOS 的 nav bar button） */
  background: var(--bg-subtle);
  color: var(--text-primary);
}

.spin {
  display: inline-block;
  animation: spin 0.8s linear infinite;
  font-size: 18px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 地图区域：白底圆角块，靠底色差跟页面 #F2F2F7 分开，不加描边不投影。
   （原来这里是 `border: 1px solid var(--hairline)` + `box-shadow`，
   和「分层靠底色差、不靠线和影」这条规则冲突。） */
.map-wrap {
  position: relative;
  height: 46vh;
  margin: 0 12px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-card);
}

.map {
  width: 100%;
  height: 100%;
}

/* ⚠️ 用四向写法而不是 `inset: 0` —— 编译到小程序端时 `inset` 简写会被丢掉。
   背景透明，白底交给父级 `.map-wrap`，否则灰底空态会跟页面底色糊在一起。 */
.map-empty {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  text-align: center;
  padding: 0 30px;
}

.map-empty p {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
}

.map-empty span {
  font-size: 12px;
  color: var(--text-tertiary);
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

/* 复用 global.css 的 .seg（灰凹槽 + 白色滑块 + 真投影的滑块），这里只补两条本地约束：
   ① `flex-shrink: 0` —— 不然会被右侧的 .summary 挤扁；
   ② `white-space: nowrap` —— .seg-item 是 `flex: 1 1 0%`，宽度随容器变，文字会被折行。 */
.seg {
  flex-shrink: 0;
}

.seg-item {
  white-space: nowrap;
}

.summary {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
  min-width: 0;
}

.list {
  flex: 1;
  padding: 0 12px 16px;
}

.stops {
  display: flex;
  flex-direction: column;
}

/* 单行不再自带卡片外观（原来每行都是白底 + 圆角 + 描边 + 投影，
   等于在白卡里再叠 N 张白卡）—— 现在整块是一张 .list，行间用发丝线。 */
.stop {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.stop:active {
  background: var(--bg-subtle);
}

/* 发丝线缩到序号圆右边：行左内边距 16 + 圆 24 + 间距 12 = 52 */
.list-sep.indent-no {
  margin-left: 52px;
}

.stop-no {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stop-main {
  flex: 1;
  min-width: 0;
}

.stop-title {
  font-size: 15px;
  font-weight: 500;
}

.stop-addr {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
  max-width: 100%;
}

.no-geo {
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
  padding: 24px 0;
}
</style>
