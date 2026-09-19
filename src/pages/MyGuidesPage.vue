<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { useCityStore } from '@/stores/city'
import { useTripStore } from '@/stores/trip'
import { BACKEND_ENABLED } from '@/config'
import { nav } from '@/utils/nav'
import { shortIdentity } from '@/services/identity'
import type { CityGuide } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppSheet from '@/components/AppSheet.vue'

/**
 * 「我的攻略」——按账号归集的云端足迹清单。
 *
 * 与「城市足迹」页的分工：那页看的是**本机**（能编辑、能在地图上标点），
 * 这页看的是**服务端记在我名下的**（跨设备、含历史残留）。两边都不是对方的
 * 子集，所以本页除了列表还做一件正事：把两边的差集摆出来——
 *   · 云端有、本机没有：换设备留下来的，一键并回本机；
 *   · 本机有、云端没有：发布没成功（离线 / 403），一键补发。
 *
 * 只删不建：编辑走「城市足迹」页，这里只负责「服务端到底存了什么」这件事。
 */
const cityStore = useCityStore()
const tripStore = useTripStore()

const cloud = ref<CityGuide[]>([])
const loading = ref(false)
const errMsg = ref('')
const tab = ref<'all' | 'visited' | 'wish'>('all')
const busyId = ref('')
const toast = ref('')

/** 待确认撤回的记录（撤销是破坏性的，必须让人看清撤的是哪一条） */
const pending = ref<CityGuide | null>(null)
const showConfirm = ref(false)

const openid = computed(() =>
  tripStore.isLoggedIn() ? String(tripStore.sync.identity?.openid || '') : ''
)
const who = computed(() => shortIdentity(tripStore.sync.identity))

function toastShow(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 1800)
}

async function load() {
  // 未登录 / 未启用云同步时不发请求：后端对这两者分别返回 401 / 不可达，
  // 界面已经有专门的空态，打出去只会多一次无意义的网络往返和一条告警
  if (!BACKEND_ENABLED || !openid.value) return
  loading.value = true
  errMsg.value = ''
  try {
    cloud.value = await cityStore.fetchMyCloud()
  } catch (e) {
    cloud.value = []
    errMsg.value = e instanceof Error ? e.message : '拉取失败'
  } finally {
    loading.value = false
  }
}

