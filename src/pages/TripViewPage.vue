<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { moneyBrief, shortDate, weekday, itemMetaOf, categoryMetaOf } from '@/utils/format'
import AppNav from '@/components/AppNav.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppIcon from '@/components/AppIcon.vue'
import { checkItinerary, type ItinIssue } from '@/utils/itinCheck'
import type { Day, TripSpaceFull } from '@/types'

const store = useTripStore()

const space = ref<TripSpaceFull | null>(null)
const loading = ref(true)
const errorText = ref('')

// 页面卸载后不再回写异步结果（防止晚到的响应覆盖新页面状态）
let alive = true
onUnmounted(() => {
  alive = false
})

const trip = computed(() => space.value?.doc.trip || null)
const members = computed(() => space.value?.doc.members || [])
const days = computed<Day[]>(() =>
  [...(space.value?.doc.days || [])].sort((a, b) => a.index - b.index)
)

/** 本地是否也有这份行程（有 → 可以「进入编辑」跳回行程页） */
const editable = computed(() => {
  if (!space.value) return false
  return store.trips.some((t) => t.id === space.value!.id)
})

function itemsOf(dayId: string) {
  const list = (space.value?.doc.items || []).filter((i) => i.dayId === dayId)
  return list.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))
}

function expensesOf(dayId: string) {
  const day = days.value.find((d) => d.id === dayId)
  if (!day) return []
  return (space.value?.doc.expenses || []).filter((e) => e.date === day.date)
}

const totalSpend = computed(() =>
  (space.value?.doc.expenses || []).reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
)

function itemsCost(dayId: string): number {
  return itemsOf(dayId).reduce((sum, i) => sum + (Number(i.cost) || 0), 0)
}

function goEdit() {
  if (!space.value || !editable.value) return
  store.setActiveTrip(space.value.id)
  nav.replace('itinerary')
}

/** 行程回放：只读浏览也能放（走 getSpace，不要求本地有这份行程） */
function goReplay() {
  if (!space.value) return
  nav.to('replay', { id: space.value.id })
}

// ── 只读页的核验摘要：纯零成本规则收尾（不注入 route，绝不因浏览而出网）──
const issues = ref<ItinIssue[]>([])
const badIds = ref<Set<string>>(new Set())

onLoad(async (options: Record<string, any> | undefined) => {
  const id = String(options?.id || '')
  if (!id) {
    errorText.value = '缺少行程 id'
    loading.value = false
    return
  }
  try {
    const r = await store.api().getSpace(id)
    if (!alive) return
    space.value = r.space
    // 校验失败不阻塞浏览，静默空列表即可
    const found = await checkItinerary(r.space.doc.items || [])
    if (!alive) return
    issues.value = found
    badIds.value = new Set(found.flatMap((x) => x.itemIds))
  } catch (e) {
    if (!alive) return
    errorText.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (alive) loading.value = false
  }
})
</script>

