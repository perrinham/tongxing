<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryMetaOf,
  money,
  moneyBrief,
  shortDate,
  weekday
} from '@/utils/format'
import type { ExpenseCategory } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppTabBar from '@/components/AppTabBar.vue'

const store = useTripStore()

const trip = computed(() => store.activeTrip)
const filter = ref<ExpenseCategory | 'all'>('all')

const all = computed(() => (trip.value ? store.expensesOf(trip.value.id) : []))
const members = computed(() => (trip.value ? store.membersOf(trip.value.id) : []))

const list = computed(() =>
  filter.value === 'all' ? all.value : all.value.filter((e) => e.category === filter.value)
)

const total = computed(() => (trip.value ? store.spentOf(trip.value.id) : 0))
// 人均必须走结算口径（按参与人摊，剔除非参与者），不能简单除以成员数
const perCapita = computed(() => (trip.value ? store.settlementOf(trip.value.id).perCapita : 0))
const myShare = computed(() => {
  const me = members.value.find((m) => m.isSelf) || members.value[0]
  if (!me || !trip.value) return 0
  const s = store.settlementOf(trip.value.id)
  const b = s.balances.find((x) => x.memberId === me.id)
  return b ? b.shouldPay : 0
})

/** 分类占比条 */
const bars = computed(() => {
  const map = new Map<ExpenseCategory, number>()
  all.value.forEach((e) => map.set(e.category, (map.get(e.category) || 0) + e.amount))
  const max = Math.max(1, ...Array.from(map.values()))
  return CATEGORY_ORDER.map((c) => ({
    category: c,
    amount: map.get(c) || 0,
    pct: ((map.get(c) || 0) / max) * 100
  })).filter((x) => x.amount > 0)
})

/** 按日期分组 */
const grouped = computed(() => {
  const map = new Map<string, typeof list.value>()
  list.value.forEach((e) => {
    const arr = map.get(e.date) || []
    arr.push(e)
    map.set(e.date, arr)
  })
  return Array.from(map.entries()).map(([date, items]) => ({
    date,
    items,
    sum: items.reduce((s, i) => s + i.amount, 0)
  }))
})

function payerName(id: string) {
  return store.members.find((m) => m.id === id)?.name || '未知'
}

/** 参与人摘要：全部 / 部分 */
function participantText(e: (typeof list.value)[number]) {
  const names = e.participants
    .map((p) => store.members.find((m) => m.id === p.memberId)?.name)
    .filter(Boolean) as string[]
  if (!names.length) return ''
  if (names.length === members.value.length) return '全员'
  if (names.length === 1) return `仅 ${names[0]}`
  return `${names.length} 人`
}

function addExpense() {
  nav.to('expense-edit')
}

function editExpense(id: string) {
  nav.to('expense-edit', { id })
}

function goCreate() {
  nav.to('trip-create')
}
</script>

<template>
  <div class="page">
    <AppNav title="记账" :subtitle="trip ? trip.title : ''" border />

    <template v-if="!trip">
      <AppEmpty
        icon="wallet"
        title="还没有行程"
        desc="账要记在行程上，先创建一段旅程"
        action="创建我的行程"
        @action="goCreate"
      />
    </template>

    <template v-else>
      <!-- 总览：一张分组卡。顶部是主数字，下面一行三个次级指标。
           不再有顶部装饰条，主数字也不再走渐变字（大字号下渐变会发虚）。 -->
      <div class="page-body">
        <div class="list summary">
          <div class="sum-hero">
            <p class="sum-label">总支出</p>
            <p class="sum-value num">{{ money(total, trip.currency) }}</p>
          </div>
          <div class="list-sep" />
          <div class="stat3 col">
            <div class="stat">
              <span class="stat-num num">{{ moneyBrief(perCapita, trip.currency) }}</span>
              <span class="stat-unit">人均</span>
            </div>
            <div class="stat">
              <span class="stat-num num">{{ moneyBrief(myShare, trip.currency) }}</span>
              <span class="stat-unit">我的份额</span>
            </div>
            <div class="stat">
              <span class="stat-num num">{{ all.length }}</span>
              <span class="stat-unit">笔数</span>
            </div>
          </div>
        </div>

        <template v-if="bars.length">
          <p class="list-head">分类占比</p>
          <div class="list breakdown">
            <div class="bd-list">
              <div v-for="b in bars" :key="b.category" class="bd-row">
                <span class="bd-name">{{ categoryMetaOf(b.category).label }}</span>
                <span class="bd-track">
                  <span
                    class="bd-fill"
                    :style="{
                      width: `${b.pct}%`,
                      background: categoryMetaOf(b.category).color
                    }"
                  />
                </span>
                <span class="bd-amt num">{{ moneyBrief(b.amount, trip.currency) }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 筛选。外面套 scroll-view：小程序端普通 div 横滑是无效的 -->
      <scroll-view class="filters-scroll" scroll-x :show-scrollbar="false">
        <div class="filters">
          <button class="chip" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
          <button
            v-for="c in CATEGORY_ORDER"
            :key="c"
            class="chip"
            :class="{ active: filter === c }"
            @click="filter = c"
          >
            {{ CATEGORY_META[c].label }}
          </button>
        </div>
      </scroll-view>

      <!-- 流水 -->
      <div class="page-body">
        <div v-if="grouped.length" class="groups">
          <div v-for="g in grouped" :key="g.date" class="group">
            <div class="group-head">
              <span class="gh-date">{{ shortDate(g.date) }} {{ weekday(g.date) }}</span>
              <span class="gh-sum num">{{ moneyBrief(g.sum, trip.currency) }}</span>
            </div>
            <div class="list">
              <template v-for="(e, i) in g.items" :key="e.id">
                <div v-if="i" class="list-sep indent-icon" />
                <div class="exp" @click="editExpense(e.id)">
                  <span
                    class="exp-icon"
                    :style="{
                      background: categoryMetaOf(e.category).bg,
                      color: categoryMetaOf(e.category).color
                    }"
                  >
                    <AppIcon :name="categoryMetaOf(e.category).icon" :size="18" />
                  </span>
                  <div class="grow exp-mid">
                    <p class="exp-title ellipsis">{{ e.title }}</p>
                    <p class="exp-sub ellipsis">
                      {{ payerName(e.payerId) }} 付
                      <span class="dot-sep">·</span>
                      {{ participantText(e) }}
                    </p>
                  </div>
                  <span class="exp-amt num">{{ moneyBrief(e.amount, trip.currency) }}</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <AppEmpty
          v-else
          icon="wallet"
          :title="filter === 'all' ? '还没有账单' : '这个分类下没有账单'"
          :desc="filter === 'all' ? '记第一笔，后面结算会自动算好' : '换个分类看看'"
          :action="filter === 'all' ? '记第一笔' : ''"
          @action="addExpense"
        />
      </div>

      <button class="fab" @click="addExpense">
        <AppIcon name="plus" :size="22" color="#fff" :stroke="2.2" />
      </button>
    </template>

    <AppTabBar current="expense" />
  </div>
