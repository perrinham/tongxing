<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { availableCities } from '@/utils/itinerary'
import { isKnownCity } from '@/data/poi'
import { inputTips, resolveCityName, type AmapPoi } from '@/services/amap'
import { addDays, daysBetween, todayISO } from '@/utils/format'
import { budgetBrief, estimateBudget } from '@/utils/budget'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'

const store = useTripStore()

const cities = availableCities()

const destination = ref('成都')
const startDate = ref(addDays(todayISO(), 14))
const endDate = ref(addDays(todayISO(), 17))
const budget = ref(0)
const budgetText = ref('')

const memberNames = ref<string[]>(['我', ''])
const newName = ref('')

// 高德目的地联想：输入非本地库城市时出候选
const tips = ref<AmapPoi[]>([])
const showTips = ref(false)
let tipTimer: ReturnType<typeof setTimeout> | null = null

const dayCount = computed(() => daysBetween(startDate.value, endDate.value))
const canSubmit = computed(() => destination.value.trim().length > 0 && dayCount.value > 0)
const isKnownDest = computed(() => isKnownCity(destination.value))

/** 预算智能参考：目的地 + 实际天数 + 实际人数，随表单实时变（可一键填进预算框） */
const budgetEst = computed(() =>
  destination.value.trim() && dayCount.value > 0
    ? estimateBudget({
        destination: destination.value,
        days: dayCount.value,
        peopleCount: memberNames.value.filter((n) => n.trim()).length || 1
      })
    : null
)
const budgetEstHint = computed(() => (budgetEst.value ? budgetBrief(budgetEst.value) : ''))

function useEstimate() {
  if (!budgetEst.value) return
  budget.value = budgetEst.value.perPerson
  budgetText.value = String(budgetEst.value.perPerson)
}

function onDestInput(e: Event) {
  const value = (e.target as HTMLInputElement).value
  destination.value = value
  if (tipTimer) clearTimeout(tipTimer)
  const q = value.trim()
  if (!q || isKnownCity(q)) {
    tips.value = []
    showTips.value = false
    return
  }
  tipTimer = setTimeout(async () => {
    const list = await inputTips(q)
    tips.value = list.slice(0, 5)
    showTips.value = tips.value.length > 0
  }, 350)
}

function pickTip(t: AmapPoi) {
  showTips.value = false
  tips.value = []
  // 候选名可能是 POI（「大理站」）而 t.city 是完整区划串，都不能直接当地点；
  // 用 adcode 反查标准城市名（「大理市」），反查失败回退候选名
  void (async () => {
    const standard = t.adcode ? await resolveCityName(t.adcode) : null
    destination.value = standard || t.name
  })()
}

function shiftEnd() {
  // 起止日期倒挂时自动纠正
  if (daysBetween(startDate.value, endDate.value) < 1) {
    endDate.value = addDays(startDate.value, 1)
  }
}

function addMember() {
  const n = newName.value.trim()
  if (!n) return
  memberNames.value.push(n)
  newName.value = ''
}

function removeMember(i: number) {
  if (memberNames.value.length <= 1) return
  memberNames.value.splice(i, 1)
}

function pickCity(name: string) {
  destination.value = name
}

function onBudget(e: Event) {
  const raw = (e.target as HTMLInputElement).value.replace(/[^\d]/g, '')
  budgetText.value = raw
  budget.value = raw ? Number(raw) : 0
}

function onStartChange(e: { detail: { value: string } }) {
  startDate.value = e.detail.value
  shiftEnd()
}

function onEndChange(e: { detail: { value: string } }) {
  endDate.value = e.detail.value
}

function submit() {
  if (!canSubmit.value) return
  const raw = memberNames.value.map((n) => n.trim())
  // 首位槽位固定是「我」：清空也不能让后面的人顶上来变成 isSelf（默认付款人）
  if (!raw[0]) raw[0] = '我'
  const names = raw.filter(Boolean)
  const trip = store.createTrip({
    title: `${destination.value}${dayCount.value}日`,
    destination: destination.value.trim(),
    startDate: startDate.value,
    endDate: endDate.value,
    budget: budget.value,
    memberNames: names.length ? names : ['我']
  })
  nav.replace('trip-generate', { tripId: trip.id })
}
</script>

