<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { CATEGORY_META, CATEGORY_ORDER, categoryMetaOf, money, todayISO } from '@/utils/format'
import { splitAmount } from '@/utils/settlement'
import { evalAmountExpr } from '@/utils/amountExpr'
import type { ExpenseCategory, SplitMode } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'
import AppEmpty from '@/components/AppEmpty.vue'

const store = useTripStore()

const trip = computed(() => store.activeTrip)
const members = computed(() => (trip.value ? store.membersOf(trip.value.id) : []))
/** 模板里安全取货币符号，避免 trip 为 null 时的类型告警 */
const currency = computed(() => trip.value?.currency || '¥')

const editId = ref('')
const isEdit = computed(() => !!editId.value)

/**
 * 带 ?id= 进入但本地找不到这笔账单（典型：队友已删、墓碑同步落地，而入口列表还是旧的）。
 * 必须显式报错而不是静默降级成「记一笔」——那会让用户以为在编辑，保存后凭空多出一笔重复账单。
 */
const missing = ref(false)

const amountText = ref('')
const title = ref('')
const category = ref<ExpenseCategory>('food')
const payerId = ref('')
const date = ref(todayISO())
const note = ref('')
const splitMode = ref<SplitMode>('even')
const participantIds = ref<string[]>([])
/** 权重模式：memberId -> 权重 */
const weights = ref<Record<string, number>>({})
/** 自定义模式：memberId -> 金额文本 */
const customAmounts = ref<Record<string, string>>({})

/**
 * 金额求值：amountText 现在可以是算式（68+35×2），统一走 amountExpr 解析。
 * 非法/未写完的算式 → null → 0 → canSave 自动关闭，分享预览等下游无感。
 */
const amount = computed(() => evalAmountExpr(amountText.value) ?? 0)

/** 输入的是不是算式（含运算符）：是的话金额区右侧给出实时结果预览 */
const exprEq = computed(() => {
  const hasOp = /[+×÷-]/.test(amountText.value)
  return hasOp && amount.value > 0 ? amount.value : null
})

const canSave = computed(
  () =>
    amount.value > 0 &&
    participantIds.value.length > 0 &&
    !!payerId.value &&
    // custom 模式必须把金额分完：余额 ≠0 就保存会被按比例悄悄缩放，入账与输入不符
    (splitMode.value !== 'custom' || Math.abs(customRemain.value) < 0.005)
)

/** 均分结果，用于预览 */
const evenPreview = computed(() => {
  const n = participantIds.value.length || 1
  return amount.value / n
})

/** 自定义模式下未分配的余额 */
const customRemain = computed(() => {
  const sum = participantIds.value.reduce(
    (s, id) => s + (Number(customAmounts.value[id]) || 0),
    0
  )
  return Math.round((amount.value - sum) * 100) / 100
})

/** 权重模式的占比预览 */
const weightPreview = computed(() => {
  const total = participantIds.value.reduce((s, id) => s + (weights.value[id] || 1), 0) || 1
  const map: Record<string, number> = {}
  participantIds.value.forEach((id) => {
    map[id] = (amount.value * (weights.value[id] || 1)) / total
  })
  return map
})

/** 记账时真实份额，用于「按份额预览」 */
const sharePreview = computed(() => {
  const fake = {
    id: 'preview',
    tripId: trip.value?.id || '',
    title: title.value,
    amount: amount.value,
    category: category.value,
    date: date.value,
    payerId: payerId.value,
    participants: participantIds.value.map((id) => ({
      memberId: id,
      share:
        splitMode.value === 'custom'
          ? Number(customAmounts.value[id]) || 0
          : splitMode.value === 'weight'
            ? weights.value[id] || 1
            : 1
    })),
    splitMode: splitMode.value,
    note: '',
    createdAt: 0
  }
  const m = splitAmount(fake)
  const out: Record<string, number> = {}
  m.forEach((cent, id) => {
    out[id] = cent / 100
  })
  return out
})

