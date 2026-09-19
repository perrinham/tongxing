<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { SYNC_ENABLED } from '@/config'
import { nav } from '@/utils/nav'
import { moneyBrief, shortDate } from '@/utils/format'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppAvatar from '@/components/AppAvatar.vue'
import AppSheet from '@/components/AppSheet.vue'
import AppTabBar from '@/components/AppTabBar.vue'

const store = useTripStore()

const trips = computed(() => store.tripsSorted)
const active = computed(() => store.activeTrip)

const showImport = ref(false)
const importText = ref('')
const toast = ref('')
const confirmReset = ref(false)

function toastShow(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 1800)
}

function switchTrip(id: string) {
  store.setActiveTrip(id)
  nav.reLaunch('itinerary')
}

function createTrip() {
  nav.to('trip-create')
}

function regen() {
  if (!active.value) return
  nav.to('trip-generate', { tripId: active.value.id })
}

function removeTrip(id: string) {
  store.removeTrip(id)
  toastShow('已删除该行程')
}

/** 导出为 JSON 文本，复制到剪贴板（小程序不支持直接下载文件） */
function exportTrip(id: string) {
  const json = store.exportTrip(id)
  if (!json) return
  uni.setClipboardData({
    data: json,
    success: () => toastShow('行程数据已复制（可粘贴保存或导入）'),
    fail: () => toastShow('复制失败')
  })
}

function doImportText() {
  if (!importText.value.trim()) return
  const res = store.importTrip(importText.value)
  showImport.value = false
  importText.value = ''
  toastShow(res.message)
}

function copyShareLink() {
  if (!active.value) return
  const text = `我在用「同行」规划行程：${active.value.title}（${active.value.destination}）`
  uni.setClipboardData({
    data: text,
    success: () => toastShow('分享文案已复制'),
    fail: () => toastShow('复制失败')
  })
}

function resetAll() {
  store.resetAll()
  confirmReset.value = false
  toastShow('本地数据已清空')
}

function goMembers() {
  if (!active.value) return
  nav.to('trip-members')
}

function goCityMap() {
  nav.to('city-map')
}

function goMyGuides() {
  nav.to('my-guides')
}

function goSync() {
  nav.to('sync')
}

/** 首次进入拉一次云端，让「我的」页的状态显示贴近真实 */
onLoad(() => {
  if (!store.ready) store.load()
  if (SYNC_ENABLED) void store.syncAll()
})

const syncTime = computed(() => {
  const t = store.sync.lastSyncAt
  if (!t) return '尚未同步'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
})
</script>

