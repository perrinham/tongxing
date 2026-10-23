<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import {
  itemMetaOf,
  moneyBrief,
  shortDate,
  weekday,
  daysUntil,
  durationText,
  endTime,
  todayISO
} from '@/utils/format'
import { fetchTripWeather } from '@/services/weather'
import { weatherBrief, type WeatherDay } from '@/utils/weather'
import { checkItinerary, timeMinOf, kmBetween, type ItinIssue, type RouteLike, type LatLike } from '@/utils/itinCheck'
import { packGroupLabel } from '@/utils/packing'
import { walkingRoute, drivingRoute } from '@/services/amap'
import type { ItineraryItem } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppSheet from '@/components/AppSheet.vue'
import AppTabBar from '@/components/AppTabBar.vue'

const store = useTripStore()

const trip = computed(() => store.activeTrip)
const members = computed(() => (trip.value ? store.membersOf(trip.value.id) : []))
const days = computed(() => (trip.value ? store.daysOf(trip.value.id) : []))
const activeDayId = ref('')
const actionItemId = ref('')
const showActions = ref(false)

const activeDay = computed(() => days.value.find((d) => d.id === activeDayId.value) || days.value[0])
const items = computed(() => (activeDay.value ? store.itemsOfDay(activeDay.value.id) : []))

watch(
  days,
  (list) => {
    if (!list.length) {
      activeDayId.value = ''
      return
    }
    if (!list.some((d) => d.id === activeDayId.value)) {
      // 默认停在今天所在的这一天，否则第一天
      // todayISO 按本地时区取「今天」；toISOString 是 UTC，凌晨 0-8 点会落到昨天
      const today = todayISO()
      const hit = list.find((d) => d.date === today)
      activeDayId.value = (hit || list[0]).id
    }
  },
  { immediate: true }
)

const activeItem = computed(() => store.items.find((i) => i.id === actionItemId.value))

const countdown = computed(() => {
  if (!trip.value) return null
  return daysUntil(trip.value.startDate)
})

const countdownText = computed(() => {
  const d = countdown.value
  if (d === null) return ''
  if (d > 0) return `还有 ${d} 天出发`
  if (d === 0) return '今天出发'
  const end = daysUntil(trip.value!.endDate)
  if (end >= 0) return `旅程进行中 · 第 ${-d + 1} 天`
  return '旅程已结束'
})

const dayCost = computed(() => items.value.reduce((s, i) => s + i.cost, 0))
const tripEstimate = computed(() => (trip.value ? store.estimateOf(trip.value.id) : 0))
const daySpend = computed(() => {
  if (!trip.value || !activeDay.value) return 0
  return store
    .expensesOf(trip.value.id)
    .filter((e) => e.date === activeDay.value.date)
    .reduce((s, e) => s + e.amount, 0)
})

const openPolls = computed(() =>
  trip.value ? store.pollsOf(trip.value.id).filter((p) => p.status === 'open') : []
)
const allPolls = computed(() => (trip.value ? store.pollsOf(trip.value.id) : []))
const meetup = computed(() => (trip.value ? store.meetupOf(trip.value.id) : null))

// ── 逐日天气：目的地 × 行程日期。静默加载，拉不到就不显示，绝不打扰行程主流程 ──
const weatherMap = ref<Map<string, WeatherDay>>(new Map())

/** 页面卸载后不再回写异步结果（与 TripViewPage 的 alive 守卫同款） */
let alive = true
onUnmounted(() => {
  alive = false
})

watch(
  () => [trip.value?.destination, trip.value?.startDate, trip.value?.endDate] as const,
  async ([dest, start, end]) => {
    if (!dest || !start || !end) {
      weatherMap.value = new Map()
      return
    }
    const r = await fetchTripWeather(dest, start, end)
    if (!alive) return
    // stale（断网降级的旧值）也显示 —— 有总比没有强
    weatherMap.value = r ? r.byDate : new Map()
  },
  { immediate: true }
)

const weatherOf = (date: string): WeatherDay | null => weatherMap.value.get(date) || null

// ── 行程核验：AI 草稿边顺不边顺，跑一遍规则才知道。
//    结果只算不存（不进同步），verifiedAt 才是唯一的持久化字段。 ──
const routeCache = new Map<string, RouteLike | null>()
const allIssues = ref<ItinIssue[]>([])
const showIssues = ref(false)
let checkSeq = 0

