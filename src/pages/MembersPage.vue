<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { money } from '@/utils/format'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'
import AppEmpty from '@/components/AppEmpty.vue'

const store = useTripStore()

const trip = computed(() => store.activeTrip)
const members = computed(() => (trip.value ? store.membersOf(trip.value.id) : []))

const newName = ref('')
const editingId = ref('')
const editingName = ref('')

/** 全量结算只算一次：顶部人均和每个成员的收支都从这里取（原来模板每成员调 2 次
 *  statsOf、每次全量结算，输入框每敲一个字就是 2N 次全量重算） */
const settled = computed(() => (trip.value ? store.settlementOf(trip.value.id) : null))
const statsMap = computed(() => {
  const map = new Map<string, { paid: number; shouldPay: number }>()
  for (const b of settled.value?.balances || []) {
    map.set(b.memberId, { paid: b.paid, shouldPay: b.shouldPay })
  }
  return map
})

// 人均走结算的口径（按「参与过账单的人数」均摊），不再 ÷ 全部成员数
const perCapita = computed(() => settled.value?.perCapita || 0)

function add() {
  const n = newName.value.trim()
  if (!n || !trip.value) return
  store.addMember(trip.value.id, n)
  newName.value = ''
}

function startEdit(id: string, name: string) {
  editingId.value = id
  editingName.value = name
}

function commitEdit() {
  if (!editingId.value) return
  const n = editingName.value.trim()
  if (n) store.updateMember(editingId.value, { name: n })
  editingId.value = ''
  editingName.value = ''
}

function setSelf(id: string) {
  if (!trip.value) return
  store.setSelfMember(trip.value.id, id)
}

function remove(id: string) {
  const m = store.members.find((x) => x.id === id)
  if (!m) return
  store.removeMember(id)
}

function stepWeight(id: string, dir: 1 | -1) {
  const m = store.members.find((x) => x.id === id)
  if (!m) return
  const next = Math.min(10, Math.max(0.5, Math.round((m.weight + dir * 0.5) * 2) / 2))
  store.updateMember(id, { weight: next })
}

/** 该成员的收支情况（读 statsMap，不再触发结算） */
function statsOf(id: string) {
  return statsMap.value.get(id) || { paid: 0, shouldPay: 0 }
}

function goCreate() {
  nav.to('trip-create')
}

const added = ref(false)
function addAndStick() {
  if (!newName.value.trim()) return
  add()
  added.value = true
  setTimeout(() => (added.value = false), 1200)
}
</script>

