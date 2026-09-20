<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { shortDate, weekday } from '@/utils/format'
import type { Poll, PollKind } from '@/types'
import type { PollTally, PollOptionTally } from '@/utils/poll'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'

const store = useTripStore()
const tripId = ref('')

const trip = computed(() => store.trips.find((t) => t.id === tripId.value) || null)
const polls = computed(() => (trip.value ? store.pollsOf(tripId.value) : []))
const members = computed(() => (trip.value ? store.membersOf(tripId.value) : []))
const selfMember = computed(() => members.value.find((m) => m.isSelf))
const openPolls = computed(() => polls.value.filter((p) => p.status === 'open'))
const closedPolls = computed(() => polls.value.filter((p) => p.status === 'closed'))

// ── 发起投票 ──
const showCreate = ref(false)
const kind = ref<PollKind>('date')
const draftTitle = ref('')
const draftOptions = ref<string[]>([])
const destInput = ref('')
const MAX_CANDIDATES = 8

function toggleCreate() {
  if (!showCreate.value) {
    kind.value = 'date'
    draftTitle.value = ''
    draftOptions.value = []
    destInput.value = ''
  }
  showCreate.value = !showCreate.value
}

function onDateAdd(e: unknown) {
  const v = String((e as { detail?: { value?: string } }).detail?.value || '')
  if (v) pushCandidate(v)
}

function pushCandidate(label: string) {
  const clean = label.trim()
  if (!clean) return
  if (draftOptions.value.some((c) => c === clean)) return
  if (draftOptions.value.length >= MAX_CANDIDATES) return
  draftOptions.value.push(clean)
}

function addDest() {
  pushCandidate(destInput.value)
  destInput.value = ''
}

function removeCandidate(label: string) {
  draftOptions.value = draftOptions.value.filter((c) => c !== label)
}

function draftLabelOf(label: string): string {
  return kind.value === 'date' ? `${shortDate(label)} ${weekday(label)}` : label
}

function submitPoll() {
  if (!trip.value) return
  const id = store.createPoll({
    tripId: tripId.value,
    kind: kind.value,
    title: draftTitle.value || undefined,
    options: draftOptions.value
  })
  if (id) {
    showCreate.value = false
    uni.showToast({ title: '已发起投票', icon: 'success' })
  }
}

// ── 投票 / 结束 / 应用 / 删除 ──
function myVoteOf(pollId: string): string | null {
  if (!selfMember.value) return null
  return store.votes.find((v) => v.pollId === pollId && v.memberId === selfMember.value!.id)?.optionId ?? null
}

function tallyOf(pollId: string): PollTally | null {
  return store.tallyOf(pollId)
}

function castVote(poll: Poll, optionId: string) {
  if (!selfMember.value) {
    uni.showToast({ title: '先在「同行的人」里标记这是你', icon: 'none' })
    return
  }
  store.castVote(poll.id, selfMember.value.id, optionId)
}

function closePoll(poll: Poll) {
  store.closePoll(poll.id)
}

/** 结果是否已应用到行程 */
function resultApplied(poll: Poll): boolean {
  if (!trip.value || !poll.result) return false
  const o = poll.options.find((x) => x.id === poll.result)
  if (!o) return false
  return poll.kind === 'date' ? trip.value.startDate === o.label : trip.value.destination === o.label
}

function canApply(poll: Poll): boolean {
  return poll.status === 'closed' && !!poll.result && !resultApplied(poll)
}

function applyResult(poll: Poll) {
  if (!canApply(poll)) return
  store.applyPollResult(poll.id)
  uni.showToast({ title: '已应用到行程', icon: 'success' })
}

function removePoll(poll: Poll) {
  uni.showModal({
    title: '删除投票',
    content: '删除后会连同所有票一起移除，所有人都会看到。',
    confirmText: '删除',
    confirmColor: '#B01F16',
    success: (r) => {
      if (r.confirm) store.removePoll(poll.id)
    }
  })
}

function chosenLabel(poll: Poll): string {
  const o = poll.options.find((x) => x.id === poll.result)
  return o ? o.label : ''
}

/** 选项展示文案：日期候选显示「09/16 周三」 */
function optionLabel(poll: Poll, label: string): string {
  return poll.kind === 'date' ? `${shortDate(label)} ${weekday(label)}` : label
}

/** 票数条宽度：占该投票最高票数的比例（无票时为 0） */
function barWidth(o: PollOptionTally, winnerCount: number): string {
  if (!winnerCount) return '0px'
  const pct = Math.max(12, Math.round((o.count / winnerCount) * 100))
  return pct + 'px'
}

function winnerCountOf(tally: PollTally | null): number {
  return tally?.winner?.count ?? 0
}