/** 高德步行/驾车：短途步行、长途自驾；kmBetween 复用校验器的几何（避免重复引入） */
async function amapRouteFetch(from: LatLike, to: LatLike): Promise<RouteLike | null> {
  const a = { latitude: from.lat, longitude: from.lng }
  const b = { latitude: to.lat, longitude: to.lng }
  try {
    const r = kmBetween(from, to) > 8 ? await drivingRoute(a, b) : await walkingRoute(a, b)
    return r ? { distance: r.distance, duration: r.duration } : null
  } catch {
    return null // amap 出错就降级：不出 tight 结果，不打扰主线
  }
}

/** 编辑触发重算：签名覆盖影响任一规则的字段 */
const checkSig = computed(() => {
  if (!trip.value) return ''
  const parts = store
    .itemsOf(trip.value.id)
    .map((i) => `${i.id}|${i.dayId}|${i.time}|${i.duration}|${i.order}|${i.type}|${i.lat}|${i.lng}|${i.cost}|${i.title}`)
  return [trip.value.id, days.value.length, ...parts].join(';')
})

async function runChecks() {
  const id = trip.value?.id
  if (!id) {
    allIssues.value = []
    return
  }
  const seq = ++checkSeq
  const found = await checkItinerary(store.itemsOf(id), {
    route: amapRouteFetch,
    routeCache
  })
  if (!alive || seq !== checkSeq) return // 页面已卸载 / 已有更新的重算
  allIssues.value = found
}

watch(checkSig, runChecks, { immediate: true })

/** item.id → 挂在这条上的问题们（模板里用于角标） */
const issuesByItem = computed(() => {
  const map = new Map<string, ItinIssue[]>()
  for (const issue of allIssues.value) {
    for (const id of issue.itemIds) {
      const arr = map.get(id)
      if (arr) arr.push(issue)
      else map.set(id, [issue])
    }
  }
  return map
})

const issueCount = computed(() => allIssues.value.length)
const errorCount = computed(() => allIssues.value.filter((i) => i.level === 'error').length)

/** 问题列表里的 D1/D2 标签 */
function dayLabelOf(dayId: string): string {
  const d = days.value.find((x) => x.id === dayId)
  return d ? `D${d.index + 1}` : ''
}

function markVerified(id: string) {
  const it = store.items.find((i) => i.id === id)
  if (!it || it.verifiedAt) return
  store.updateItem(id, { verifiedAt: Date.now() })
  uni.showToast({ title: '已记录现场确认', icon: 'none' })
}

/** R3/tight 的一键修法：在两项之间补一段交通 */
function insertTransport(issue: ItinIssue) {
  const a = store.items.find((i) => i.id === issue.itemIds[0])
  const b = store.items.find((i) => i.id === issue.itemIds[1])
  const host = a || b
  if (!host) return
  const dayId = a?.dayId || b!.dayId
  const aEnd = a ? timeMinOf(a.time) : null
  const bStart = b ? timeMinOf(b.time) : null
  // 默认 30 分钟；两端都有合法时间就按实际间隔塞（10–120 分钟）
  let duration = 30
  if (aEnd != null && bStart != null && !Number.isNaN(aEnd) && !Number.isNaN(bStart)) {
    duration = Math.min(120, Math.max(10, bStart - (aEnd + a!.duration)))
  }
  const startOk = a && aEnd != null && !Number.isNaN(aEnd)
  const startTime = startOk ? endTime(a!.time, a!.duration) : b?.time || '10:00'
  store.addItem(dayId, {
    type: 'transport',
    title: `交通衔接（→ ${b?.title || '下一站'}）`,
    time: startTime,
    duration,
    cost: 0,
    note: issue.title
  })
  uni.showToast({ title: '已插入交通衔接', icon: 'none' })
}

// ── 行李清单：trip.packing 是 AI 生成的模板，用户增删勾选就是真实状态 ──
const showPacking = ref(false)
const newItemText = ref('')

const packing = computed(() => trip.value?.packing || null)
const packTotal = computed(() => packing.value?.items.length || 0)
const packDone = computed(() => packing.value?.items.filter((i) => i.done).length || 0)

