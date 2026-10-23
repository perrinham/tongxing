<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { ITEM_TYPE_META, ITEM_TYPE_ORDER, endTime, moneyBrief } from '@/utils/format'
import type { ItemType } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'

const store = useTripStore()

const itemId = ref('')
const title = ref('')
import { evalAmountExpr } from '@/utils/amountExpr'

const time = ref('10:00')
const type = ref<ItemType>('spot')
const address = ref('')
const costText = ref('')
const durationText = ref('')
const note = ref('')
const done = ref(false)

const item = computed(() => store.items.find((i) => i.id === itemId.value))
const trip = computed(() => store.activeTrip)

/** 每人花费支持直接输算式（68+35×2）：解析失败/未写完 → 0，clamp 与旧逻辑一致 */
const cost = computed(() => {
  const v = evalAmountExpr(costText.value)
  if (v === null) return 0
  // 负数 / 超长粘贴会污染预估价与花费汇总：夹到 [0, 1e7]
  return Math.min(Math.max(v, 0), 10_000_000)
})

const costIsExpr = computed(() => /[+×÷*/x-]/.test(costText.value))
const duration = computed(() => Number(durationText.value) || 90)

const end = computed(() => endTime(time.value, duration.value))

const dayLabel = computed(() => {
  if (!item.value || !trip.value) return ''
  const day = store.days.find((d) => d.id === item.value!.dayId)
  if (!day) return ''
  return `${day.title} · ${day.date}`
})

const peopleCount = computed(() => (trip.value ? store.membersOf(trip.value.id).length : 1))
const totalCost = computed(() => cost.value * (peopleCount.value || 1))

onLoad((options: Record<string, any> | undefined) => {
  const id = options?.id || ''
  if (!id) {
    nav.replace('itinerary')
    return
  }
  itemId.value = id
  const it = store.items.find((x) => x.id === id)
  if (!it) {
    nav.replace('itinerary')
    return
  }
  title.value = it.title
  time.value = it.time
  type.value = it.type
  address.value = it.address
  costText.value = it.cost ? String(it.cost) : ''
  durationText.value = it.duration ? String(it.duration) : '90'
  note.value = it.note
  done.value = it.done
})

function save() {
  if (!itemId.value) return
  store.updateItem(itemId.value, {
    title: title.value.trim() || '未命名安排',
    time: time.value,
    type: type.value,
    address: address.value.trim(),
    cost: cost.value,
    duration: duration.value,
    note: note.value,
    done: done.value
  })
  nav.back()
}

function remove() {
  if (!itemId.value) return
  store.removeItem(itemId.value)
  nav.back()
}

function navigate() {
  const it = item.value
  if (!it || !it.lat || !it.lng) return
  uni.openLocation({
    latitude: it.lat,
    longitude: it.lng,
    name: it.title,
    address: it.address || '',
    fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
  })
}

function onTimeChange(e: { detail: { value: string } }) {
  time.value = e.detail.value
}

const durationOptions = [30, 45, 60, 90, 120, 180, 240, 300]
</script>

