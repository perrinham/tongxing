<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { CATEGORY_META, CANVAS_CATEGORY_COLORS, money, moneyBrief } from '@/utils/format'
import type { PosterData } from '@/utils/poster'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppSheet from '@/components/AppSheet.vue'
import AppTabBar from '@/components/AppTabBar.vue'
import PosterCanvas from '@/components/PosterCanvas.vue'

const store = useTripStore()

const trip = computed(() => store.activeTrip)
const members = computed(() => (trip.value ? store.membersOf(trip.value.id) : []))
const result = computed(() => (trip.value ? store.settlementOf(trip.value.id) : null))

const showPoster = ref(false)
const posterData = ref<PosterData | null>(null)
const posterRef = ref<InstanceType<typeof PosterCanvas> | null>(null)
const toast = ref('')

const settled = computed(() => !!trip.value?.settledAt)

const maxAbs = computed(() => {
  if (!result.value) return 1
  return Math.max(1, ...result.value.balances.map((b) => Math.abs(b.net)))
})

function nameOf(id: string) {
  return store.members.find((m) => m.id === id)?.name || '未知'
}

function colorOf(id: string) {
  const m = store.members.find((x) => x.id === id)
  return m ? m.colorIndex : 0
}

function shareText() {
  if (!trip.value || !result.value) return ''
  const lines: string[] = []
  lines.push(`【${trip.value.title}】结算单`)
  lines.push(`总支出 ${money(result.value.total)} · 人均 ${money(result.value.perCapita)} · ${members.value.length} 人`)
  lines.push('')
  lines.push('各自净额：')
  result.value.balances
    .slice()
    .sort((a, b) => b.net - a.net)
    .forEach((b) => {
      const tag = b.net > 0.005 ? '应收' : b.net < -0.005 ? '应付' : '已平'
      lines.push(`${nameOf(b.memberId)}：${tag} ${money(Math.abs(b.net))}`)
    })
  lines.push('')
  if (result.value.transfers.length) {
    lines.push(`最少转账（${result.value.transfers.length} 笔）：`)
    result.value.transfers.forEach((t) => {
      lines.push(`${nameOf(t.fromId)} → ${nameOf(t.toId)}　${money(t.amount)}`)
    })
  } else {
    lines.push('账已经平了，不用转账')
  }
  return lines.join('\n')
}

async function copyText() {
  const text = shareText()
  uni.setClipboardData({
    data: text,
    success: () => {
      toast.value = '结算文案已复制'
      setTimeout(() => (toast.value = ''), 1800)
    },
    fail: () => {
      toast.value = '复制失败'
      setTimeout(() => (toast.value = ''), 1800)
    }
  })
}

function makePoster() {
  if (!trip.value || !result.value) return
  posterData.value = {
    title: trip.value.title,
    destination: trip.value.destination,
    range: `${trip.value.startDate} → ${trip.value.endDate}`,
    total: result.value.total,
    perCapita: result.value.perCapita,
    peopleCount: members.value.length,
    balances: result.value.balances.map((b) => ({
      name: nameOf(b.memberId),
      net: b.net,
      colorIndex: colorOf(b.memberId)
    })),
    transfers: result.value.transfers.map((t) => ({
      from: nameOf(t.fromId),
      to: nameOf(t.toId),
      amount: t.amount
    })),
    categories: result.value.byCategory.map((c) => ({
      label: CATEGORY_META[c.category].label,
      amount: c.amount,
      // ⚠️ 这里必须用字面值版本，不能用 CATEGORY_META 的 `var(--cat-*)`：
      // canvas 的 fillStyle 不认识 CSS 变量，非法值会被**静默忽略**，
      // 结果是海报上所有分类圆点/条形都沿用上一处设过的色（全一个色）。
      color: CANVAS_CATEGORY_COLORS[c.category]
    }))
  }
  showPoster.value = true
}

function downloadPoster() {
  if (!posterRef.value) return
  posterRef.value.save()
}

// H5 端是下载文件而不是存相册，文案由 PosterCanvas 带过来
function onPosterSaved(text?: string) {
  toast.value = text || '已保存到相册'
  setTimeout(() => (toast.value = ''), 1800)
}

function onPosterError(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 1800)
}

function toggleSettled() {
  if (!trip.value) return
  store.markSettled(trip.value.id, !settled.value)
}

function goCreate() {
  nav.to('trip-create')
}
</script>