/** 分组靠「与上一项组不同」推断（生成时按组连续产出）；index 供 store 精确增删 */
const packRows = computed(() => {
  const p = packing.value
  if (!p) return []
  return p.items.map((it, index) => ({
    it,
    index,
    newGroup: index === 0 || p.items[index - 1].group !== it.group
  }))
})

function togglePack(index: number) {
  if (trip.value) store.togglePacking(trip.value.id, index)
}

function removePack(index: number) {
  if (trip.value) store.removePackingItem(trip.value.id, index)
}

function rebuildPacking() {
  if (!trip.value) return
  store.buildPacking(trip.value.id)
  uni.showToast({ title: '清单已按行程重造', icon: 'none' })
}

function addPackItem() {
  const title = newItemText.value.trim()
  if (!trip.value || !title) return
  store.addPackingItem(trip.value.id, title)
  newItemText.value = ''
}


function goPolls() {
  if (trip.value) nav.to('poll', { id: trip.value.id })
}

function goMeetup() {
  if (trip.value) nav.to('meetup', { id: trip.value.id })
}

function pickDay(id: string) {
  activeDayId.value = id
}

function openItem(id: string) {
  nav.to('item-edit', { id })
}

function openActions(id: string) {
  actionItemId.value = id
  showActions.value = true
}

function toggleDone() {
  const it = activeItem.value
  if (!it) return
  store.updateItem(it.id, { done: !it.done })
  showActions.value = false
}

function move(dir: -1 | 1) {
  const it = activeItem.value
  if (!it) return
  store.moveItem(it.id, dir)
  showActions.value = false
}

function removeItem() {
  const it = activeItem.value
  if (!it) return
  store.removeItem(it.id)
  showActions.value = false
}

function addItem() {
  if (!activeDay.value) return
  store.addItem(activeDay.value.id, {
    title: '新安排',
    time: items.value.length ? endTime(items.value[items.value.length - 1].time, items.value[items.value.length - 1].duration + 30) : '10:00'
  })
}

function navigateTo(it: { lat: number; lng: number; title: string; address?: string }) {
  if (!it.lat || !it.lng) return
  uni.openLocation({
    latitude: it.lat,
    longitude: it.lng,
    name: it.title,
    address: it.address || '',
    fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
  })
}

function reschedule() {
  if (!activeDay.value) return
  store.rescheduleDay(activeDay.value.id)
}

function goCreate() {
  nav.to('trip-create')
}

function goGenerate() {
  if (!trip.value) return
  nav.to('trip-generate', { tripId: trip.value.id })
}

function goMap() {
  if (!activeDay.value) return
  nav.to('map', { dayId: activeDay.value.id })
}
</script>

