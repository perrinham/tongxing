<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { walkingRoute, drivingRoute } from '@/services/amap'
import { AMAP_ENABLED } from '@/config'
import { shortDate, weekday, CANVAS_PALETTE, avatarInk } from '@/utils/format'
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

const center = computed(() => {
  const it = geoItems.value[0]
  return it ? { latitude: it.lat, longitude: it.lng } : { latitude: 34.0, longitude: 108.0 }
})

const markers = computed(() =>
  geoItems.value.map((it, i) => ({
    id: i,
    latitude: it.lat,
    longitude: it.lng,
    width: 22,
    height: 22,
    label: {
      content: String(i + 1),
      /* 序号标记：原来写死白字压品牌绿 = 3.18:1（按 1.4.11 图形线算刚好过，但它本质是
         压在色块上的**数字**，没必要卡在线上）。改走 avatarInk → 黑字 6.60:1。
         和城市地图的 callout 用同一个机制，两处不再有两种写法。 */
      color: avatarInk(CANVAS_PALETTE.brand),
      bgColor: CANVAS_PALETTE.brand,
      padding: 4,
      borderRadius: 8,
      textAlign: 'center' as const,
      anchorX: 0,
      anchorY: -26
    }
  }))
)

const summary = computed(() => {
  if (!routeDist.value) return '暂未规划路线'
  const d = routeDist.value < 1000 ? `${routeDist.value} 米` : `${(routeDist.value / 1000).toFixed(1)} 公里`
  const m = Math.round(routeDur.value / 60)
  const t = m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  return `${d} · 约 ${t}（${mode.value === 'walking' ? '步行' : '驾车'}）`
})

async function buildRoute() {
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
      if (r) {
        dist += r.distance
        dur += r.duration
        if (!all.length) all.push(...r.points)
        else all.push(...r.points.slice(1))
      }
    }
    polyline.value = all.length
      ? [{ points: all, color: CANVAS_PALETTE.brand, width: 5, arrowLine: true }]
      : []
    routeDist.value = dist
    routeDur.value = dur
  } finally {
    routing.value = false
  }
}

function switchMode(m: 'walking' | 'driving') {
  if (mode.value === m) return
  mode.value = m
  void buildRoute()
}

function onMarkerTap(e: { detail: { markerId: number } }) {
  const it = geoItems.value[e.detail.markerId] as ItineraryItem | undefined
  if (!it) return
  uni.openLocation({
    latitude: it.lat,
    longitude: it.lng,
    name: it.title,
    address: it.address || '',
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
        v-if="geoItems.length"
        class="map"
        :latitude="center.latitude"
        :longitude="center.longitude"
        :scale="12"
        :markers="markers"
        :polyline="polyline"
        :show-location="false"
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