/** 每条记录按城市分组，组内按更新时间倒序（最新的那条就是本机实际在用的） */
const groups = computed(() => {
  const byCity = new Map<string, CityGuide[]>()
  for (const g of cloud.value) {
    const name = String(g.cityName || '').trim()
    if (!name) continue
    if (tab.value !== 'all' && g.status !== tab.value) continue
    const arr = byCity.get(name)
    if (arr) arr.push(g)
    else byCity.set(name, [g])
  }
  return [...byCity.entries()]
    .map(([name, items]) => ({
      city: name,
      items: [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    }))
    .sort((a, b) => (b.items[0].updatedAt || 0) - (a.items[0].updatedAt || 0))
})

const countAll = computed(() => cloud.value.length)
const countVisited = computed(() => cloud.value.filter((g) => g.status === 'visited').length)
const countWish = computed(() => cloud.value.filter((g) => g.status === 'wish').length)
/** 同一城市有多条 = 改过昵称留下的旧行，这是本页最常被用到的信息 */
const dupCount = computed(() => groups.value.filter((g) => g.items.length > 1).length)

/** 本机属于我的足迹（未登录时 owner 为空串，与 openid 同为 ''，正好对上） */
const mineLocal = computed(() => cityStore.passports.filter((p) => p.owner === openid.value))

const cloudNames = computed(() => {
  const s = new Set<string>()
  for (const g of cloud.value) {
    const n = String(g.cityName || '').trim()
    if (n) s.add(n)
  }
  return s
})

/** 本机有、云端没有 —— 大概率是那次发布没成功 */
const notPublished = computed(() =>
  mineLocal.value.filter((p) => !cloudNames.value.has(p.name.trim())).map((p) => p.name)
)
/** 云端有、本机没有 —— 别的设备留下的（正常情况下登录后会自动并回，出现即说明那次没并上） */
const missingLocal = computed(() =>
  [...cloudNames.value].filter((n) => !cityStore.passports.some((p) => p.name.trim() === n))
)

function fmtTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function summaryOf(g: CityGuide): string {
  const t = (g.guide || g.review || g.wishNote || '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 46) : ''
}

function askRetract(g: CityGuide) {
  pending.value = g
  showConfirm.value = true
}

async function doRetract() {
  const g = pending.value
  if (!g) return
  showConfirm.value = false
  pending.value = null
  busyId.value = g.id
  try {
    await cityStore.deleteCloudGuide(g.id, g.cityName)
    await load()
    toastShow('已从云端撤回')
  } catch (e) {
    toastShow(e instanceof Error ? e.message : '撤回失败')
  } finally {
    busyId.value = ''
  }
}

/**
 * 补发一条本机没发上去的。
 *
 * ⚠️ `publishMyGuide` 内部自吞错误（只 warn），所以「调用成功」不代表发出去了。
 * 这里发完再拉一次云端：仍查不到就如实说没成功，而不是假装好了。
 */
async function republish(name: string) {
  busyId.value = 'pub:' + name
  await cityStore.publishMyGuide(name)
  await load()
  const ok = cloudNames.value.has(name.trim())
  toastShow(ok ? `已补发「${name}」` : `「${name}」补发后云端仍查不到，请检查网络或登录状态`)
  busyId.value = ''
}

/** 把云端有、本机没有的并回本机 */
async function pullToLocal() {
  busyId.value = 'pull'
  const n = await cityStore.syncMine()
  await load()
  toastShow(n ? `已并入 ${n} 座城市` : '没有需要并入的记录')
  busyId.value = ''
}

function goCityMap() {
  nav.to('city-map')
}

function goSync() {
  nav.to('sync')
}

// 本机护照在这一页是第一次被读到（其他页面各自 load），先补一次
onLoad(() => {
  if (!cityStore.ready) cityStore.load()
})
// 从足迹页返回本页时云端可能已经变了（那边删了城市 / 改了攻略），
// 所以每次露出都重拉 —— 首次进入时 onShow 紧跟 onLoad 触发，不需要在 onLoad 里再拉一次
onShow(() => {
  void load()
})
</script>

<template>
  <div class="page">
    <AppNav title="我的攻略" subtitle="按账号归集的云端记录" back border />

    <!-- 未启用云同步 / 未登录 / 拉取失败：三种状态各有各的下一步，不能合成一句「暂无数据」 -->
    <AppEmpty
      v-if="!BACKEND_ENABLED"
      icon="pin"
      title="未启用云同步"
      desc="攻略只存在这台设备上，换设备就带不走"
      action="返回"
      @action="nav.back()"
    />
    <AppEmpty
      v-else-if="!openid"
      icon="user"
      title="登录后才能查看"
      desc="云端的攻略按账号归集，登录后才看得到属于你的那些"
      action="去登录"
      @action="goSync"
    />
    <AppEmpty
      v-else-if="errMsg"
      icon="refresh"
      title="拉取失败"
      :desc="errMsg"
      action="重试"
      @action="load"
    />

    <div v-else class="page-body">
      <!-- 概览 -->
      <div class="list">
        <div class="stat3">
          <div class="stat">
            <span class="stat-num num">{{ countAll }}</span>
            <span class="stat-unit">云端</span>
          </div>
          <div class="stat">
            <span class="stat-num num">{{ countVisited }}</span>
            <span class="stat-unit">去过</span>
          </div>
          <div class="stat">
            <span class="stat-num num">{{ countWish }}</span>
            <span class="stat-unit">想去</span>
          </div>
        </div>
        <div class="list-sep" />
        <div class="list-row">
          <span class="grow row-key">账号</span>
          <span class="row-val">{{ who || '—' }}</span>
        </div>
      </div>
      <p class="list-foot">
        这里的记录来自所有登过这个账号的设备。改过昵称会让同一座城市留下多条，较旧的可以逐条撤回。
      </p>

      <!-- 两边对不上：这是本页真正要让人看见的东西 -->
      <template v-if="missingLocal.length || notPublished.length">
        <div class="sec-title">
          <h2>对不上的</h2>
          <span class="sec-hint">{{ missingLocal.length + notPublished.length }} 座城市</span>
        </div>
        <div class="list">
          <template v-for="(name, i) in missingLocal" :key="'m' + name">
            <div v-if="i" class="list-sep" />
            <div class="list-row diff-row">
              <div class="grow">
                <p class="diff-city">{{ name }}</p>
                <p class="diff-sub">云端有，这台设备上没有</p>
              </div>
              <button
                class="btn-tint diff-btn"
                :disabled="busyId === 'pull'"
                @click="pullToLocal"
              >
                {{ busyId === 'pull' ? '并入中' : '并入本机' }}
              </button>
            </div>
          </template>
          <template v-for="name in notPublished" :key="'n' + name">
            <div class="list-sep" />
            <div class="list-row diff-row">
              <div class="grow">
                <p class="diff-city">{{ name }}</p>
                <p class="diff-sub">本机有，云端查不到（那次发布没成功）</p>
              </div>
              <button
                class="btn-tint diff-btn"
                :disabled="busyId === 'pub:' + name"
                @click="republish(name)"
              >
                {{ busyId === 'pub:' + name ? '补发中' : '补发' }}
              </button>
            </div>
          </template>
        </div>
        <p class="list-foot">并入只补不删；补发会重新拉取一次确认是否真的上去了。</p>
      </template>

      <!-- 筛选 -->
      <div class="seg-wrap">
        <div class="seg">
          <button class="seg-item" :class="{ active: tab === 'all' }" @click="tab = 'all'">
            全部 {{ countAll }}
          </button>
          <button class="seg-item" :class="{ active: tab === 'visited' }" @click="tab = 'visited'">
            去过 {{ countVisited }}
          </button>
          <button class="seg-item" :class="{ active: tab === 'wish' }" @click="tab = 'wish'">
            想去 {{ countWish }}
          </button>
        </div>
      </div>

      <div v-if="loading && !cloud.length" class="list loading-card">
        <p class="loading-text">正在拉取云端记录…</p>
      </div>

      <AppEmpty
        v-else-if="!groups.length"
        icon="map"
        :title="tab === 'all' ? '云端还没有记录' : '这个状态下没有记录'"
        desc="在「城市足迹」里标注城市并写下攻略，登录后会自动发布到这里"
        action="去城市足迹"
        @action="goCityMap"
      />

      <template v-else>
        <div class="sec-title">
          <h2>云端记录</h2>
          <span class="sec-hint">
            {{ groups.length }} 座城市<template v-if="dupCount"> · {{ dupCount }} 座有多条</template>
          </span>
        </div>

        <template v-for="g in groups" :key="g.city">
          <div class="list city-card">
            <div class="list-row gc-head">
              <span class="gc-city">{{ g.city }}</span>
              <span v-if="g.items.length > 1" class="tint dup">多条</span>
              <span class="grow" />
              <span class="gc-when">{{ fmtTs(g.items[0].updatedAt) }}</span>
            </div>
            <template v-for="it in g.items" :key="it.id">
              <div class="list-sep" />
              <div class="list-row gc-item">
                <span class="tint" :class="it.status === 'visited' ? 'visited' : 'wish'">
                  {{ it.status === 'visited' ? '去过' : '想去' }}
                </span>
                <div class="grow gc-body">
                  <p class="gc-line1">{{ it.author }} · {{ fmtTs(it.updatedAt) }}</p>
                  <p class="gc-line2 ellipsis">{{ summaryOf(it) || '未填写内容' }}</p>
                </div>
                <button
                  class="gc-del"
                  :disabled="busyId === it.id"
                  @click="askRetract(it)"
                >
                  {{ busyId === it.id ? '撤回中' : '撤回' }}
                </button>
              </div>
            </template>
          </div>
          <p class="list-foot city-foot">只删云端这条，本机的足迹不受影响。</p>
        </template>
      </template>
    </div>

    <div v-if="toast" class="toast toast-fade">{{ toast }}</div>

    <!-- 撤回确认 -->
    <AppSheet v-model="showConfirm" title="撤回这条记录？">
      <p class="confirm-text">
        将删除云端「{{ pending?.cityName }}」下由「{{ pending?.author }}」发布的这条，删除后无法恢复。
      </p>
      <template #footer>
        <div class="confirm-actions">
          <button class="btn-ghost grow-btn" @click="showConfirm = false">取消</button>
          <button class="btn-danger grow-btn" @click="doRetract">确认撤回</button>
        </div>
      </template>
    </AppSheet>
  </div>
</template>

<style scoped>
.seg-wrap {
  /* 只给纵向留白：横向的 16px 由 .page-body 负责，再给就把分段控件挤窄了 */
  padding: 14px 0 2px;
}

.row-key {
  font-size: 15px;
}

.row-val {
  font-size: 13px;
  color: var(--text-secondary);
}

.loading-card {
  padding: 30px 20px;
  text-align: center;
}

.loading-text {
  font-size: 14px;
  color: var(--text-tertiary);
}

.diff-row {
  gap: 10px;
}

.diff-city {
  font-size: 15px;
  font-weight: 500;
}

.diff-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.diff-btn {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
}

.diff-btn[disabled] {
  opacity: 0.5;
}

.city-card {
  margin-top: 0;
}

.gc-head {
  min-height: 40px;
  padding: 10px 16px;
}

.gc-city {
  font-size: 15px;
  font-weight: 600;
}

.gc-when {
  font-size: 12px;
  color: var(--text-tertiary);
}

.tint.visited {
  color: var(--brand-deep);
  background: var(--brand-soft);
}

.tint.wish {
  color: var(--warn-deep);
  background: var(--warn-soft);
}

.tint.dup {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}

.gc-item {
  align-items: flex-start;
  gap: 8px;
}

/* 行内文字块：标签在上、内容在下时，右侧按钮要跟第一行基线对齐，
   所以这里给标签留一个与文字行高对应的上边距 */
.gc-item > .tint {
  margin-top: 2px;
}

.gc-body {
  min-width: 0;
}

.gc-line1 {
  font-size: 12px;
  color: var(--text-tertiary);
}

.gc-line2 {
  font-size: 14px;
  color: var(--text-primary);
  margin-top: 2px;
}

.gc-del {
  flex-shrink: 0;
  height: 30px;
  padding: 0 6px;
  margin-top: 1px;
  font-size: 13px;
  color: var(--danger);
}

.gc-del[disabled] {
  opacity: 0.5;
}

.city-foot {
  padding-bottom: 12px;
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
  bottom: 40px;
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
</style>