<template>
  <div class="page">
    <AppNav
      :title="trip ? trip.title : '行程'"
      :subtitle="trip ? countdownText : ''"
      home
      border
    >
      <template #right>
        <button v-if="trip" class="nav-icon" @click="goGenerate" title="重新生成">
          <AppIcon name="sparkle" :size="20" />
        </button>
      </template>
    </AppNav>

    <template v-if="!trip">
      <AppEmpty
        icon="map"
        title="还没有属于你的行程"
        desc="创建一段旅程，或去「发现」看看大家的行程"
        action="创建我的行程"
        @action="goCreate"
      />
    </template>

    <template v-else>
      <!-- 概览：一张分组卡里的三行，不再是一张画了顶条的「数据面板」 -->
      <div class="page-body">
        <div class="list ov-list">
          <div class="stat3">
            <div class="stat">
              <span class="stat-num num">{{ days.length }}</span>
              <span class="stat-unit">天</span>
            </div>
            <div class="stat">
              <span class="stat-num num">{{ members.length }}</span>
              <span class="stat-unit">人</span>
            </div>
            <div class="stat">
              <span class="stat-num num">{{ store.itemsOf(trip.id).length }}</span>
              <span class="stat-unit">个安排</span>
            </div>
          </div>
          <div class="list-sep" />
          <button class="list-row" @click="nav.to('trip-members')">
            <div class="avatar-stack">
              <div v-for="m in members.slice(0, 5)" :key="m.id" class="av">
                <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="28" ring />
              </div>
            </div>
            <span v-if="members.length > 5" class="ov-more">+{{ members.length - 5 }}</span>
            <span class="grow" />
            <span class="row-value">管理</span>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <div class="list-sep" />
          <button class="list-row" @click="goPolls">
            <AppIcon name="flag" :size="18" color="var(--text-secondary)" />
            <span class="pad">投票</span>
            <span class="grow" />
            <span v-if="openPolls.length" class="badge-num">{{ openPolls.length }}</span>
            <span v-else-if="allPolls.length" class="row-value">已结束</span>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <div class="list-sep" />
          <button class="list-row" @click="goMeetup">
            <AppIcon name="location" :size="18" color="var(--text-secondary)" />
            <span class="pad">集合点</span>
            <span class="grow" />
            <span v-if="meetup" class="row-value meetup-val ellipsis">{{ meetup.title }}</span>
            <span v-else class="row-value">未定</span>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <div class="list-sep" />
          <button class="list-row" @click="showIssues = true">
            <AppIcon name="check" :size="18" color="var(--text-secondary)" />
            <span class="pad">行程核验</span>
            <span class="grow" />
            <span v-if="errorCount" class="vflag err">{{ errorCount }} 处冲突</span>
            <span v-else-if="issueCount" class="vflag warn">{{ issueCount }} 条待核实</span>
            <span v-else class="vflag okv">已核实</span>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <div class="list-sep" />
          <button class="list-row" @click="showPacking = true">
            <AppIcon name="list" :size="18" color="var(--text-secondary)" />
            <span class="pad">行李清单</span>
            <span class="grow" />
            <span v-if="packTotal" class="vflag okv">{{ packDone }}/{{ packTotal }}</span>
            <span v-else class="vflag warn">待生成</span>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <div class="list-sep" />
          <div class="list-row">
            <span class="grow">预估价</span>
            <span class="num est-num">{{ moneyBrief(tripEstimate, trip.currency) }}</span>
          </div>
        </div>
      </div>

      <!-- 日期切换：系统的分段控件（凹槽 + 白色滑块） -->
      <div class="day-seg-wrap">
        <scroll-view class="day-scroll" scroll-x :show-scrollbar="false">
          <div class="seg day-seg">
            <button
              v-for="d in days"
              :key="d.id"
              class="seg-item"
              :class="{ active: activeDay && d.id === activeDay.id }"
              @click="pickDay(d.id)"
            >
              <span class="seg-d">D{{ d.index + 1 }}</span>
              <span class="seg-date num">{{ shortDate(d.date) }}</span>
            </button>
          </div>
        </scroll-view>
      </div>

      <!-- 当日头部 -->
      <div v-if="activeDay" class="day-head">
        <div class="grow dh-text">
          <h2 class="dh-title">{{ activeDay.title }}</h2>
          <p class="dh-sub">
            {{ shortDate(activeDay.date) }} {{ weekday(activeDay.date) }}
            <template v-if="daySpend > 0"> · 已花 {{ moneyBrief(daySpend, trip.currency) }}</template>
          </p>
          <p v-if="weatherOf(activeDay.date)" class="dh-weather">
            {{ weatherBrief(weatherOf(activeDay.date)!) }}
          </p>
          <p v-if="activeDay.note" class="dh-tip">{{ activeDay.note }}</p>
        </div>
        <div class="dh-acts">
          <button class="btn-ghost dh-btn" @click="goMap">
            <AppIcon name="map" :size="15" />
            路线
          </button>
          <button class="btn-ghost dh-btn" @click="reschedule">
            <AppIcon name="refresh" :size="15" />
            重排
          </button>
        </div>
      </div>

      <!-- 当日安排：分组列表，行与行之间是内缩发丝线 -->
      <div class="page-body">
        <div v-if="items.length" class="list">
          <template v-for="(it, idx) in items" :key="it.id">
            <div v-if="idx" class="list-sep indent-time" />
            <div
              class="tl-row"
              :class="{ done: it.done }"
              @click="openItem(it.id)"
            >
              <div class="tl-time-col">
                <span class="tl-time num">{{ it.time }}</span>
                <span class="tl-node" :style="{ background: itemMetaOf(it.type).color }" />
              </div>
              <div class="tl-body">
                <div class="tl-line1">
                  <span
                    class="tint"
                    :style="{
                      color: itemMetaOf(it.type).color,
                      background: itemMetaOf(it.type).bg
                    }"
                  >
                    {{ itemMetaOf(it.type).label }}
                  </span>
                  <span class="tl-title ellipsis">{{ it.title }}</span>
                  <button class="tl-more" @click.stop="openActions(it.id)">
                    <AppIcon name="dots" :size="17" color="var(--text-tertiary)" />
                  </button>
                </div>
                <p v-if="it.address" class="tl-addr ellipsis">{{ it.address }}</p>
                <div class="tl-foot">
                  <span class="tl-meta-item">{{ durationText(it.duration) }}</span>
                  <span v-if="it.cost > 0" class="tl-meta-item num">
                    {{ moneyBrief(it.cost, trip.currency) }}/人
                  </span>
                  <button
                    v-if="issuesByItem.get(it.id)"
                    class="vflag warn tl-vchip"
                    @click.stop="showIssues = true"
                  >
                    待核实
                  </button>
                  <span v-else-if="it.verifiedAt" class="vflag okv tl-vchip">已核实</span>
                  <span v-if="it.done" class="tint neutral">已打卡</span>
                  <span class="grow" />
                  <button
                    v-if="it.lat && it.lng"
                    class="tl-nav"
                    @click.stop="navigateTo(it)"
                  >
                    导航
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <AppEmpty
          v-else
          icon="map"
          title="这天还没有安排"
          desc="手动加一个，或者重新生成一份草稿"
          action="加一个安排"
          @action="addItem"
        />

        <!-- 「新建」在 iOS 里也是一行，不是虚线框 -->
        <div v-if="items.length" class="list add-list">
          <button class="list-row add-row" @click="addItem">
            <AppIcon name="plus" :size="18" color="var(--brand)" />
            <span class="add-text">加一个安排</span>
          </button>
        </div>
      </div>
    </template>

    <!-- 行程核验面板：列出全行程问题（带 D1/D2 定位），支持现场确认与一键补交通 -->
    <AppSheet v-model="showIssues" title="行程核验">
      <div v-if="!allIssues.length" class="check-empty">全行程都没查出问题 ✓</div>
      <div v-else class="check-list">
        <div v-for="(x, idx) in allIssues" :key="idx" class="check-item">
          <div class="ci-head">
            <span class="ci-day num">{{ dayLabelOf(x.dayId) }}</span>
            <span class="ci-kind" :class="x.level === 'error' ? 'err' : 'warn'">
              {{ x.level === 'error' ? '冲突' : '核实' }}
            </span>
            <p class="ci-title">{{ x.title }}</p>
          </div>
          <p class="ci-hint">{{ x.hint }}</p>
          <div class="ci-acts">
            <button
              v-if="x.rule === 'gap' || x.rule === 'tight'"
              class="ci-btn"
              @click="insertTransport(x)"
            >
              插入交通
            </button>
            <button
              v-for="id in x.itemIds"
              :key="id"
              class="ci-btn ghost"
              :disabled="store.items.find((i) => i.id === id)?.verifiedAt ? true : false"
              @click="markVerified(id)"
            >
              {{ store.items.find((i) => i.id === id)?.verifiedAt ? '已现场确认' : '现场确认' }}
            </button>
          </div>
        </div>
      </div>
    </AppSheet>

    <!-- 行李清单面板：分组勾选 + 增删，模板可按行程随时重造 -->
    <AppSheet v-model="showPacking" title="行李清单">
      <div class="pack-head">
        <p class="pack-progress num">{{ packTotal ? `已备 ${packDone}/${packTotal}` : '还没有清单' }}</p>
        <button v-if="packTotal" class="pack-rebuild" @click="rebuildPacking">重新生成</button>
      </div>

      <template v-if="packRows.length">
        <div class="pack-list">
          <template v-for="row in packRows" :key="row.index">
            <p v-if="row.newGroup" class="pack-group">{{ packGroupLabel(row.it.group) }}</p>
            <div class="pack-row" :class="{ done: row.it.done }">
              <button class="pack-check" :class="{ on: row.it.done }" @click="togglePack(row.index)">
                <AppIcon v-if="row.it.done" name="check" :size="11" color="#fff" :stroke="2.8" />
              </button>
              <span class="pack-title ellipsis">{{ row.it.title }}</span>
              <button class="pack-x" @click="removePack(row.index)">删</button>
            </div>
          </template>
        </div>
        <div class="pack-add">
          <input
            v-model="newItemText"
            class="pack-input"
            placeholder="再添一件…"
            maxlength="20"
            confirm-type="done"
            @confirm="addPackItem"
          />
          <button class="pack-add-btn" :disabled="!newItemText.trim()" @click="addPackItem">添上</button>
        </div>
      </template>

      <div v-else class="pack-empty">
        <p>按行程天数、季节、交通与住宿自动生成，生成后可随意增删勾选。</p>
        <button class="pack-build-btn" @click="rebuildPacking">生成行李清单</button>
      </div>
    </AppSheet>

    <AppSheet v-model="showActions" :title="activeItem?.title || ''">
      <div class="acts">
        <button class="act" @click="toggleDone">
          <AppIcon name="check" :size="19" />
          {{ activeItem?.done ? '取消打卡' : '标记已打卡' }}
        </button>
        <button class="act" @click="move(-1)">
          <AppIcon name="up" :size="19" />
          上移一位
        </button>
        <button class="act" @click="move(1)">
          <AppIcon name="down" :size="19" />
          下移一位
        </button>
        <button class="act" @click="showActions = false; openItem(actionItemId)">
          <AppIcon name="edit" :size="19" />
          编辑详情
        </button>
        <button class="act danger" @click="removeItem">
          <AppIcon name="trash" :size="19" />
          删除这个安排
        </button>
      </div>
    </AppSheet>

    <AppTabBar current="itinerary" />
  </div>