<template>
  <div class="page">
    <AppNav title="新建行程" back />

    <div class="page-body">
      <div class="card block">
        <div class="field">
          <div class="field-label">去哪儿</div>
          <div class="field-input">
            <input
              :value="destination"
              placeholder="国内任意城市，例如 长沙 / 青岛 / 洛阳"
              @input="onDestInput"
            />
          </div>
          <!-- 高德联想候选 -->
          <view v-if="showTips" class="tips">
            <button v-for="t in tips" :key="t.id" class="tip-item" @click="pickTip(t)">
              <AppIcon name="pin" :size="14" color="var(--text-tertiary)" />
              <span class="tip-name">{{ t.name }}</span>
              <span class="tip-district ellipsis">{{ t.city || t.address }}</span>
            </button>
          </view>
          <div class="chips-label">热门城市</div>
          <div class="chips">
            <button
              v-for="c in cities"
              :key="c.name"
              class="chip"
              :class="{ active: destination === c.name }"
              @click="pickCity(c.name)"
            >
              {{ c.name }}
            </button>
          </div>
          <p class="tip">{{ isKnownDest
            ? `内置 ${cities.length} 个城市的精修点位库；其它城市直接输入名称，同样能生成`
            : '走高德在线检索该城市的景点与美食，联网即可生成' }}</p>
        </div>

        <div class="divider" />

        <div class="date-row">
          <div class="field grow">
            <div class="field-label">出发</div>
            <div class="field-input">
              <picker mode="date" :value="startDate" @change="onStartChange">
                <view class="picker-text">{{ startDate }}</view>
              </picker>
            </div>
          </div>
          <div class="date-arrow">
            <AppIcon name="right" :size="18" color="var(--text-tertiary)" />
          </div>
          <div class="field grow">
            <div class="field-label">返程</div>
            <div class="field-input">
              <picker mode="date" :value="endDate" :start="startDate" @change="onEndChange">
                <view class="picker-text">{{ endDate }}</view>
              </picker>
            </div>
          </div>
        </div>

        <p class="tip days-tip">共 {{ dayCount }} 天</p>

        <div class="divider" />

        <div class="field">
          <div class="field-label">人均预算（可选）</div>
          <div class="field-input prefix-input">
            <span class="prefix">¥</span>
            <input
              :value="budgetText"
              inputmode="numeric"
              placeholder="留空则不设"
              @input="onBudget"
            />
          </div>
          <div v-if="budgetEstHint" class="est-row">
            <p class="tip est-hint">参考：{{ budgetEstHint }}</p>
            <button class="btn-text est-use" @click="useEstimate">填入</button>
          </div>
        </div>
      </div>

      <div class="card block">
        <div class="field-label">同行的人</div>
        <ul class="members">
          <li v-for="(m, i) in memberNames" :key="i">
            <AppAvatar :name="m || '?'" :color-index="i" :size="30" />
            <input
              v-model="memberNames[i]"
              class="member-input"
              :placeholder="i === 0 ? '我' : `成员 ${i + 1}`"
              maxlength="10"
            />
            <button v-if="memberNames.length > 1" class="rm" @click="removeMember(i)">
              <AppIcon name="close" :size="16" color="var(--text-tertiary)" />
            </button>
          </li>
        </ul>
        <div class="add-row">
          <input
            v-model="newName"
            class="member-input"
            placeholder="添加同行人"
            maxlength="10"
            @confirm="addMember"
          />
          <button class="btn-text" @click="addMember">添加</button>
        </div>
        <p class="tip">第一个人默认为「我」，记账时会作为默认付款人</p>
      </div>
    </div>

    <div class="foot-bar">
      <button class="btn-primary" :disabled="!canSubmit" @click="submit">
        <AppIcon name="sparkle" :size="18" />
        生成行程草稿
      </button>
    </div>
  </div>
</template>

<style scoped>
.block {
  margin-top: 8px;
}

.chips-label {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
}

/* 白块靠底色差浮在灰页面上，不加描边不投影（同 `.list` 的做法）。
   原来这里是 `border: 1px solid var(--hairline)` + `box-shadow: var(--shadow-card)`，
   是「每块内容都画一圈线」的旧视觉残留。 */
.tips {
  margin-top: 6px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  overflow: hidden;
}

.tip-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 12px;
  text-align: left;
  border-bottom: 1px solid var(--hairline);
  font-size: 14px;
}

.tip-item:last-child {
  border-bottom: none;
}

.tip-item:active {
  background: var(--bg-subtle);
}

.tip-name {
  color: var(--text-primary);
  flex-shrink: 0;
}

.tip-district {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-tertiary);
  max-width: 55%;
}

.days-tip {
  margin-top: 10px;
  color: var(--brand-deep);
  font-weight: 500;
}

.date-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 4px 0;
}

.date-arrow {
  padding-bottom: 14px;
}

.prefix-input {
  gap: 6px;
}

/* 预算智能参考行：左文案 + 右「填入」钮（btn-text 基类已居中，不重设居中） */
.est-row {
  display: flex;
  align-items: center;
  margin-top: 6px;
}

.est-hint {
  flex: 1;
  min-width: 0;
}

.est-use {
  /* 按钮居中口径：显式 flex，不赌 btn-text 基类 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: 8px;
  padding: 4px 10px;
  border-radius: 12px;
  background: var(--brand-soft);
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-deep);
}

.prefix {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.members {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.members li {
  display: flex;
  align-items: center;
  gap: 10px;
}

.member-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-size: 15px;
}

.rm {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.foot-bar {
  position: sticky;
  bottom: 0;
  padding: 12px 16px calc(16px + var(--safe-bottom));
  /* 渐变的「透明端」也必须写 --bg-page 自己的 RGB（原来是旧米色 rgba(248,247,244,0)）。 */
  background: linear-gradient(to top, var(--bg-page) 72%, rgba(242, 242, 247, 0));
}

input[type='date'] {
  min-width: 0;
}

.picker-text {
  font-size: 15px;
  color: var(--text-primary);
}
</style>