<template>
  <div class="page">
    <AppNav :title="trip ? trip.title : '行程详情'" :subtitle="trip ? trip.destination : ''" back border />

    <p v-if="loading" class="hint center">加载中…</p>
    <AppEmpty v-else-if="errorText" icon="map" title="打不开这个行程" :desc="errorText" />

    <template v-else-if="space">
      <!-- 概览 -->
      <div class="page-body">
        <div class="overview">
          <div class="ov-row">
            <div class="ov-item">
              <span class="ov-num num">{{ days.length }}</span>
              <span class="ov-label">天</span>
            </div>
            <div class="ov-sep" />
            <div class="ov-item">
              <span class="ov-num num">{{ members.length }}</span>
              <span class="ov-label">人</span>
            </div>
            <div class="ov-sep" />
            <div class="ov-item">
              <span class="ov-num num">{{ space.doc.items.length }}</span>
              <span class="ov-label">个安排</span>
            </div>
          </div>
          <p v-if="trip && trip.startDate" class="ov-dates">
            {{ shortDate(trip.startDate) }} {{ weekday(trip.startDate) }}
            <template v-if="trip.endDate && trip.endDate !== trip.startDate">
              ~ {{ shortDate(trip.endDate) }}
            </template>
          </p>
          <p v-if="totalSpend > 0" class="ov-spend">
            已记 {{ moneyBrief(totalSpend, trip?.currency) }}
          </p>
          <p v-if="issues.length" class="ov-check bad">
            {{ issues.length }} 处值得核验 · 进入编辑看详情
          </p>
          <p v-else class="ov-check ok">行程校验通过 ✓</p>
          <p class="ov-readonly">
            <AppIcon name="location" :size="13" color="var(--brand)" />
            只读浏览 · 来自「发现」广场
          </p>
        </div>

        <button class="replay-btn" @click="goReplay">
          <AppIcon name="location" :size="16" />
          行程回放
        </button>
        <button v-if="editable" class="edit-btn" @click="goEdit">
          <AppIcon name="map" :size="16" />
          进入编辑
        </button>
      </div>

      <!-- 按天浏览 -->
      <div class="page-body">
        <p v-if="!days.length" class="hint">这段行程还没有安排</p>
        <section v-for="d in days" :key="d.id" class="day">
          <header class="day-head">
            <span class="day-idx">D{{ d.index + 1 }}</span>
            <div class="grow">
              <p class="day-title">{{ d.title }}</p>
              <p class="day-sub">{{ shortDate(d.date) }} {{ weekday(d.date) }}</p>
            </div>
            <span v-if="itemsCost(d.id) > 0" class="day-cost num">
              {{ moneyBrief(itemsCost(d.id), trip?.currency) }}
            </span>
          </header>
          <div class="items">
            <div v-for="it in itemsOf(d.id)" :key="it.id" class="item">
              <span class="it-time num">{{ it.time || '--:--' }}</span>
              <span class="it-dot" :style="{ background: itemMetaOf(it.type).color }" />
              <div class="grow">
                <p class="it-title">{{ it.title }}</p>
                <p v-if="it.address" class="it-addr">{{ it.address }}</p>
              </div>
              <span v-if="badIds.has(it.id)" class="it-flag">待核实</span>
              <span v-if="it.cost > 0" class="it-cost num">
                {{ moneyBrief(it.cost, trip?.currency) }}
              </span>
            </div>
          </div>
          <div v-if="expensesOf(d.id).length" class="exps">
            <div v-for="e in expensesOf(d.id)" :key="e.id" class="exp">
              <span class="exp-cat" :style="{ background: categoryMetaOf(e.category).bg }">
                {{ categoryMetaOf(e.category).label }}
              </span>
              <span class="exp-title">{{ e.title }}</span>
              <span class="exp-amount num">{{ moneyBrief(e.amount, trip?.currency) }}</span>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-page);
  padding-bottom: 32px;
}

.center {
  text-align: center;
  padding-top: 40px;
}

.hint {
  margin: 10px 2px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.page-body {
  padding: 12px 16px 0;
}

.overview {
  padding: 16px;
  background: var(--bg-card, #ffffff);
  border-radius: 16px;
  box-shadow: 0 1px 0 var(--hairline);
}

.ov-row {
  display: flex;
  align-items: center;
}

.ov-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.ov-sep {
  width: 1px;
  height: 26px;
  background: var(--hairline);
}

.ov-num {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.ov-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.ov-dates,
.ov-spend {
  margin-top: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.ov-readonly {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.ov-check {
  margin-top: 10px;
  text-align: center;
  font-size: 12px;
}

.ov-check.ok {
  color: var(--brand-deep);
}

.ov-check.bad {
  color: var(--warn-deep);
}

.it-flag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--warn-deep);
  background: var(--warn-soft);
}

.edit-btn {
  margin-top: 12px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  background: var(--brand-deep);
  border-radius: 14px;
}

/* 行程回放入口（浅色次钮，显式 flex 居中同口径） */
.replay-btn {
  margin-top: 12px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--brand-soft);
  border-radius: 14px;
}

.day {
  margin-bottom: 18px;
}

.day-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px 10px;
}

.day-idx {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-deep);
  background: var(--brand-soft);
  padding: 4px 8px;
  border-radius: 10px;
}

.day-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.day-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.day-cost {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.grow {
  flex: 1;
  min-width: 0;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--bg-card, #ffffff);
  border-radius: 14px;
  box-shadow: 0 1px 0 var(--hairline);
}

.it-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tertiary);
  width: 40px;
}

.it-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.it-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.it-addr {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.it-cost {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.exps {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exp {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-subtle, #f3f2ee);
  border-radius: 12px;
}

.exp-cat {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
}

.exp-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exp-amount {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-primary);
}
</style>