</template>

<style scoped>
/* ── 行程核验 ─────────────────────────────────────────── */
.vflag {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
  padding: 5px 9px;
  border-radius: 999px;
  font-weight: 500;
}

.vflag.warn {
  color: var(--warn-deep);
  background: var(--warn-soft);
}

.vflag.err {
  color: var(--danger);
  background: var(--danger-soft);
}

.vflag.okv {
  color: var(--brand-deep);
  background: var(--brand-soft);
}

.tl-vchip {
  margin-right: 8px;
}

.check-empty {
  padding: 14px 2px 6px;
  font-size: 14px;
  color: var(--text-secondary);
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 8px;
}

.check-item {
  padding: 12px;
  background: var(--bg-subtle);
  border-radius: 12px;
}

.ci-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ci-day {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--bg-card);
  padding: 3px 7px;
  border-radius: 8px;
}

.ci-kind {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 8px;
}

.ci-kind.warn {
  color: var(--warn-deep);
  background: var(--warn-soft);
}

.ci-kind.err {
  color: var(--danger);
  background: var(--danger-soft);
}

.ci-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.ci-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.ci-acts {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ci-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--bg-card);
  padding: 7px 12px;
  border-radius: 10px;
}

.ci-btn.ghost {
  color: var(--text-secondary);
}