</template>

<style scoped>
.summary {
  margin-top: 4px;
}

.sum-hero {
  padding: 16px 16px 14px;
}

.sum-label {
  font-size: 13px;
  color: var(--text-tertiary);
}

/* 主数字：iOS 里最大的一级数字，纯色、负字距（系统字体的紧凑感来自字形，不靠渐变） */
.sum-value {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.6px;
  color: var(--text-primary);
  margin-top: 2px;
}

/* 分类占比：横向条形图。轨道用系统灰，填充用分类色 */
.breakdown {
  padding: 14px 16px;
}

.bd-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.bd-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bd-name {
  width: 40px;
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.bd-track {
  flex: 1;
  height: 7px;
  border-radius: 4px;
  background: var(--bg-subtle);
  overflow: hidden;
}

.bd-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s var(--ease-out);
}

.bd-amt {
  width: 64px;
  text-align: right;
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

/* ── 筛选 ──
   scroll-view 负责横滑，内层 div 用 inline-flex 保证一行排开不换行。 */
.filters-scroll {
  width: 100%;
  white-space: nowrap;
  padding: 18px 0 0;
}

.filters {
  display: inline-flex;
  gap: 8px;
  padding: 0 16px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 8px;
  /* ⚠️ 必须手动给 FAB 留白。
     `.fab` 是 `position: fixed`，完全不占文档流；页面的 `padding-bottom` 只避开了底部
     tabbar，没避开这颗按钮。结果是滚到最后一笔时，右下角的绿色「+」正好盖住该笔金额
     （54px 直径 + 18px 右边距）。这里补 54 + 24 = 78px。 */
  padding-bottom: 78px;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 7px;
}

.gh-date {
  font-size: 13px;
  color: var(--text-tertiary);
}

.gh-sum {
  font-size: 13px;
  color: var(--text-secondary);
}

.exp {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 16px;
  transition: background 0.12s ease;
}

.exp:active {
  background: var(--bg-subtle);
}

/* 行首图标：小圆角方块 + 分类浅色底 */
.exp-icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.exp-mid {
  min-width: 0;
}

.exp-title {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.4;
}

.exp-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.dot-sep {
  /* 它只是「我 付 · 全员」中间的分隔符，但它是**字形**而不是线：
     `--line-strong`(#D1D1D6) 是画分隔线用的，压白卡只有 1.52:1，落在正文里就是「糊」。
     跟同级文字用同一级灰（tertiary）即可 —— 与左右两个字读起来是连续的。 */
  color: var(--text-tertiary);
}

.exp-amt {
  font-size: 16px;
  font-weight: 500;
  flex-shrink: 0;
}

/* 分隔线缩到图标右边，与文字列对齐 */
.list-sep.indent-icon {
  margin-left: 61px;
}

.fab {
  position: fixed;
  right: calc(50% - 240px + 18px);
  bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 18px);
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 投影收得很淡：iOS 的悬浮按钮靠色块本身被看见，不靠一圈彩色光晕 */
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
  z-index: 25;
  transition: transform 0.12s ease;
}

.fab:active {
  transform: scale(0.94);
}

.page {
  padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom));
}

@media (max-width: 480px) {
  .fab {
    right: 18px;
  }
}
</style>