/** 该投票所有已投票成员（去重，用于底部实名列表） */
function votersOf(tally: PollTally | null): { memberId: string; name: string }[] {
  if (!tally) return []
  const out: { memberId: string; name: string }[] = []
  const seen = new Set<string>()
  for (const o of tally.options) {
    for (const v of o.voters) {
      if (seen.has(v.memberId)) continue
      seen.add(v.memberId)
      out.push(v)
    }
  }
  return out
}

onLoad((options) => {
  tripId.value = String(options?.id || store.activeTripId || '')
})

function goMembers() {
  nav.to('trip-members')
}
</script>

<template>
  <div class="page">
    <AppNav
      :title="trip ? trip.title : '投票'"
      :subtitle="trip ? '谁决定出发日期与目的地' : ''"
      back
      border
    />

    <template v-if="!trip">
      <AppEmpty icon="flag" title="还没有行程" desc="投票挂在行程上，先创建一段旅程" action="创建我的行程" @action="nav.to('trip-create')" />
    </template>

    <template v-else>
      <div class="page-body">
        <!-- ── 发起区 ── -->
        <button class="launch" @click="toggleCreate">
          <AppIcon name="plus" :size="18" :color="showCreate ? 'var(--text-tertiary)' : '#fff'" />
          <span>{{ showCreate ? '收起' : '发起投票' }}</span>
        </button>

        <div v-if="showCreate" class="list create-card">
          <div class="seg-row">
            <button
              v-for="k in ['date', 'destination'] as PollKind[]"
              :key="k"
              class="seg-b"
              :class="{ on: kind === k }"
              @click="kind = k"
            >
              {{ k === 'date' ? '定日期' : '定目的地' }}
            </button>
          </div>

          <div class="field">
            <span class="field-label">标题（可选）</span>
            <input
              v-model="draftTitle"
              class="field-input"
              :placeholder="kind === 'date' ? '哪天出发？' : '去哪儿？'"
              placeholder-class="ph"
              maxlength="40"
            />
          </div>

          <div class="field">
            <span class="field-label">
              {{ kind === 'date' ? '日期候选（点按钮添加）' : '目的地候选（输入城市名后添加）' }}
            </span>
            <div class="cand-row">
              <template v-if="kind === 'date'">
                <picker mode="date" @change="onDateAdd">
                  <button class="add-cand"><AppIcon name="calendar" :size="16" /> 添加日期</button>
                </picker>
              </template>
              <template v-else>
                <input
                  v-model="destInput"
                  class="field-input cand-input"
                  placeholder="城市名，如 成都"
                  placeholder-class="ph"
                  maxlength="40"
                  confirm-type="done"
                  @confirm="addDest"
                />
                <button class="add-cand" @click="addDest">添加</button>
              </template>
            </div>
            <div v-if="draftOptions.length" class="chip-wrap">
              <span v-for="c in draftOptions" :key="c" class="chip removable">
                {{ draftLabelOf(c) }}
                <button class="chip-x" @click="removeCandidate(c)">
                  <AppIcon name="close" :size="12" />
                </button>
              </span>
            </div>
            <p v-else class="list-foot cash-note">还没有候选，至少添加 1 个才能发起。</p>
          </div>

          <button class="btn primary block" :disabled="!draftOptions.length" @click="submitPoll">
            发起投票
          </button>
        </div>

        <!-- ── 投票列表 ── -->
        <template v-if="polls.length">
          <div class="sec-title"><h2>投票中</h2></div>
          <div v-if="!openPolls.length" class="list"><div class="list-row"><span class="grow hint">暂无进行中的投票</span></div></div>

          <div v-for="poll in openPolls" :key="poll.id" class="poll-card">
            <div class="poll-head">
              <span class="tint">{{ poll.kind === 'date' ? '日期' : '目的地' }}</span>
              <span class="poll-title">{{ poll.title }}</span>
              <span class="grow" />
              <button class="poll-del" @click="removePoll(poll)">
                <AppIcon name="trash" :size="15" color="var(--text-tertiary)" />
              </button>
            </div>

            <button
              v-for="o in tallyOf(poll.id)?.options"
              :key="o.option.id"
              class="poll-opt"
              :class="{ mine: myVoteOf(poll.id) === o.option.id }"
              @click="castVote(poll, o.option.id)"
            >
              <span class="opt-check">
                <AppIcon v-if="myVoteOf(poll.id) === o.option.id" name="check" :size="12" />
              </span>
              <span class="opt-label">{{ optionLabel(poll, o.option.label) }}</span>
              <span class="grow" />
              <span class="opt-bar" :style="{ width: barWidth(o, winnerCountOf(tallyOf(poll.id))) }" />
              <span class="opt-count" :class="{ lead: o.option.id === tallyOf(poll.id)?.winner?.option.id }">
                {{ o.count }}
              </span>
            </button>

            <div class="poll-voters">
              <span v-for="v in votersOf(tallyOf(poll.id))" :key="v.memberId" class="voter-chip">{{ v.name }}</span>
              <span v-if="!tallyOf(poll.id)?.total" class="hint">还没有人投</span>
            </div>

            <div class="poll-close-wrap">
              <button class="btn block" :disabled="!tallyOf(poll.id)?.total" @click="closePoll(poll)">
                结束投票
              </button>
            </div>
          </div>

          <div class="sec-title"><h2>已结束</h2></div>
          <div v-if="!closedPolls.length" class="list"><div class="list-row"><span class="grow hint">暂无已结束的投票</span></div></div>

          <div v-for="poll in closedPolls" :key="poll.id" class="poll-card">
            <div class="poll-head">
              <span class="tint">{{ poll.kind === 'date' ? '日期' : '目的地' }}</span>
              <span class="poll-title">{{ poll.title }}</span>
              <span class="grow" />
              <button class="poll-del" @click="removePoll(poll)">
                <AppIcon name="trash" :size="15" color="var(--text-tertiary)" />
              </button>
            </div>

            <div class="result-row">
              <span v-if="poll.result" class="result-tag">{{ poll.kind === 'date' ? '出发日期' : '目的地' }}</span>
              <span v-if="poll.result" class="result-label">{{ optionLabel(poll, chosenLabel(poll)) }}</span>
              <span v-else class="hint">没有收集到有效票</span>
              <span class="grow" />
              <span v-if="resultApplied(poll)" class="tint">已应用</span>
            </div>

            <div
              v-for="o in tallyOf(poll.id)?.options"
              :key="o.option.id"
              class="poll-opt closed"
              :class="{ chosen: poll.result === o.option.id }"
            >
              <span class="opt-check">
                <AppIcon v-if="poll.result === o.option.id" name="check" :size="12" />
              </span>
              <span class="opt-label">{{ optionLabel(poll, o.option.label) }}</span>
              <span class="grow" />
              <span class="opt-count" :class="{ lead: o.option.id === poll.result }">{{ o.count }}</span>
            </div>

            <div class="poll-close-wrap apply-wrap">
              <button v-if="canApply(poll)" class="btn primary block" @click="applyResult(poll)">应用到行程</button>
              <span v-else-if="resultApplied(poll)" class="hint center">结果已写入行程</span>
            </div>
          </div>

          <p v-if="!selfMember" class="list-foot">
            还没有标记「我」—— 到
            <a class="lnk" @click="goMembers">同行的人</a>
            里点自己一下，才能投票。
          </p>
        </template>

        <template v-else>
          <AppEmpty icon="flag" title="还没有投票" desc="发起一个，让大家都来定出发日期和目的地" />
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.launch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 46px;
  margin-bottom: 12px;
  border-radius: var(--radius-md);
  background: var(--brand);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}

