<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { CANVAS_PALETTE } from '@/utils/format'
import { walkingRoute } from '@/services/amap'
import {
  buildReplaySteps,
  dayBriefs,
  drawReplayPoster,
  firstStepOfDay,
  replayPosterData,
  replayPosterHeight,
  replaySubtitle,
  type LatLng,
  type ReplayPosterData,
  type ReplayStep
} from '@/utils/replay'
import AppNav from '@/components/AppNav.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppSheet from '@/components/AppSheet.vue'
import PosterCanvas from '@/components/PosterCanvas.vue'
import type { Day, TripSpaceFull } from '@/types'

/** 行程回放页 —— 借 Travel-Story（MIT）「按天画线 + 逐点推进」思想：
 *  地图画当天已走过的连线，字幕逐点推进；海报走纯排版（原生 map 截不了图）。 */
const P = CANVAS_PALETTE

const store = useTripStore()

const tripId = ref('')
/** 数据来源：本地行程优先（从未推云的本机行程没有空间记录），云端 getSpace 只兜底 */
const fromLocal = ref(false)
const spaceDoc = ref<TripSpaceFull['doc'] | null>(null)
const loading = ref(true)
const errorText = ref('')

// 页面卸载后不再回写异步结果（与 TripViewPage 同样的晚到响应护栏）
let alive = true
onUnmounted(() => {
  alive = false
  stopTimer()
})

const trip = computed(() =>
  fromLocal.value
    ? store.trips.find((t) => t.id === tripId.value) || null
    : spaceDoc.value?.trip || null
)
const days = computed<Day[]>(() =>
  fromLocal.value
    ? [...store.daysOf(tripId.value)].sort((a, b) => a.index - b.index)
    : [...(spaceDoc.value?.days || [])].sort((a, b) => a.index - b.index)
)
const items = computed(() =>
  fromLocal.value ? store.itemsOf(tripId.value) : spaceDoc.value?.items || []
)
const memberCount = computed(() =>
  fromLocal.value ? store.membersOf(tripId.value).length : spaceDoc.value?.members.length || 0
)

/** 全程回放轨道（带坐标项；无坐标的静默跳过） */
const steps = computed(() => buildReplaySteps(days.value, items.value))

/** 游标：steps 里的全局下标。0 = 第一站；length-1 = 末站 */
const cursor = ref(0)
const playing = ref(false)

const current = computed(() => steps.value[cursor.value] || null)

/** 当天游标所在的天（切天 = poly/include 重置到新天） */
const dayNo = computed(() => current.value?.dayNo ?? 0)
const dayCount = computed(() => days.value.length)

/** 地图连线：优先逐段真实步行路线（services/amap.walkingRoute），路线没回来用直线兜底 */
const linePts = ref<LatLng[]>([])

function rebuildLine() {
  const cur = current.value
  if (!cur) {
    linePts.value = []
    return
  }
  const dayPts = steps.value.filter((s) => s.dayNo === cur.dayNo)
  if (!dayPts.length) {
    linePts.value = []
    return
  }
  const pts: LatLng[] = [{ latitude: dayPts[0].lat, longitude: dayPts[0].lng }]
  for (let p = 1; p <= cur.posInDay; p += 1) {
    const seg = routeSegs.get(dayPts[p].id) || []
    if (seg.length) pts.push(...seg)
    else pts.push({ latitude: dayPts[p].lat, longitude: dayPts[p].lng })
  }
  linePts.value = pts
}

const polylineFor = computed(() =>
  linePts.value.length >= 2
    ? [{ points: linePts.value, color: P.brand, width: 5, arrowLine: true }]
    : []
)

/** 逐段「上一步走了多远」：步距米数 + 分钟，路线没回来时不显示 */
const legMeta = ref<{ m: number; min: number } | null>(null)

// 路线段缓存：key = 目的站 id（「进到这一站的那一步」的路线）；[] = 已试过、拿不到（直线兜底）
const routeSegs = new Map<string, LatLng[]>()
const routeMeta = new Map<string, { m: number; min: number }>()
const routePending = new Set<string>()
// 路线请求代数：连点/快进时旧响应晚回来不得覆盖新游标（MapPage 同款约定）
let routeSeq = 0

/** 拉取「进到当前站」的真实步行路线；拿不到就让直线兜底 */
async function ensureRouteInto(s: ReplayStep) {
  if (s.posInDay <= 0 || routeSegs.has(s.id) || routePending.has(s.id)) {
    rebuild()
    return
  }
  routePending.add(s.id)
  const seq = ++routeSeq
  const dayPts = steps.value.filter((x) => x.dayNo === s.dayNo)
  const prev = dayPts[s.posInDay - 1]
  try {
    const r = await walkingRoute(
      { latitude: prev.lat, longitude: prev.lng },
      { latitude: s.lat, longitude: s.lng }
    )
    if (seq !== routeSeq) return
    if (r && r.points.length >= 2) {
      routeSegs.set(s.id, r.points.slice(1)) // 首点与上一站重合
      routeMeta.set(s.id, {
        m: Math.round(r.distance),
        min: Math.max(1, Math.round(r.duration / 60))
      })
    } else {
      routeSegs.set(s.id, [])
    }
  } catch {
    if (seq === routeSeq) routeSegs.set(s.id, [])
  } finally {
    routePending.delete(s.id)
    if (seq === routeSeq) rebuild()
  }
}