/**
 * 4×4 键盘：数字照旧，右列四格换成运算符与退格 —— 原 3×4 的 12 个键
 * 加上 + - × ÷ 恰好铺满，行数不变所以页面底部留白不用重算。
 * 小数点是「每段一个」（68+35.5 合法、68+.5.. 不可能被敲出来）。
 */
const keys = ['7', '8', '9', 'del', '4', '5', '6', '÷', '1', '2', '3', '×', '+', '0', '.', '-']

onLoad((options: Record<string, any> | undefined) => {
  if (!trip.value) {
    nav.replace('itinerary')
    return
  }
  const self = members.value.find((m) => m.isSelf) || members.value[0]
  payerId.value = self?.id || ''
  participantIds.value = members.value.map((m) => m.id)
  members.value.forEach((m) => {
    weights.value[m.id] = 1
  })

  const id = options?.id || ''
  if (id) {
    const e = store.expenses.find((x) => x.id === id)
    if (e) {
      editId.value = e.id
      amountText.value = String(e.amount)
      title.value = e.title
      category.value = e.category
      payerId.value = e.payerId
      date.value = e.date
      note.value = e.note
      splitMode.value = e.splitMode
      participantIds.value = e.participants.map((p) => p.memberId)
      e.participants.forEach((p) => {
        weights.value[p.memberId] = p.share || 1
        if (e.splitMode === 'custom') {
          customAmounts.value[p.memberId] = String(p.share)
        }
      })
    } else {
      missing.value = true
    }
  }
})

const OPS = ['+', '-', '×', '÷']

/** 从文本尾部找当前操作数段的起点（运算符之后） */
function segStart(t: string): number {
  for (let i = t.length - 1; i >= 0; i--) {
    if (OPS.includes(t[i])) return i + 1
  }
  return 0
}

function press(k: string) {
  const t = amountText.value
  if (k === 'del') {
    amountText.value = t.slice(0, -1)
    return
  }
  const start = segStart(t)
  const seg = t.slice(start)
  if (k === '.') {
    if (seg.includes('.')) return
    // 段空（开头/刚敲完运算符）补个 0，避免出现「68+.」这种段
    amountText.value = seg ? t + '.' : t + '0.'
    return
  }
  if (OPS.includes(k)) {
    // 运算符不能开头、不能连按（简单拒绝而非替换，删一格比猜用户意图便宜）
    if (!t || OPS.includes(t[t.length - 1])) return
    amountText.value = t + k
    return
  }
  // 数字：段内前导零直接顶掉（'0' 后敲 '5' 得 '5'，而不是 '05'）
  if (seg === '0') {
    amountText.value = t.slice(0, start) + k
    return
  }
  const dot = seg.indexOf('.')
  if (dot >= 0 && seg.length - dot - 1 >= 2) return // 每段最多两位小数
  if (t.length >= 14) return
  amountText.value = t + k
}

function toggleParticipant(id: string) {
  const i = participantIds.value.indexOf(id)
  if (i >= 0) {
    if (participantIds.value.length <= 1) return
    participantIds.value.splice(i, 1)
  } else {
    participantIds.value.push(id)
  }
  // 保持顺序与成员列表一致
  participantIds.value = members.value.filter((m) => participantIds.value.includes(m.id)).map((m) => m.id)
}

function allSelected() {
  return participantIds.value.length === members.value.length
}

function toggleAll() {
  // 收起即「只选自己」：自己以 isSelf 标记为准 —— 成员可删可重排，首位不一定是自己
  const selfId = members.value.find((m) => m.isSelf)?.id
  participantIds.value = allSelected()
    ? [selfId || members.value[0]?.id].filter(Boolean)
    : members.value.map((m) => m.id)
}

function stepWeight(id: string, dir: 1 | -1) {
  const cur = weights.value[id] || 1
  const next = Math.min(10, Math.max(0.5, Math.round((cur + dir * 0.5) * 2) / 2))
  weights.value[id] = next
}

function setCustom(id: string, v: string) {
  customAmounts.value[id] = v.replace(/[^\d.]/g, '')
}