<template>
  <div class="page">
    <AppNav title="编辑安排" back>
      <template #right>
        <button class="nav-icon" @click="remove">
          <AppIcon name="trash" :size="19" color="var(--danger)" />
        </button>
      </template>
    </AppNav>

    <div class="page-body">
      <p v-if="dayLabel" class="day-hint">{{ dayLabel }}</p>

      <div class="card">
        <div class="mini-row">
          <span class="mini-label">名称</span>
          <input v-model="title" class="mini-input" placeholder="去哪、做什么" maxlength="30" />
        </div>
        <div class="divider" />
        <div class="mini-row">
          <span class="mini-label">时间</span>
          <picker mode="time" :value="time" @change="onTimeChange" class="mini-picker">
            <view class="mini-input">{{ time }}</view>
          </picker>
        </div>
        <div class="divider" />
        <div class="mini-row">
          <span class="mini-label">地址</span>
          <input v-model="address" class="mini-input" placeholder="可选" maxlength="40" />
        </div>
      </div>

      <div class="sec-title">
        <h2>类型</h2>
      </div>
      <div class="type-grid">
        <button
          v-for="t in ITEM_TYPE_ORDER"
          :key="t"
          class="type"
          :class="{ active: type === t }"
          :style="type === t ? { background: ITEM_TYPE_META[t].bg, color: ITEM_TYPE_META[t].color } : {}"
          @click="type = t"
        >
          {{ ITEM_TYPE_META[t].label }}
        </button>
      </div>

      <div class="sec-title">
        <h2>停留时长</h2>
        <span class="sec-hint">
          {{ time }} → {{ end }}
        </span>
      </div>
      <div class="card">
        <div class="dur-grid">
          <button
            v-for="d in durationOptions"
            :key="d"
            class="dur"
            :class="{ active: duration === d }"
            @click="durationText = String(d)"
          >
            {{ d >= 60 ? `${d / 60}h` : `${d}m` }}
          </button>
        </div>
      </div>

      <div class="sec-title">
        <h2>花费</h2>
      </div>
      <div class="card">
        <div class="mini-row">
          <span class="mini-label">每人</span>
          <span class="cost-wrap">
            <span class="cur-mini">¥</span>
            <input
              v-model="costText"
              class="mini-input num cost-input"
              inputmode="decimal"
              placeholder="0"
            />
          </span>
        </div>
        <p v-if="cost > 0 && costIsExpr" class="cost-hint">
          算式 = {{ moneyBrief(cost) }} · {{ peopleCount }} 人共 {{ moneyBrief(totalCost) }}，会算进行程预估价
        </p>
        <p v-else-if="cost > 0" class="cost-hint">
          {{ peopleCount }} 人共 {{ moneyBrief(totalCost) }}，会算进行程预估价
        </p>
      </div>

      <div class="sec-title">
        <h2>备注</h2>
      </div>
      <div class="card">
        <textarea
          v-model="note"
          class="note-area"
          rows="3"
          placeholder="预约方式、注意事项…"
          maxlength="120"
        />
      </div>

      <button class="done-toggle" :class="{ on: done }" @click="done = !done">
        <span class="dt-check" :class="{ on: done }">
          <AppIcon v-if="done" name="check" :size="12" color="#fff" :stroke="2.8" />
        </span>
        已打卡
      </button>

      <button v-if="item && item.lat && item.lng" class="nav-full" @click="navigate">
        <AppIcon name="location" :size="17" color="var(--brand)" />
        在高德地图中打开
      </button>
    </div>

    <div class="foot-bar">
      <button class="btn-primary" @click="save">保存</button>
    </div>
  </div>
</template>

<style scoped>
.day-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 8px 4px 0;
}

.mini-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
}

.mini-label {
  font-size: 14px;
  color: var(--text-secondary);
  width: 42px;
  flex-shrink: 0;
}

.mini-input {
  flex: 1;
  font-size: 14px;
  text-align: right;
  min-width: 0;
}

.mini-picker {
  flex: 1;
  min-width: 0;
}

.cost-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  justify-content: flex-end;
}

.cur-mini {
  font-size: 13px;
  color: var(--text-tertiary);
}

.cost-input {
  flex: none;
  width: 96px;
}

.cost-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 8px 0 4px;
  border-top: 1px solid var(--line);
}

.type-grid {
  display: flex;
  gap: 8px;
}

.type {
  flex: 1;
  height: 42px;
  border-radius: var(--radius-md);
  /* 白块浮在灰页面上就够了，不加影子（`--shadow-card` 早先已被中性化成近乎透明，
     这里把死引用一起删掉） */
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 14px;
  transition: background 0.15s ease, color 0.15s ease;
}

.type.active {
  font-weight: 500;
}

.dur-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.dur {
  height: 38px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 13px;
}

.dur.active {
  background: var(--brand);
  color: #fff;
  font-weight: 500;
}

.note-area {
  width: 100%;
  font-size: 14px;
  line-height: 1.6;
  resize: none;
  min-height: 62px;
}

.done-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 50px;
  margin-top: 20px;
  padding: 0 4px;
  font-size: 15px;
  color: var(--text-secondary);
}

.dt-check {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.dt-check.on {
  background: var(--brand);
  border-color: var(--brand);
}

.nav-full {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 46px;
  border-radius: var(--radius-md);
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-size: 14px;
  font-weight: 500;
  margin-top: 8px;
}

.foot-bar {
  position: sticky;
  bottom: 0;
  padding: 12px 16px calc(16px + var(--safe-bottom));
  /* 渐变的「透明端」也必须写 --bg-page 自己的 RGB：写别的色，那一段就会透出旧色调
     （这里原来是 rgba(248,247,244,0) —— 旧米色底的残留，十六进制搜不出来）。 */
  background: linear-gradient(to top, var(--bg-page) 72%, rgba(242, 242, 247, 0));
}
</style>