<template>
  <div class="page">
    <AppNav title="结算" :subtitle="trip ? trip.title : ''" border />

    <template v-if="!trip">
      <AppEmpty
        icon="scale"
        title="还没有行程"
        desc="先创建行程并记账，这里会自动算出谁欠谁"
        action="创建我的行程"
        @action="goCreate"
      />
    </template>

    <template v-else-if="result">
      <div class="page-body">
        <!-- 总览 -->
        <div class="list hero-card">
          <div class="hero-top">
            <div class="grow">
              <p class="hero-label">总支出</p>
              <p class="hero-total num">{{ money(result.total, trip.currency) }}</p>
            </div>
            <span v-if="settled" class="tint settled-badge">
              <AppIcon name="check" :size="12" color="var(--brand-deep)" :stroke="2.6" />
              已结清
            </span>
          </div>
          <div class="list-sep" />
          <div class="list-row hero-meta">
            <span>{{ members.length }} 人 · 人均 {{ moneyBrief(result.perCapita, trip.currency) }}</span>
            <span class="grow" />
            <span>{{ store.expensesOf(trip.id).length }} 笔账</span>
          </div>
        </div>

        <!-- 净额 -->
        <div class="sec-title">
          <h2>各自净额</h2>
          <span class="sec-hint">正数应收，负数应付</span>
        </div>
        <div class="list">
          <template v-for="(b, i) in result.balances" :key="b.memberId">
            <div v-if="i" class="list-sep indent-avatar" />
            <div class="bal">
              <AppAvatar :name="nameOf(b.memberId)" :color-index="colorOf(b.memberId)" :size="32" />
              <div class="bal-mid">
                <div class="bal-top">
                  <span class="bal-name">{{ nameOf(b.memberId) }}</span>
                  <span
                    class="bal-net num"
                    :class="{ plus: b.net > 0.005, minus: b.net < -0.005 }"
                  >
                    {{ b.net > 0.005 ? '+' : b.net < -0.005 ? '-' : '' }}{{ money(Math.abs(b.net), trip.currency) }}
                  </span>
                </div>
                <div class="bar-track">
                  <span
                    class="bar-fill"
                    :class="{ plus: b.net > 0.005, minus: b.net < -0.005 }"
                    :style="{ width: `${(Math.abs(b.net) / maxAbs) * 100}%` }"
                  />
                </div>
                <p class="bal-sub">
                  付了 {{ moneyBrief(b.paid, trip.currency) }} · 该担
                  {{ moneyBrief(b.shouldPay, trip.currency) }}
                </p>
              </div>
            </div>
          </template>
        </div>

        <!-- 转账方案 -->
        <div class="sec-title">
          <h2>最少转账方案</h2>
          <span class="sec-hint">{{ result.transfers.length }} 笔</span>
        </div>
        <div class="list">
          <div v-if="result.transfers.length" class="transfers">
            <template v-for="(t, i) in result.transfers" :key="i">
              <div v-if="i" class="list-sep" />
              <div class="trans">
                <AppAvatar :name="nameOf(t.fromId)" :color-index="colorOf(t.fromId)" :size="30" />
                <span class="trans-name ellipsis">{{ nameOf(t.fromId) }}</span>
                <span class="trans-arrow">
                  <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
                </span>
                <AppAvatar :name="nameOf(t.toId)" :color-index="colorOf(t.toId)" :size="30" />
                <span class="trans-name ellipsis">{{ nameOf(t.toId) }}</span>
                <span class="grow" />
                <span class="trans-amt num">{{ money(t.amount, trip.currency) }}</span>
              </div>
            </template>
          </div>
          <div v-else class="flat">
            <div class="flat-icon">
              <AppIcon name="check" :size="22" color="var(--brand)" :stroke="2.4" />
            </div>
            <p class="flat-title">账已经平了</p>
            <p class="flat-sub">没有需要转账的款项</p>
          </div>
        </div>
        <p v-if="result.transfers.length" class="list-foot">
          贪心配对算出，比逐笔两两转账少很多次。照着转完就平了。
        </p>

        <!-- 分类 -->
        <template v-if="result.byCategory.length">
          <div class="sec-title">
            <h2>花在哪儿了</h2>
          </div>
          <div class="list">
            <div class="cat-list">
              <div v-for="c in result.byCategory" :key="c.category" class="cat-row">
                <span class="cat-label">{{ CATEGORY_META[c.category].label }}</span>
                <span class="cat-track">
                  <span
                    class="cat-fill"
                    :style="{
                      width: `${(c.amount / result.total) * 100}%`,
                      background: CATEGORY_META[c.category].color
                    }"
                  />
                </span>
                <span class="cat-amt num">{{ moneyBrief(c.amount, trip.currency) }}</span>
                <span class="cat-pct num">{{ Math.round((c.amount / result.total) * 100) }}%</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 操作 -->
        <div class="actions">
          <button class="btn-primary act-full" @click="makePoster">
            <AppIcon name="share" :size="18" />
            生成结算海报
          </button>
          <div class="action-row">
            <button class="btn-ghost grow-btn" @click="copyText">
              <AppIcon name="copy" :size="17" />
              复制文案
            </button>
            <button class="btn-ghost grow-btn" @click="toggleSettled">
              <AppIcon name="check" :size="17" />
              {{ settled ? '取消结清' : '标记结清' }}
            </button>
          </div>
        </div>

        <p class="list-foot tip">
          分摊口径：每笔账按「付款人已付 − 参与者应担」计算净额，未参与的人不计入。
        </p>
      </div>
    </template>

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>

    <AppSheet v-model="showPoster" title="结算海报">
      <PosterCanvas v-if="posterData" ref="posterRef" :data="posterData" @saved="onPosterSaved" @error="onPosterError" />
      <template #footer>
        <button class="btn-primary" @click="downloadPoster">保存到相册</button>
      </template>
    </AppSheet>

    <AppTabBar current="settle" />
  </div>