/** 补齐余额到某个人身上，省去手算 */
function fillRemain(id: string) {
  const cur = Number(customAmounts.value[id]) || 0
  const next = Math.round((cur + customRemain.value) * 100) / 100
  customAmounts.value[id] = String(Math.max(0, next))
}

function onDateChange(e: { detail: { value: string } }) {
  date.value = e.detail.value
}

function save() {
  if (!canSave.value || !trip.value) return
  const participants = participantIds.value.map((id) => ({
    memberId: id,
    share:
      splitMode.value === 'custom'
        ? Number(customAmounts.value[id]) || 0
        : splitMode.value === 'weight'
          ? weights.value[id] || 1
          : 1
  }))

  const payload = {
    tripId: trip.value.id,
    title: title.value.trim() || categoryMetaOf(category.value).label,
    amount: amount.value,
    category: category.value,
    date: date.value,
    payerId: payerId.value,
    participants,
    splitMode: splitMode.value,
    note: note.value
  }

  if (isEdit.value) store.updateExpense(editId.value, payload)
  else store.addExpense(payload)

  nav.back()
}

function remove() {
  if (!isEdit.value) return
  store.removeExpense(editId.value)
  nav.back()
}

const quickAmounts = [50, 100, 200, 500]
</script>

<template>
  <div class="page edit-page">
    <AppNav :title="isEdit || missing ? '编辑账单' : '记一笔'" back>
      <template #right>
        <button v-if="isEdit" class="nav-icon" @click="remove">
          <AppIcon name="trash" :size="19" color="var(--danger)" />
        </button>
      </template>
    </AppNav>

    <!-- 找不到这笔账单：显式空态，绝不渲染创建表单（防止把「编辑」误存成新账单） -->
    <AppEmpty
      v-if="missing"
      icon="wallet"
      title="打不开这笔账单"
      desc="它可能已被删除"
    />

    <template v-else>
    <!-- 金额显示 -->
    <div class="amount-block">
      <div class="amount-row">
        <span class="cur">¥</span>
        <span
          class="amount num"
          :class="{
            placeholder: !amountText,
            shrink: amountText.length >= 9,
            'shrink-more': amountText.length >= 13
          }"
        >
          {{ amountText || '0' }}
        </span>
        <span v-if="exprEq !== null" class="expr-eq num">= {{ money(exprEq, currency) }}</span>
      </div>
      <div class="quick">
        <button v-for="q in quickAmounts" :key="q" class="q-btn" @click="amountText = String(q)">
          {{ q }}
        </button>
      </div>
    </div>

    <div class="page-body">
      <!-- 名称 -->
      <div class="card tight">
        <div class="row-input">
          <AppIcon name="edit" :size="18" color="var(--text-tertiary)" />
          <input v-model="title" placeholder="这笔是什么？例如 火锅、打车" maxlength="24" />
        </div>
      </div>

      <!-- 分类 -->
      <div class="sec-title">
        <h2>分类</h2>
      </div>
      <div class="cat-grid">
        <!-- 分类色**只挂在图标上**，不挂在按钮上：
             挂在按钮上会连 12px 的标签一起染色，而分类色压自己的浅底最低只有
             3.09:1（`--cat-food` on `--cat-food-bg`），不够正文的 4.5:1。
             想给分类再配一套 -deep 也不行 —— 压暗后的「餐饮」和 `--accent-deep`
             的 ΔE 只有 3.9，等于让分类色抢了「应付」的橙，正是这套色板当初要防的事。
             所以标签走通用的 `--text-*`，色相由「浅底 + 图标」两处承担。 -->
        <button
          v-for="c in CATEGORY_ORDER"
          :key="c"
          class="cat"
          :class="{ active: category === c }"
          :style="category === c ? { background: CATEGORY_META[c].bg } : {}"
          @click="category = c"
        >
          <span
            class="cat-ic"
            :style="category === c ? { color: CATEGORY_META[c].color } : {}"
          >
            <AppIcon :name="CATEGORY_META[c].icon" :size="19" />
          </span>
          <span class="cat-label">{{ CATEGORY_META[c].label }}</span>
        </button>
      </div>

      <!-- 谁付的 -->
      <div class="sec-title">
        <h2>谁付的</h2>
      </div>
      <div class="card">
        <div class="payer-row">
          <button
            v-for="m in members"
            :key="m.id"
            class="payer"
            :class="{ active: payerId === m.id }"
            @click="payerId = m.id"
          >
            <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="38" />
            <span class="ellipsis">{{ m.name }}</span>
          </button>
        </div>
      </div>

      <!-- 为谁付 -->
      <div class="sec-title">
        <h2>为谁付</h2>
        <button class="btn-text" @click="toggleAll">
          {{ allSelected() ? '只选自己' : '全选' }}
        </button>
      </div>
      <div class="card">
        <div class="split-tabs">
          <button
            v-for="m in [
              { key: 'even', label: '均分' },
              { key: 'weight', label: '按权重' },
              { key: 'custom', label: '不等额' }
            ]"
            :key="m.key"
            class="split-tab"
            :class="{ active: splitMode === m.key }"
            @click="splitMode = m.key as SplitMode"
          >
            {{ m.label }}
          </button>
        </div>

        <ul class="part-list">
          <li v-for="m in members" :key="m.id" class="part">
            <button class="part-check" @click="toggleParticipant(m.id)">
              <span class="cb" :class="{ on: participantIds.includes(m.id) }">
                <AppIcon
                  v-if="participantIds.includes(m.id)"
                  name="check"
                  :size="11"
                  color="#fff"
                  :stroke="2.8"
                />
              </span>
            </button>
            <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="28" />
            <span class="part-name ellipsis grow">{{ m.name }}</span>

            <template v-if="participantIds.includes(m.id)">
              <span v-if="splitMode === 'even'" class="part-amt num">
                {{ money(evenPreview, currency) }}
              </span>

              <span v-else-if="splitMode === 'weight'" class="stepper">
                <button class="st-btn" @click="stepWeight(m.id, -1)">
                  <AppIcon name="minus" :size="14" />
                </button>
                <span class="st-val num">{{ weights[m.id] || 1 }}×</span>
                <button class="st-btn" @click="stepWeight(m.id, 1)">
                  <AppIcon name="plus" :size="14" />
                </button>
              </span>

              <span v-else class="custom-wrap">
                <span class="cur-mini">¥</span>
                <input
                  class="custom-input num"
                  inputmode="decimal"
                  :value="customAmounts[m.id] || ''"
                  placeholder="0"
                  @input="setCustom(m.id, ($event.target as HTMLInputElement).value)"
                />
                <button
                  v-if="customRemain !== 0"
                  class="fill-btn"
                  @click="fillRemain(m.id)"
                >
                  补
                </button>
              </span>
            </template>
            <span v-else class="part-off">不分摊</span>
          </li>
        </ul>

        <div v-if="splitMode === 'custom'" class="remain" :class="{ warn: customRemain !== 0 }">
          <span>未分配</span>
          <span class="num">{{ money(customRemain, currency) }}</span>
        </div>
        <div v-else-if="splitMode === 'weight'" class="remain">
          <span>按权重换算</span>
          <span class="num">
            {{
              participantIds
                .map((id) => money(weightPreview[id] || 0, ''))
                .join(' / ')
            }}
          </span>
        </div>
      </div>

      <!-- 日期与备注 -->
      <div class="sec-title">
        <h2>日期与备注</h2>
      </div>
      <div class="card">
        <div class="mini-row">
          <span class="mini-label">日期</span>
          <picker mode="date" :value="date" @change="onDateChange" class="mini-picker">
            <view class="mini-input">{{ date }}</view>
          </picker>
        </div>
        <div class="divider" />
        <div class="mini-row">
          <span class="mini-label">备注</span>
          <input v-model="note" class="mini-input" placeholder="可选" maxlength="40" />
        </div>
      </div>

      <!-- 份额预览 -->
      <div class="preview">
        <p class="pv-title">这笔怎么分</p>
        <div class="pv-list">
          <div v-for="m in members" :key="m.id" class="pv-row">
            <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="22" />
            <span class="grow ellipsis">{{ m.name }}</span>
            <span class="num pv-amt">
              {{ participantIds.includes(m.id) ? money(sharePreview[m.id] || 0, currency) : '—' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 键盘：左 4 列数字+运算符，右侧保存键贯穿 -->
    <div class="keypad">
      <div class="keys">
        <button
          v-for="k in keys"
          :key="k"
          class="key"
          :class="{ del: k === 'del', op: OPS.includes(k) }"
          @click="press(k)"
        >
          <AppIcon v-if="k === 'del'" name="left" :size="20" />
          <template v-else>{{ k }}</template>
        </button>
      </div>
      <button class="key save" :disabled="!canSave" @click="save">
        {{ isEdit ? '保存' : '记下' }}
      </button>
    </div>
    </template>
  </div>
</template>

<style scoped>
.edit-page {
  /* 键盘 4 行 × 56px + 安全区，留足滚动空间 */
  padding-bottom: calc(224px + var(--safe-bottom) + 24px);
}

.amount-block {
  padding: 12px 16px 16px;
}

/* 金额区：iOS 用「白块浮在灰页面上」表达输入区域，而不是 Web 表单那条下划线。
   历史上这里是 `border-bottom: 2px solid var(--brand)` —— 一条绿色下划线。

   ⚠️ 为什么不用灰填充块（iOS 表单的另一种常用做法）：
   页面底色本身就是 #F2F2F7，而 `--bg-subtle` 是 #E9E9EB，两者差不到 10 个色阶，
   灰块会直接糊进背景（CityMapPage 的空态踩过同一个坑）。
   灰填充块只在**白色卡片内部**才成立，这里没有卡片，所以走白块路线。 */
.amount-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
}

/* 货币符号用副色：iOS 里符号不抢金额的注意力，也不占品牌色 */
.cur {
  font-size: 22px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* 和全局「大数字」口径一致：700 字重 + 负字距
   （`.sum-value` 是 34/700/-0.6px，这里是页面主角所以更大一号）。 */
.amount {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -1px;
  color: var(--text-primary);
}

.amount.placeholder {
  color: var(--text-tertiary);
  font-weight: 600;
}

/* 算式比纯数字长：分两档缩字号，避免把行撑出屏（触发阈值就跳一档，不算抖动） */
.amount.shrink {
  font-size: 30px;
}

.amount.shrink-more {
  font-size: 24px;
}

/* 表达式的实时结果：小一号、推到行尾，基线对齐主金额 */
.expr-eq {
  margin-left: auto;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-secondary);
}

.quick {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.q-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: 15px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 13px;
}

.q-btn:active {
  background: var(--bg-sunken);
}

.card.tight {
  padding: 6px 14px;
  margin-top: 4px;
}

.row-input {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 46px;
}

.row-input input {
  font-size: 15px;
}

.cat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.cat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 68px;
  border-radius: var(--radius-md);
  /* 同上：白块浮在灰页面上，不加影子 */
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  transition: background 0.15s ease, color 0.15s ease;
}

