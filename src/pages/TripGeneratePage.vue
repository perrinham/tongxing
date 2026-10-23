<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { PREF_OPTIONS, type PaceLevel, type GenStage, type GenStageInfo } from '@/utils/itinerary'
import { isKnownCity } from '@/data/poi'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'

const store = useTripStore()

const tripId = ref('')
const pace = ref<PaceLevel>('normal')
const prefs = ref<string[]>(['food', 'history'])
const generating = ref(false)
// 页面卸载后不再执行完成跳转
let alive = true
onUnmounted(() => {
  alive = false
  // 打字机也不许再走（否则卸载后还回头改 ref 打日志/渲染）
  if (typeTimer) clearTimeout(typeTimer)
  typeTimer = null
})
const result = ref('')
const error = ref('')

// ── 流式渐显（打字机）────────────────────────────────
// 生成器的阶段播报进队列后逐字打出。两条硬规矩，都是项目里踩过的坑：
//   · 用 setTimeout 逐字驱动，不用 rAF —— 页面在后台时 rAF 会被完全暂停
//     （PosterCanvas.vue 的教训）；
//   · 渐显一律纯 CSS animation，不用 <Transition>/JS 切类 —— 小程序端任何
//     setData 重渲染都会把过渡类重置回 enter-from，元素直接隐身（AppSheet 的坑）。
const streamLines = ref<string[]>([])
const typing = ref('')
/** 每拍吐 1 字，~60 字/秒：比真人手打快一点，看得出「在算」 */
const TYPE_MS = 16
const queue: string[] = []
let typeTimer: ReturnType<typeof setTimeout> | null = null
let drainResolve: (() => void) | null = null

/** 播报入口：空闲就开写，忙就排队（丢行比乱帧便宜，排队不丢） */
function streamLine(text: string) {
  if (typeTimer || typing.value) {
    queue.push(text)
    return
  }
  typeFrom(text)
}

function typeFrom(text: string) {
  typing.value = ''
  let i = 0
  const tick = () => {
    i += 1
    typing.value = text.slice(0, i)
    if (i < text.length) {
      typeTimer = setTimeout(tick, TYPE_MS)
      return
    }
    typeTimer = null
    streamLines.value.push(text)
    typing.value = ''
    const next = queue.shift()
    if (next) typeFrom(next)
    else {
      const w = drainResolve
      drainResolve = null
      w?.()
    }
  }
  tick()
}

/** 等队伍排空（生成结束时要等所有播报打完再亮「草稿已就绪」） */
function drainStream(): Promise<void> {
  if (!typeTimer && !typing.value && !queue.length) return Promise.resolve()
  return new Promise<void>((resolve) => {
    drainResolve = resolve
  })
}

/** 阶段 → 文案：与生成器同步链上的锚点一一对应 */
function onStage(stage: GenStage, info: GenStageInfo) {
  const dest = trip.value?.destination || ''
  switch (stage) {
    case 'fetch':
      streamLine(`正在拉取「${dest}」的实时点位，约 1-2 秒…`)
      break
    case 'score':
      streamLine(`为 ${info.count ?? 0} 个候选点位打分排序`)
      break
    case 'plan':
      streamLine(`按「${paces.find((p) => p.key === pace.value)?.label || '标准'}」节奏排出 ${info.days ?? 0} 天`)
      break
    case 'timeline':
      streamLine(`${info.count ?? 0} 个安排铺上时间轴`)
      break
  }
}

const trip = computed(() => store.trips.find((t) => t.id === tripId.value) || null)
const isKnownDest = computed(() => !!trip.value && isKnownCity(trip.value.destination))

const paces: { key: PaceLevel; label: string; desc: string }[] = [
  { key: 'relax', label: '松弛', desc: '每天 2 个点，睡到自然醒' },
  { key: 'normal', label: '标准', desc: '每天 3 个点，玩得比较全' },
  { key: 'packed', label: '紧凑', desc: '每天 4 个点，行程拉满' }
]

onLoad((options: Record<string, any> | undefined) => {
  const q = options?.tripId || ''
  tripId.value = q || store.activeTripId || ''
  if (!tripId.value && store.trips.length) {
    tripId.value = store.tripsSorted[0].id
  }
})

function togglePref(key: string) {
  const i = prefs.value.indexOf(key)
  if (i >= 0) prefs.value.splice(i, 1)
  else prefs.value.push(key)
}

async function run() {
  if (!trip.value) {
    error.value = '没有找到行程，请先新建一个'
    return
  }
  generating.value = true
  error.value = ''
  streamLines.value = []
  queue.length = 0
  // 让 loading 状态先渲染出来，再跑（本地库同步完成；在线城市要等高德检索，约 1-2s）
  setTimeout(async () => {
    try {
      // 阶段播报打进打字机队列；生成完等播报全部打完，再亮「就绪」并跳转
      const summary = await store.generateAsync(tripId.value, {
        destination: trip.value!.destination,
        startDate: trip.value!.startDate,
        endDate: trip.value!.endDate,
        peopleCount: store.membersOf(tripId.value).length,
        prefs: prefs.value,
        pace: pace.value
      }, onStage)
      await drainStream()
      result.value = summary
      // 用户若已手动返回，不再强制拉回行程页
      setTimeout(() => {
        if (alive) nav.replace('itinerary')
      }, 620)
    } catch (e) {
      // 在线城市的失败带具体原因（限流/断网），比笼统的「生成失败」可行动
      error.value = (e as Error)?.message || '生成失败，换个偏好再试一次'
      // 失败也要等打字机排空：停在半截字会像页面卡了
      await drainStream()
    } finally {
      generating.value = false
    }
  }, 120)
}
</script>

