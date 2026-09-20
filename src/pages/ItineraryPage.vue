<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