/* 选中态靠三处叠加表明：浅底 + 图标上色 + 标签变深；标签始终是 --text-*。
   （把分类色挂到按钮上会连标签一起染色，12px 就掉到 3.09:1 —— 见模板里的注释。） */
.cat.active {
  font-weight: 500;
  color: var(--text-primary);
}

.cat-ic {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 19px;
}

.cat-label {
  font-size: 12px;
}

.payer-row {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0;
}

.payer-row::-webkit-scrollbar {
  display: none;
}

.payer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 56px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.payer.active {
  color: var(--brand-deep);
  font-weight: 500;
}

.payer :deep(.avatar) {
  transition: box-shadow 0.15s ease;
}

.payer.active :deep(.avatar) {
  box-shadow: 0 0 0 3px var(--brand-soft);
}

.split-tabs {
  display: flex;
  gap: 6px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  margin-bottom: 12px;
}

.split-tab {
  flex: 1;
  height: 34px;
  border-radius: 9px;
  font-size: 13px;
  color: var(--text-secondary);
  transition: background 0.15s ease, color 0.15s ease;
}

.split-tab.active {
  background: var(--bg-card);
  color: var(--brand-deep);
  font-weight: 500;
}

.part-list {
  display: flex;
  flex-direction: column;
}

.part {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
}