<template>
  <div class="page">
    <AppNav title="同行的人" back :subtitle="trip ? trip.title : ''" />

    <template v-if="!trip">
      <AppEmpty
        icon="users"
        title="还没有行程"
        desc="成员是挂在行程上的，先创建行程"
        action="创建我的行程"
        @action="goCreate"
      />
    </template>

    <template v-else>
      <div class="page-body">
        <!-- 人均一行 + 一句脚注。原来是一整块浅绿卡片，但绿色在这里没有任何
             语义（既不是状态也不是可点操作），只是「看起来活泼」——
             iOS 的说明性内容一律是白卡 + 卡片外的灰脚注。 -->
        <div class="list intro">
          <div class="list-row">
            <span class="grow">人均</span>
            <span class="num intro-num">{{ money(perCapita, trip.currency) }}</span>
          </div>
        </div>
        <p class="list-foot">
          {{ members.length }} 人同行。标记「我」之后，记一笔时会默认选中这个人付款。
        </p>

        <div class="sec-title"><h2>同行的人</h2></div>
        <div class="list">
          <template v-for="(m, i) in members" :key="m.id">
            <div v-if="i" class="list-sep" />
            <div class="member">
              <div class="mem-main">
                <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="40" />

                <div class="grow mem-mid">
                  <template v-if="editingId === m.id">
                    <input
                      v-model="editingName"
                      class="edit-input"
                      maxlength="10"
                      @confirm="commitEdit"
                      @blur="commitEdit"
                    />
                  </template>
                  <template v-else>
                    <div class="mem-name-row" @click="startEdit(m.id, m.name)">
                      <span class="mem-name ellipsis">{{ m.name }}</span>
                      <span v-if="m.isSelf" class="tint self-tag">我</span>
                    </div>
                    <p class="mem-stats">
                      付了 {{ money(statsOf(m.id).paid, trip.currency) }} · 该担
                      {{ money(statsOf(m.id).shouldPay, trip.currency) }}
                    </p>
                  </template>
                </div>

                <div class="mem-weight">
                  <button class="st-btn" @click="stepWeight(m.id, -1)">
                    <AppIcon name="minus" :size="13" />
                  </button>
                  <span class="st-val num">{{ m.weight }}×</span>
                  <button class="st-btn" @click="stepWeight(m.id, 1)">
                    <AppIcon name="plus" :size="13" />
                  </button>
                </div>
              </div>

              <div class="mem-actions">
                <button class="ma" :class="{ on: m.isSelf }" @click="setSelf(m.id)">
                  <AppIcon name="user" :size="15" />
                  {{ m.isSelf ? '这是我' : '标记为我' }}
                </button>
                <button
                  class="ma danger"
                  :disabled="members.length <= 1"
                  @click="remove(m.id)"
                >
                  <AppIcon name="trash" :size="15" />
                  移除
                </button>
              </div>
            </div>
          </template>
        </div>

        <div class="list add-card">
          <div class="list-row add-row">
            <input
              v-model="newName"
              class="add-input"
              placeholder="输入名字，回车添加"
              maxlength="10"
              @confirm="addAndStick"
            />
            <button class="btn-tint" :disabled="!newName.trim()" @click="addAndStick">
              {{ added ? '已添加' : '添加' }}
            </button>
          </div>
        </div>

        <div class="sec-title"><h2>权重怎么用</h2></div>
        <div class="list tip-card">
          <p class="tip-text">
            默认 1×，表示均摊。有小孩、有人只住半程这类情况，把权重调成 0.5×，
            记账选「按权重」时就会少担一些。
          </p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.intro {
  margin-top: 4px;
}

.intro-num {
  font-size: 17px;
  font-weight: 600;
}

.member {
  display: flex;
  flex-direction: column;
}

.mem-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.mem-mid {
  min-width: 0;
}

.mem-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}

.mem-name {
  font-size: 15px;
  font-weight: 500;
}

.self-tag {
  height: 18px;
  background: var(--brand-soft);
  color: var(--brand-deep);
}

.edit-input {
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--bg-subtle);
  font-size: 15px;
  font-weight: 500;
}

.mem-stats {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* 权重步进器：iOS 的 UIStepper 观感 —— 两个方形按钮夹一个数值 */
.mem-weight {
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

.st-btn:active {
  background: var(--bg-sunken);
}

.st-val {
  min-width: 34px;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
}

/* 行内动作条：iOS 把一行里的次级操作放在同一张卡的下沿，
   用发丝线隔开，而不是把按钮散在卡片外面。 */
.mem-actions {
  display: flex;
  border-top: 0.5px solid var(--hairline);
  margin-left: 16px;
}

.ma {
  flex: 1;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  color: var(--text-secondary);
}

.ma.on {
  color: var(--brand-deep);
  font-weight: 500;
}

.ma.danger {
  color: var(--danger);
}

.ma[disabled] {
  opacity: 0.35;
}

.ma:active {
  background: var(--bg-subtle);
}

.add-card {
  margin-top: 16px;
}

.add-row {
  gap: 10px;
}

/* 输入行：输入框本身不再有白底和投影 —— 它已经在白卡里了，
   再叠一层白底等于看不见边界。 */
.add-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  font-size: 15px;
}

.tip-card {
  padding: 14px 16px;
}

.tip-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>