<template>
  <div class="page">
    <AppNav title="我的" border />

    <div class="page-body">
      <!-- 当前行程 -->
      <div v-if="active" class="list active-card">
        <div class="ac-head">
          <div class="grow">
            <p class="ac-title ellipsis">{{ active.title }}</p>
            <p class="ac-sub ellipsis">
              {{ active.destination }} · {{ active.startDate }} → {{ active.endDate }}
            </p>
          </div>
          <button class="btn-tint" @click="copyShareLink">
            <AppIcon name="share" :size="15" />
            分享
          </button>
        </div>
        <div class="list-sep" />
        <div class="stat3 col">
          <div class="stat">
            <span class="stat-num num">{{ store.daysOf(active.id).length }}</span>
            <span class="stat-unit">天数</span>
          </div>
          <div class="stat">
            <span class="stat-num num">{{ store.membersOf(active.id).length }}</span>
            <span class="stat-unit">同行</span>
          </div>
          <div class="stat">
            <span class="stat-num num">{{ moneyBrief(store.spentOf(active.id), active.currency) }}</span>
            <span class="stat-unit">已花</span>
          </div>
          <div class="stat">
            <span class="stat-num num">{{ moneyBrief(store.estimateOf(active.id), active.currency) }}</span>
            <span class="stat-unit">预估</span>
          </div>
        </div>
        <div class="list-sep" />
        <button class="list-row" @click="goMembers">
          <div class="avatar-stack">
            <div v-for="m in store.membersOf(active.id)" :key="m.id" class="av">
              <AppAvatar :name="m.name" :color-index="m.colorIndex" :size="28" ring />
            </div>
          </div>
          <span class="grow" />
          <span class="row-value">管理成员</span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
      </div>

      <!-- 行程列表 -->
      <div class="sec-title">
        <h2>我的行程</h2>
        <button class="btn-text" @click="createTrip">新建</button>
      </div>

      <div v-if="trips.length" class="list">
        <template v-for="(t, i) in trips" :key="t.id">
          <div v-if="i" class="list-sep" />
          <div class="trip-item">
            <div class="ti-main" @click="switchTrip(t.id)">
              <div class="ti-left">
                <p class="ti-title ellipsis">{{ t.title }}</p>
                <p class="ti-sub">
                  {{ t.destination }} · {{ shortDate(t.startDate) }}–{{ shortDate(t.endDate) }}
                  · {{ store.membersOf(t.id).length }} 人
                </p>
              </div>
              <!-- 当前行程用一个对勾表示，不用给整张卡描一圈绿边 ——
                   绿框会把这块内容从页面里「框」出来，视觉重量远超它的信息量。 -->
              <AppIcon
                v-if="t.id === store.activeTripId"
                name="check"
                :size="19"
                color="var(--brand)"
                :stroke="2.4"
              />
            </div>
            <div class="ti-actions">
              <button class="ti-btn" @click="exportTrip(t.id)">
                <AppIcon name="download" :size="16" />
                导出
              </button>
              <button class="ti-btn danger" @click="removeTrip(t.id)">
                <AppIcon name="trash" :size="16" />
                删除
              </button>
            </div>
          </div>
        </template>
      </div>

      <div v-else class="list no-trip">
        <p class="no-trip-text">还没有行程</p>
        <button class="btn-primary no-btn" @click="createTrip">创建行程</button>
      </div>

      <!-- 工具 -->
      <div class="sec-title">
        <h2>行程工具</h2>
      </div>
      <div class="list">
        <button class="tool" :disabled="!active" @click="regen">
          <span class="tool-icon"><AppIcon name="sparkle" :size="17" color="var(--brand)" /></span>
          <span class="grow tool-text">
            <span class="tool-title">重新生成行程</span>
            <span class="tool-desc">换一组偏好，重新排一版</span>
          </span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
        <div class="list-sep indent-icon" />
        <button class="tool" @click="goCityMap">
          <span class="tool-icon"><AppIcon name="map" :size="17" color="var(--brand)" /></span>
          <span class="grow tool-text">
            <span class="tool-title">城市足迹地图</span>
            <span class="tool-desc">标注去过 / 想去，看攻略与评价</span>
          </span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
        <div class="list-sep indent-icon" />
        <button class="tool" @click="goMyGuides">
          <span class="tool-icon"><AppIcon name="flag" :size="17" color="var(--brand)" /></span>
          <span class="grow tool-text">
            <span class="tool-title">我的攻略</span>
            <span class="tool-desc">按账号查看云端记录 · 撤回与补发</span>
          </span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
        <div class="list-sep indent-icon" />
        <button class="tool" @click="goSync">
          <span class="tool-icon"><AppIcon name="refresh" :size="17" color="var(--brand)" /></span>
          <span class="grow tool-text">
            <span class="tool-title">云同步</span>
            <span class="tool-desc">{{ store.syncStatusText }} · {{ syncTime }}</span>
          </span>
          <span v-if="store.dirtyTripIds.length" class="tool-badge">
            {{ store.dirtyTripIds.length }}
          </span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
        <div class="list-sep indent-icon" />
        <button class="tool" @click="showImport = true">
          <span class="tool-icon"><AppIcon name="copy" :size="17" color="var(--brand)" /></span>
          <span class="grow tool-text">
            <span class="tool-title">粘贴导入</span>
            <span class="tool-desc">把导出的 JSON 或同行发来的内容贴上</span>
          </span>
          <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
        </button>
      </div>

      <!-- 关于 -->
      <div class="sec-title">
        <h2>关于</h2>
      </div>
      <div class="list">
        <div class="list-row about-row">
          <span class="grow about-key">数据存储</span>
          <span class="about-val">{{ SYNC_ENABLED ? '本机为主，可同步到自建后端' : '仅本机，不上传' }}</span>
        </div>
        <div class="list-sep" />
        <div class="list-row about-row">
          <span class="grow about-key">同步内容</span>
          <span class="about-val">行程 · 成员 · 安排 · 账单</span>
        </div>
        <div class="list-sep" />
        <div class="list-row about-row">
          <span class="grow about-key">行程生成</span>
          <span class="about-val">规则引擎 + 内置城市点位库</span>
        </div>
        <div class="list-sep" />
        <div class="list-row about-row">
          <span class="grow about-key">结算口径</span>
          <span class="about-val">净额贪心配对，最少转账</span>
        </div>
        <div class="list-sep" />
        <button class="reset-btn" @click="confirmReset = true">清空所有本地数据</button>
      </div>
    </div>

    <AppTabBar current="profile" />

    <div v-if="toast" class="toast toast-fade">{{ toast }}</div>

    <!-- 粘贴导入 -->
    <AppSheet v-model="showImport" title="粘贴导入">
      <textarea
        v-model="importText"
        class="import-area"
        placeholder="把导出的 JSON 内容粘贴到这里"
        rows="8"
      />
      <template #footer>
        <button class="btn-primary" :disabled="!importText.trim()" @click="doImportText">
          导入
        </button>
      </template>
    </AppSheet>

    <!-- 清空确认 -->
    <AppSheet v-model="confirmReset" title="确认清空？">
      <p class="confirm-text">
        所有行程、成员、账单都会被删除，且无法撤销。建议先导出需要保留的行程。
      </p>
      <template #footer>
        <div class="confirm-actions">
          <button class="btn-ghost grow-btn" @click="confirmReset = false">取消</button>
          <button class="btn-danger grow-btn" @click="resetAll">确认清空</button>
        </div>
      </template>
    </AppSheet>
  </div>