.part-check {
  flex-shrink: 0;
}

.cb {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.cb.on {
  background: var(--brand);
  border-color: var(--brand);
}

.part-name {
  font-size: 14px;
}

.part-amt {
  font-size: 14px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.part-off {
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.st-btn {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.st-val {
  min-width: 34px;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
}

.custom-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  height: 32px;
  padding: 0 8px;
  border-radius: 9px;
  background: var(--bg-subtle);
}

.cur-mini {
  font-size: 12px;
  color: var(--text-tertiary);
}

.custom-input {
  width: 52px;
  font-size: 13px;
  font-weight: 500;
  text-align: right;
}

.fill-btn {
  font-size: 11px;
  /* 11px 文字：brand 基色 2.85:1 → brand-deep 4.81:1 */
  color: var(--brand-deep);
  padding: 0 2px 0 4px;
  font-weight: 500;
}

.remain {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-tertiary);
  gap: 12px;
}

.remain.warn {
  /* 12px 超支提示文字：warn 基色 3.27:1 → warn-deep 5.77:1 */
  color: var(--warn-deep);
}

.remain .num {
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
}

.mini-label {
  font-size: 14px;
  color: var(--text-secondary);
  width: 40px;
  flex-shrink: 0;
}

.mini-input {
  flex: 1;
  font-size: 14px;
  text-align: right;
}

.mini-picker {
  flex: 1;
  min-width: 0;
}

.preview {
  margin-top: 22px;
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--brand-softer);
}

.pv-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--brand-deep);
  margin-bottom: 10px;
}