</template>

<style scoped>
.hero-card {
  margin-top: 4px;
}

.hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 14px;
}

.hero-label {
  font-size: 13px;
  color: var(--text-tertiary);
}

.hero-total {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.6px;
  margin-top: 2px;
  color: var(--text-primary);
}

.settled-badge {
  height: 24px;
  margin-top: 4px;
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-weight: 600;
}

.hero-meta {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 净额行：头像 + 姓名/净额/进度条/明细。
   行内三行文字，所以不用 .list-row 的 44px 单行约束。 */
.bal {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.bal-mid {
  flex: 1;
  min-width: 0;
}

.bal-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.bal-name {
  font-size: 15px;
  font-weight: 500;
}

.bal-net {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-tertiary);
}

/* 应收绿、应付橙 —— 两者都是「品牌色系之外的中性强调」，
   不引入红（红在本项目里专用于「删除」这类破坏性操作）。 */
.bal-net.plus {
  color: var(--brand-deep);
}

.bal-net.minus {
  /* 兄弟选择器 .plus 用的是 brand-deep（4.8:1），这里原来用 accent 基色只有 3.05:1
     —— 同一对「应收/应付」不对称。改走 accent-deep（5.3:1）。 */
  color: var(--accent-deep);
}

.bar-track {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-subtle);
  margin: 7px 0 5px;
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--line-strong);
  transition: width 0.35s var(--ease-out);
}

.bar-fill.plus {
  background: var(--brand);
}

.bar-fill.minus {
  background: var(--accent);
}

.bal-sub {
  font-size: 12px;
  color: var(--text-tertiary);
}

.list-sep.indent-avatar {
  margin-left: 60px;
}

.transfers {
  display: flex;
  flex-direction: column;
}

.trans {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 16px;
}

.trans-name {
  font-size: 14px;
  max-width: 56px;
}

.trans-arrow {
  display: flex;
  align-items: center;
}

.trans-amt {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}

.flat {
  text-align: center;
  padding: 24px 0;
}

.flat-icon {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--brand-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
}

.flat-title {
  font-size: 15px;
  font-weight: 600;
}

.flat-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}

.cat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}

.cat-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cat-label {
  width: 40px;
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.cat-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-subtle);
  overflow: hidden;
}

.cat-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
}

.cat-amt {
  width: 58px;
  text-align: right;
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.cat-pct {
  width: 34px;
  text-align: right;
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.actions {
  margin-top: 26px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* button 是替换元素，在纵向 flex 里不会被拉满 —— 必须显式给宽度 */
.act-full {
  width: 100%;
}

.action-row {
  display: flex;
  gap: 10px;
}

.grow-btn {
  flex: 1;
}

.tip {
  margin-top: 16px;
}

/* iOS 的 HUD 提示：深色半透明胶囊 */
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 28px);
  transform: translateX(-50%);
  background: rgba(28, 28, 30, 0.88);
  color: #fff;
  font-size: 13px;
  padding: 10px 18px;
  border-radius: 20px;
  z-index: 200;
  white-space: nowrap;
}

.page {
  padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom));
}

.poster-wrap {
  display: flex;
  justify-content: center;
  padding: 4px 0 12px;
}

.poster-img {
  width: 100%;
  max-width: 320px;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lift);
  display: block;
}
</style>