.ci-btn[disabled] {
  opacity: 0.55;
}

/* ── 行李清单 ─────────────────────────────────────────── */
.pack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 2px 10px;
}

.pack-progress {
  font-size: 13px;
  font-weight: 600;
  color: var(--brand-deep);
}

.pack-rebuild,
.pack-build-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--bg-subtle);
  padding: 7px 12px;
  border-radius: 10px;
}

.pack-build-btn {
  margin-top: 12px;
}

.pack-list {
  display: flex;
  flex-direction: column;
  padding: 2px 2px 8px;
}

.pack-group {
  margin-top: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}

.pack-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
}

.pack-row.done .pack-title {
  color: var(--text-tertiary);
  text-decoration: line-through;
}

.pack-check {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--bg-card);
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pack-check.on {
  background: var(--brand);
  border-color: var(--brand);
}

.pack-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary);
}

.pack-x {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  padding: 4px 9px;
  border-radius: 8px;
}

.pack-add {
  display: flex;
  gap: 8px;
  padding: 10px 2px 4px;
  border-top: 1px solid var(--line);
}

.pack-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  background: var(--bg-subtle);
  border-radius: 10px;
  padding: 0 12px;
  font-size: 13px;
}

.pack-add-btn {
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--bg-card);
  padding: 0 12px;
  border-radius: 10px;
}