.pv-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pv-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.pv-amt {
  font-weight: 500;
  color: var(--brand-deep);
}

.keypad {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 100%;
  max-width: 480px;
  display: flex;
  background: var(--line);
  padding-bottom: var(--safe-bottom);
  z-index: 40;
  border-top: 1px solid var(--line);
  gap: 1px;
}

/* 左：4 列 × 4 行（数字 + 运算符，见 keys 注释） */
.keys {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 56px;
  gap: 1px;
  background: var(--line);
}

.key {
  background: var(--bg-card);
  font-size: 21px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s ease;
}

.key:active {
  background: var(--bg-subtle);
}

.key.del {
  color: var(--text-secondary);
}

/* 运算符用副色：让数字仍是视觉主体，与退格一致 */
.key.op {
  color: var(--text-secondary);
}

/* 右：保存键贯穿全高 */
.key.save {
  width: 92px;
  flex-shrink: 0;
  background: var(--brand);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  letter-spacing: 2px;
}

.key.save:active {
  background: var(--brand-deep);
}

/* 禁用态原来写的是**白字压 --line-strong**：1.52:1 —— 那是分隔线的颜色，
   当底用等于让「记下」两个字消失。后来改成灰底 + --text-secondary（3.74:1）。
   现在统一到 `--bg-sunken` + `--text-secondary`（4.45:1），和 `.btn-primary[disabled]`
   以及 global.css 里那条**全局禁用兜底**取同一组令牌 —— 全 App 的禁用态只有一种样子。

   注意这里的特异性：本文件的样式是 scoped 的，编译后会变成
   `.key.save[disabled][data-v-xxx]` = **0,3,0**，**高于** global.css 那条兜底的 0,2,1
   —— 所以这行不会被兜底覆盖，它是真的生效值（实测 rgb(227,227,232) / rgb(102,102,110)）。
   换句话说：兜底只替「没写 [disabled] 的按钮」收尾，写了的以本文件为准。 */
.key.save[disabled] {
  background: var(--bg-sunken);
  color: var(--text-secondary);
}
</style>