</template>

<style scoped>
.active-card {
  margin-top: 4px;
}

.ac-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 16px 14px;
}

.ac-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

.ac-sub {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.row-value {
  font-size: 15px;
  color: var(--text-secondary);
}

/* 行程块：主行 + 底部动作条，中间一条发丝线 */
.trip-item {
  display: flex;
  flex-direction: column;
}

.ti-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  transition: background 0.12s ease;
}

.ti-main:active {
  background: var(--bg-subtle);
}

.ti-left {
  flex: 1;
  min-width: 0;
}

.ti-title {
  font-size: 15px;
  font-weight: 500;
}

.ti-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.ti-actions {
  display: flex;
  border-top: 0.5px solid var(--hairline);
  margin-left: 16px;
}

.ti-btn {
  flex: 1;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  color: var(--text-secondary);
}

.ti-btn.danger {
  color: var(--danger);
}

.ti-btn:active {
  background: var(--bg-subtle);
}

.no-trip {
  padding: 30px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.no-trip-text {
  font-size: 14px;
  color: var(--text-tertiary);
}

.no-btn {
  margin-top: 16px;
  height: 42px;
  padding: 0 24px;
  width: auto;
}

/* 工具行：行首小圆角图标 + 两行文字 + chevron */
.tool {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 16px;
  text-align: left;
  transition: background 0.12s ease;
}

.tool:active {
  background: var(--bg-subtle);
}

.tool[disabled] {
  opacity: 0.45;
}

.tool-icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--brand-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tool-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tool-title {
  font-size: 15px;
  font-weight: 500;
}

.tool-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 1px;
}

.tool-badge {
  flex-shrink: 0;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--accent-soft);
  /* 11px 小徽标：accent 基色压 accent-soft 只有 2.69:1，走 -deep 是 4.68:1 */
  color: var(--accent-deep);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 2px;
}

.list-sep.indent-icon {
  margin-left: 60px;
}

.about-row {
  gap: 12px;
}

.about-key {
  color: var(--text-primary);
}

.about-val {
  color: var(--text-secondary);
  text-align: right;
  font-size: 13px;
}

/* 破坏性行：iOS 里放在分组卡最后一行，红字、不填充 */
.reset-btn {
  width: 100%;
  height: 48px;
  font-size: 15px;
  color: var(--danger);
}

.reset-btn:active {
  background: var(--bg-subtle);
}

.import-area {
  width: 100%;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.confirm-text {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.7;
  padding: 6px 0 12px;
}

.confirm-actions {
  display: flex;
  gap: 10px;
}

.grow-btn {
  flex: 1;
}

.btn-danger {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  border-radius: 12px;
  background: var(--danger);
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}

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
  max-width: 90vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast-fade {
  animation: toast-in 0.25s ease both;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.page {
  padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom));
}
</style>
