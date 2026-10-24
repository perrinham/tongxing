<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { CANVAS_PALETTE } from '@/utils/format'
import {
  buildReplaySteps,
  dayBriefs,
  drawReplayPoster,
  firstStepOfDay,
  replayPosterData,
  replayPosterHeight,
  replaySubtitle,
  sequencePolyline,
  type ReplayPosterData
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

/** 已走过的一段（当天 0..posInDay）—— 地图上「长出来的」绿色轨迹 */
const visitedLine = computed(() =>
  current.value ? sequencePolyline(steps.value, current.value.dayNo, current.value.posInDay) : []
)

/** 地图连线（脚本里造对象，模板只绑变量 —— wx polyline 对象字面量放模板里解析不了） */
const polylineFor = computed(() =>
  visitedLine.value.length
    ? [{ points: visitedLine.value, color: P.brand, width: 5, arrowLine: true }]
    : []
)

/** 镜头跟着走过的一段收窄，突出「正在走的这一段」 */
const includePoints = computed(() => {
  if (!current.value) return []
  if (visitedLine.value.length >= 2) return visitedLine.value
  return [{ latitude: current.value.lat, longitude: current.value.lng }]
})

/** marker：全程的点都摆上（当天序号绿章，别天 D 章），当前点强调橙 */
const markers = computed(() =>
  steps.value.map((s, i) => {
    const isCur = i === cursor.value
    const inDay = s.dayNo === dayNo.value
    const bg = isCur ? P.accent : inDay ? P.brand : P.bgCard
    const content = isCur ? '这里' : inDay ? String(s.posInDay + 1) : `D${s.dayNo + 1}`
    return {
      id: i,
      latitude: s.lat,
      longitude: s.lng,
      width: 24,
      height: 24,
      label: {
        content,
        color: isCur || inDay ? '#FFFFFF' : P.textPrimary,
        bgColor: bg,
        fontSize: 12,
        padding: inDay || isCur ? 5 : 4,
        borderRadius: 10,
        textAlign: 'center' as const,
        anchorX: 0,
        anchorY: -30
      }
    }
  })
)

// ── 地图高度：真机上原生 map 不吃 vh/百分比（会退回默认 ~150px，只画出一角），
// 用显式 px —— 运行时按窗口高算，devtools 与真机一致。 ──
const sysH = (uni.getSystemInfoSync().windowHeight as number) || 812
const mapH = Math.max(360, Math.round(sysH * 0.58))

const subtitle = computed(() => replaySubtitle(current.value))
const atEnd = computed(() => cursor.value >= steps.value.length - 1)

/** 地图初始中心（常量，镜头此后由 include-points 接管，避免两者打架） */
const startPoint = computed(() => {
  const s = steps.value[0]
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
            :latitude="startPoint.latitude"
            :longitude="startPoint.longitude"
            :scale="13"
            :markers="markers"
            :polyline="polylineFor"
            :include-points="includePoints"
            :include-padding="[64, 64, 96, 64]"
            enable-poi
            enable-building
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
  /* 高度由脚本给 px（真机原生组件不吃 vh/百分比，见脚本注释） */
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
  padding: 2px 2px 10px;
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