function rebuild() {
  rebuildLine()
  const cur = current.value
  legMeta.value = cur ? routeMeta.get(cur.id) || null : null
}

// 游标变化：先按缓存立刻重画（直线兜底），再去要真实路线
watch(current, (cur) => {
  rebuild()
  if (cur) void ensureRouteInto(cur)
})

/** 字幕补充：「上一步步行约 X m · Y 分钟」（路线没回来时不显示） */
const legText = computed(() => {
  const m = legMeta.value
  if (!m) return ''
  return m.m >= 1000
    ? `上一步 ${(m.m / 1000).toFixed(1)}km · ${m.min} 分钟`
    : `上一步 ${m.m}m · ${m.min} 分钟`
})

/** marker：全程的点都摆上（当天序号绿章，别天 D 章）。
 *  ⚠️ 只依赖天不依赖游标 —— 真机上每 2s 重建整组 marker 会把原生地图层
 *  搅出渲染残渣（devtools 看不出来），当前点由字幕与进度表达。 */
const markers = computed(() =>
  steps.value.map((s, i) => {
    const inDay = s.dayNo === dayNo.value
    const bg = inDay ? P.brand : P.bgCard
    const content = inDay ? String(s.posInDay + 1) : `D${s.dayNo + 1}`
    return {
      id: i,
      latitude: s.lat,
      longitude: s.lng,
      width: 24,
      height: 24,
      label: {
        content,
        color: inDay ? '#FFFFFF' : P.textPrimary,
        bgColor: bg,
        fontSize: 12,
        padding: inDay ? 5 : 4,
        borderRadius: 10,
        textAlign: 'center' as const,
        anchorX: 0,
        anchorY: -30
      }
    }
  })
)

// ── 地图尺寸：真机上原生 map 不吃 vh/百分比（会退回默认 ~150px，只画一角），
// 用运行时算好的显式 px，宽高双份下到 map 元素本体 ──
const sysInfo = uni.getSystemInfoSync()
const sysH = (sysInfo.windowHeight as number) || 812
const sysW = (sysInfo.windowWidth as number) || 375
const mapH = Math.max(360, Math.round(sysH * 0.56))
const mapW = Math.max(280, sysW - 28) // 与 .map-wrap 的左右边距 14px 同步

const subtitle = computed(() => replaySubtitle(current.value))
const atEnd = computed(() => cursor.value >= steps.value.length - 1)

/** 当天中心点：切天换心，播放中不动镜头（对齐 MapPage 的静态中心 + scale 口径） */
const dayCenter = computed(() => {
  const s = steps.value.find((x) => x.dayNo === dayNo.value) || steps.value[0]
  return s ? { latitude: s.lat, longitude: s.lng } : { latitude: 34.0, longitude: 108.0 }
})

/** 进度总览：全程 N 站，走到第 M 处 */
const progress = computed(() => `${cursor.value + 1}/${steps.value.length}`)

let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function advance() {
  if (cursor.value < steps.value.length - 1) {
    cursor.value += 1
  } else {
    playing.value = false
  }
  syncTimer()
}

function rewind() {
  if (cursor.value > 0) cursor.value -= 1
}

function togglePlay() {
  playing.value = !playing.value
  syncTimer()
}

function restart() {
  cursor.value = 0
  playing.value = true
  syncTimer()
}

/** 播放 = 定时逐点推进（字幕/轨迹/镜头随游标走）；暂停与到尾自动停钟 */
function syncTimer() {
  stopTimer()
  if (playing.value && steps.value.length > 1) {
    timer = setInterval(() => advance(), 2200)
  }
}

function pickDay(no: number) {
  const at = firstStepOfDay(steps.value, no)
  if (at < 0) return
  cursor.value = at
  syncTimer()
}

// ── 海报 ──
const showPoster = ref(false)
const posterData = ref<ReplayPosterData | null>(null)
const posterRef = ref<InstanceType<typeof PosterCanvas> | null>(null)

function makePoster() {
  if (!trip.value) return
  posterData.value = replayPosterData(
    trip.value,
    dayBriefs(days.value, items.value),
    memberCount.value
  )
  showPoster.value = true
}

function downloadPoster() {
  if (!posterRef.value) return
  posterRef.value.save()
}

function onPosterSaved(text?: string) {
  showToast(text || '已保存到相册')
}

function onPosterError(msg: string) {
  showToast(msg)
}

// ── toast ──
const toast = ref('')
const toastShow = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  toastShow.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastShow.value = false), 1800)
}