<template>
  <div class="page">
    <AppNav :title="result ? '生成完成' : '生成行程草稿'" back />

    <div class="page-body">
      <div v-if="trip" class="card trip-card">
        <div class="row-between">
          <div class="grow">
            <p class="trip-title ellipsis">{{ trip.title }}</p>
            <p class="trip-sub">
              {{ trip.destination }} · {{ trip.startDate }} → {{ trip.endDate }}
            </p>
          </div>
          <span class="day-badge">{{ store.daysOf(trip.id).length || '—' }} 天</span>
        </div>
      </div>

      <div v-if="!result">
        <div class="sec-title">
          <h2>这次想要什么</h2>
          <span class="sec-hint">可多选</span>
        </div>
        <div class="card">
          <div class="pref-grid">
            <button
              v-for="p in PREF_OPTIONS"
              :key="p.key"
              class="pref"
              :class="{ active: prefs.includes(p.key) }"
              @click="togglePref(p.key)"
            >
              <span class="pref-check">
                <AppIcon
                  v-if="prefs.includes(p.key)"
                  name="check"
                  :size="12"
                  color="#fff"
                  :stroke="2.6"
                />
              </span>
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="sec-title">
          <h2>节奏</h2>
        </div>
        <div class="card">
          <div class="pace-list">
            <button
              v-for="p in paces"
              :key="p.key"
              class="pace"
              :class="{ active: pace === p.key }"
              @click="pace = p.key"
            >
              <div class="grow left">
                <p class="pace-label">{{ p.label }}</p>
                <p class="pace-desc">{{ p.desc }}</p>
              </div>
              <span class="radio" :class="{ on: pace === p.key }">
                <span v-if="pace === p.key" class="dot" />
              </span>
            </button>
          </div>
        </div>

        <p class="note">
          {{ isKnownDest
            ? '优先参考各城市经典路线（携程 / 高德热门玩法）排布；生成后可以随意拖动和增删。'
            : '该城市走高德在线点位库（景点 / 商圈 / 餐饮按评分取头部），生成约需 1-2 秒；离线时回退内置城市模板。' }}
        </p>
      </div>

      <div v-else class="done">
        <div class="done-icon">
          <AppIcon name="check" :size="26" color="#fff" :stroke="2.4" />
        </div>
        <p class="done-title">草稿已就绪</p>
        <p class="done-sub">{{ result }}</p>
      </div>

      <!-- 流式过程：生成器的阶段播报逐行逐字流出（纯 CSS 动画，见 script 注释） -->
      <div v-if="streamLines.length || typing" class="stream">
        <p v-for="(l, i) in streamLines" :key="i" class="gl-line">{{ l }}</p>
        <p v-if="typing" class="gl-line typing">
          {{ typing }}<text class="caret" />
        </p>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <div v-if="!result" class="foot-bar">
      <button class="btn-primary" :disabled="generating || !trip" @click="run">
        <AppIcon :name="generating ? 'refresh' : 'sparkle'" :size="18" />
        {{ generating ? '正在排布…' : '开始生成' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.trip-card {
  margin-top: 8px;
}

.trip-title {
  font-size: 16px;
  font-weight: 500;
}

.trip-sub {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.day-badge {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
}

.pref-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pref {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 14px;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.pref.active {
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-weight: 500;
}

.pref-check {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: transparent;
}

.pref.active .pref-check {
  background: var(--brand);
  border-color: var(--brand);
}

.pace-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pace {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  text-align: left;
  transition: background 0.15s ease;
}

.pace.active {
  background: var(--brand-soft);
}

.pace .left {
  min-width: 0;
}

.pace-label {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.pace-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.radio {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.radio.on {
  border-color: var(--brand);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
}

.note {
  margin: 18px 4px 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

.done {
  text-align: center;
  padding: 56px 20px;
  /* 进场渐显：复用全局 rise keyframes —— 就绪卡片是流式过程的收尾一拍 */
  animation: rise 0.35s ease-out both;
}

.done-icon {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 18px;
}

.done-title {
  font-size: 17px;
  font-weight: 500;
}

.done-sub {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

.err {
  margin-top: 14px;
  font-size: 13px;
  color: var(--danger);
  text-align: center;
}

/* ── 流式渐显：阶段播报的打字机卡 ─────────────────────── */
.stream {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.gl-line {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* 正在打的那一行更深一点：视线的落点 */
.gl-line.typing {
  color: var(--text-primary);
}

/* 光标：纯 CSS 的 steps 闪烁（transition 类会被 setData 重置，keyframes 不会） */
.caret {
  display: inline-block;
  width: 2px;
  height: 13px;
  margin-left: 2px;
  vertical-align: -1px;
  background: var(--brand-deep);
  animation: caret-blink 0.7s steps(1, end) infinite;
}

@keyframes caret-blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}

.foot-bar {
  position: sticky;
  bottom: 0;
  padding: 12px 16px calc(16px + var(--safe-bottom));
  /* 渐变的「透明端」也必须写 --bg-page 自己的 RGB（原来是旧米色 rgba(248,247,244,0)）。 */
  background: linear-gradient(to top, var(--bg-page) 72%, rgba(242, 242, 247, 0));
}
</style>