.pack-add-btn[disabled] {
  opacity: 0.55;
}

.pack-empty {
  padding: 10px 4px 6px;
}

.pack-empty p {
  font-size: 13px;
  color: var(--text-secondary);
}

.ov-list {
  margin-top: 4px;
}

.ov-more {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* iOS 行尾的「可点」提示：次级灰文字 + 一个 chevron */
.row-value {
  font-size: 15px;
  color: var(--text-secondary);
}

/* 集合点名可能很长：限宽 + 省略，不让它把 chevron 挤出可视区 */
.meetup-val {
  max-width: 36vw;
  min-width: 0;
  overflow: hidden;
}

.pad {
  margin-left: 10px;
}

.badge-num {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--brand);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.est-num {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

/* ── 日期分段控件 ──
   外面套 scroll-view 是因为：天数可能超过 4 天，超过后分段控件必须能横滑，
   而在小程序端让一个普通 <div> 横向滚动是无效的 —— 必须用 scroll-view。 */
.day-seg-wrap {
  padding: 16px 16px 0;
}

.day-scroll {
  width: 100%;
  white-space: nowrap;
}

.day-seg {
  display: inline-flex;
  width: 100%;
}

.seg-item {
  flex: 1;
  min-width: 68px;
  flex-direction: column;
  gap: 0;
  height: 40px;
}

.seg-d {
  font-size: 13px;
  line-height: 1.25;
}

.seg-date {
  font-size: 10px;
  line-height: 1.2;
  color: var(--text-tertiary);
}

.seg-item.active .seg-date {
  color: var(--text-secondary);
}

.day-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 20px 16px 10px;
}

.dh-text {
  min-width: 0;
}

/* iOS 的区块标题：20/600，比正文明显重，靠字重而不是颜色拉层级 */
.dh-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.2px;
  line-height: 1.25;
}

.dh-sub {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

/* 逐日天气：紧跟日期行，雨天「记得带伞」同色同级 —— 是信息不是警示 */
.dh-weather {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 3px;
}

/* 备注不再是彩色小卡，退成一行次级灰正文（iOS 的 footer 就是这个位置和颜色） */
.dh-tip {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin-top: 6px;
}

.dh-acts {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 2px;
}

.dh-btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 16px;
  font-size: 13px;
  gap: 4px;
}

/* ── 当日安排的分组行 ── */
.tl-row {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  transition: background 0.12s ease;
}

.tl-row:active {
  background: var(--bg-subtle);
}

.tl-row.done {
  opacity: 0.5;
}

.tl-row.done .tl-title {
  text-decoration: line-through;
}

.tl-time-col {
  width: 42px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding-top: 2px;
}

.tl-time {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1;
}

/* 类型色点：整个 App 里唯一一处用颜色编码类型的地方，
   与下面标签的文字颜色同源，删掉任何一个信息都不丢。 */
.tl-node {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tl-body {
  flex: 1;
  min-width: 0;
}

.tl-line1 {
  display: flex;
  align-items: center;
  gap: 7px;
}

.tl-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.4;
}

.tl-more {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: -6px;
}

.tl-addr {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.tl-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 7px;
}

.tl-meta-item {
  font-size: 12px;
  color: var(--text-tertiary);
}

.tl-nav {
  font-size: 13px;
  font-weight: 500;
  /* 13px 文字 → brand-deep（2.85 → 4.81:1） */
  color: var(--brand-deep);
  padding: 2px 0;
}

.list-sep.indent-time {
  margin-left: 68px;
}

/* ── 「新建」行 ── */
.add-list {
  margin-top: 16px;
}

.add-row {
  gap: 8px;
}

.add-text {
  font-size: 15px;
  font-weight: 500;
  /* 15px 文字 → brand-deep */
  color: var(--brand-deep);
}

/* 弹层动作列表：iOS 的 action sheet 每一行都是 52px 高、带发丝分隔线 */
.acts {
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}

.act {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  font-size: 15px;
  color: var(--text-primary);
  border-bottom: 0.5px solid var(--hairline);
}

.act:last-child {
  border-bottom: none;
}

.act.danger {
  color: var(--danger);
}

.page {
  padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom));
}
</style>