onLoad((options: Record<string, any> | undefined) => {
  const id = String(options?.id || '')
  if (!id) {
    errorText.value = '缺少行程 id'
    loading.value = false
    return
  }
  tripId.value = id
  const local = store.trips.find((t) => t.id === id)
  if (local) {
    // 本机行程（含从未推云的）：直接吃本地 store，实时反映编辑
    fromLocal.value = true
    loading.value = false
    return
  }
  // 云空间兜底（「发现」/分享进入的只读行程）
  store
    .api()
    .getSpace(id)
    .then((r) => {
      if (!alive) return
      spaceDoc.value = r.space?.doc || null
      if (!spaceDoc.value) errorText.value = '这个行程没有内容'
    })
    .catch((e) => {
      if (!alive) return
      errorText.value = e instanceof Error ? e.message : '加载失败'
    })
    .finally(() => {
      if (alive) loading.value = false
    })
})
</script>

<template>
  <div class="page">
    <AppNav
      :title="trip ? `${trip.title} · 回放` : '行程回放'"
      :subtitle="trip ? trip.destination : ''"
      back
      border
    />

    <p v-if="loading" class="center-hint">加载中…</p>
    <AppEmpty v-else-if="errorText" icon="map" title="打不开这个行程" :desc="errorText" />

    <AppEmpty
      v-else-if="!steps.length"
      icon="map"
      title="还没有带坐标的行程点"
      desc="回放需要行程点带位置坐标；在行程里补上坐标后再来"
    />

    <template v-else>
      <div class="replay-body">
        <div class="map-wrap" :style="{ height: mapH + 'px' }">
          <map
            class="map"
            :style="{ width: mapW + 'px', height: mapH + 'px' }"
            :latitude="dayCenter.latitude"
            :longitude="dayCenter.longitude"
            :scale="14"
            :markers="markers"
            :polyline="polylineFor"
          />
        </div>

        <!-- 逐日章 -->
        <div class="chips">
          <button
            v-for="(d, i) in days"
            :key="d.id"
            class="chip"
            :class="{ on: i === dayNo }"
            @click="pickDay(i)"
          >
            D{{ i + 1 }}
          </button>
        </div>

        <!-- 字幕 + 控制 -->
        <div class="bar">
          <p class="subtitle">{{ subtitle }}</p>
          <p v-if="legText" class="leg">{{ legText }}</p>
          <div class="ctrl-row">
            <button class="ctrl-btn tint" :disabled="cursor === 0" @click="rewind">上一站</button>
            <button class="play-btn" @click="atEnd ? restart() : togglePlay()">
              <AppIcon v-if="!playing || atEnd" name="right" :size="15" />
              {{ atEnd ? '重播' : playing ? '暂停' : '播放' }}
              <span class="num">{{ progress }}</span>
            </button>
            <button class="ctrl-btn tint" :disabled="atEnd" @click="advance">下一站</button>
          </div>
          <button class="poster-btn" @click="makePoster">
            <AppIcon name="share" :size="15" />
            生成行程海报
          </button>
        </div>
      </div>
    </template>

    <AppSheet v-model="showPoster" title="行程海报">
      <PosterCanvas
        v-if="posterData"
        ref="posterRef"
        :data="posterData"
        :draw="drawReplayPoster"
        :height-of="replayPosterHeight"
        @saved="onPosterSaved"
        @error="onPosterError"
      />
      <template #footer>
        <button class="btn-primary" @click="downloadPoster">保存到相册</button>
      </template>
    </AppSheet>

    <div v-if="toastShow" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-page);
}

.center-hint {
  text-align: center;
  color: var(--text-tertiary);
  font-size: 14px;
  padding: 60px 0;
}

.replay-body {
  display: block;
}

.map-wrap {
  /* px 尺寸由脚本给（见脚本注释）；圆角/裁切与 MapPage 同口径 */
  position: relative;
  margin: 10px 14px 0;
  border-radius: 14px;
  overflow: hidden;
  background: var(--bg-card);
}

.map {
  width: 100%;
  height: 100%;
}

/* 底部控制面板独立成块（不遮挡地图本体），所有按钮显式 flex 居中 */
.chips {
  display: flex;
  gap: 8px;
  padding: 10px 14px 0;
  overflow-x: auto;
}

.chip {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-card);
  border-radius: 12px;
}

.chip.on {
  color: var(--brand-deep);
  background: var(--brand-soft);
}

.bar {
  padding: 12px 14px 20px;
}

.subtitle {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 2px 2px 0;
}

.leg {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 0 2px 10px;
}

.ctrl-row {
  display: flex;
  gap: 10px;
}

.ctrl-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 11px;
  font-size: 14px;
  color: var(--text-primary);
  border-radius: 12px;
}

.ctrl-btn[disabled] {
  opacity: 0.4;
}

.play-btn {
  flex: 1.4;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  background: var(--brand-deep);
  border-radius: 12px;
}

.play-btn .num {
  font-weight: 500;
  font-size: 12px;
  opacity: 0.85;
}

.poster-btn {
  margin-top: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px;
  font-size: 14px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--brand-soft);
  border-radius: 12px;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  background: rgba(28, 28, 30, 0.9);
  color: var(--text-inverse);
  font-size: 13px;
  padding: 9px 18px;
  border-radius: 99px;
  z-index: 99;
  white-space: nowrap;
}
</style>