.create-card {
  margin-bottom: 16px;
}

.seg-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.seg-b {
  flex: 1;
  height: 38px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}

.seg-b.on {
  background: var(--brand);
  color: #fff;
}

.cand-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cand-input {
  flex: 1;
  min-width: 0;
}

.add-cand {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 38px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}

.chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.chip.removable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chip-x {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 50%;
  background: transparent;
}

.cash-note {
  margin-top: 8px;
}

.poll-card {
  margin-bottom: 14px;
  padding: 14px 14px 12px;
  border-radius: var(--radius-lg);
  background: var(--bg-card);
}

.poll-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.poll-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.poll-del {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border-radius: 6px;
  background: transparent;
}

.poll-opt {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  margin-bottom: 8px;
  padding: 11px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  text-align: left;
}

.poll-opt.mine {
  background: var(--brand-soft);
}

.poll-opt.mine .opt-label {
  color: var(--brand-deep);
}

.poll-opt.closed {
  background: var(--bg-sunken);
}

.poll-opt.closed.chosen {
  background: var(--brand-soft);
}

.poll-opt.closed.chosen .opt-label {
  color: var(--brand-deep);
}

.opt-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  flex-shrink: 0;
}

.mine .opt-check,
.chosen .opt-check {
  background: var(--brand);
  border-color: var(--brand);
}

.opt-check :deep(.icon) {
  color: #fff;
}

.opt-label {
  font-size: 15px;
  color: var(--text-primary);
}

.opt-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--brand);
  opacity: 0.18;
  flex: 0 0 auto;
}

.opt-count {
  min-width: 20px;
  text-align: right;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.opt-count.lead {
  color: var(--brand-deep);
  font-weight: 600;
}

.poll-voters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 4px 10px;
}

.voter-chip {
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 12px;
}

.poll-close-wrap {
  margin-top: 6px;
}

.apply-wrap {
  margin-top: 10px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 11px 12px;
  border-radius: var(--radius-md);
  background: var(--brand-soft);
}

.result-tag {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--brand);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
}

.result-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--brand-deep);
}

.lnk {
  color: var(--brand-deep);
}

.hint.center {
  display: block;
  text-align: center;
  padding: 4px 0;
}
</style>