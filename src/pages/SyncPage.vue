<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { BACKEND_ENABLED, SYNC_ENABLED } from '@/config'
import { getBackendBase, setBackendBase, resetBackendBase } from '@/services/backendBase'
import { loginErrorText, shortIdentity } from '@/services/identity'
import type { ClaimAllResult } from '@/stores/trip'
import { useToast } from '@/utils/toast'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'

const store = useTripStore()

const author = ref(store.sync.author)
const joinCode = ref('')
const joinMsg = ref('')
const busy = ref(false)
const online = ref<boolean | null>(null)
const { toast, toastShow } = useToast()
// 账号（微信 openid）
const loggedIn = computed(() => store.isLoggedIn())
const identityLabel = computed(() => shortIdentity(store.sync.identity))
const isDevLogin = computed(() => store.sync.identity?.dev === true)
const loginBusy = ref(false)
const loginMsg = ref('')

const active = computed(() => store.activeTrip)
const code = computed(() => (active.value ? store.sync.codes[active.value.id] || '' : ''))

const dirtyCount = computed(() => store.dirtyTripIds.length)
const syncedTrips = computed(() => store.trips.filter((t) => store.sync.codes[t.id]).length)

function fmt(ts: number): string {
  if (!ts) return '从未'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  return sameDay ? `今天 ${time}` : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

const desc = computed(() => {
  if (!SYNC_ENABLED) return '当前构建未开启云同步，数据只存在本机。'
  switch (store.sync.lastStatus) {
    case 'syncing':
      return '正在与云端合并…'
    case 'ok':
      return dirtyCount.value ? `还有 ${dirtyCount.value} 个行程待推送` : '本地与云端已一致'
    case 'offline':
      return `${store.syncMessage || '连不上后端'}。改动都还在本机，联网后会自动重试。`
    case 'error':
      return store.syncMessage || '同步失败'
    default:
      return dirtyCount.value ? `有 ${dirtyCount.value} 个行程还没同步过` : '还没有同步过'
  }
})

async function probe() {
  online.value = null
  online.value = await store.pingBackend()
}

// ── 自建服务器地址（运行时可改，真机连局域网 IP / 免费容器域名）──
const base = ref(getBackendBase())
const baseInput = ref(base.value)
const baseBusy = ref(false)

async function applyBase() {
  void probe()
  store.restartRealtime()
  await store.syncAll().catch(() => {})
}

async function saveBase() {
  if (baseBusy.value) return
  baseBusy.value = true
  const saved = setBackendBase(baseInput.value)
  baseBusy.value = false
  if (!saved) {
    toastShow('地址要以 http:// 或 https:// 开头')
    return
  }
  base.value = saved
  toastShow('已保存，正在重连…')
  await applyBase()
}

async function resetBase() {
  resetBackendBase()
  base.value = getBackendBase()
  baseInput.value = base.value
  toastShow('已恢复默认地址')
  await applyBase()
}

onLoad(() => {
  if (!store.ready) store.load()
  void probe()
  // 直接进到本页（而不是从 App 启动）的情形也要把实时通道带起来 ——
  // 否则用户会在这里看到一个「实时未启动」，并以为是自己点坏了什么。
  store.resumeRealtime()
})

async function doSync() {
  if (store.syncing) return
  await store.syncAll()
  await probe()
  toastShow(store.syncMessage || '同步完成')
}

function saveAuthor() {
  store.setAuthor(author.value)
  author.value = store.sync.author
}

async function doLogin() {
  if (loginBusy.value) return
  loginBusy.value = true
  loginMsg.value = ''
  try {
    await store.login()
    await probe()
    toastShow('已登录')
  } catch (e) {
    // 失败原因必须显示出来：503（后端没配 AppID）和网络不通是完全不同的两件事，
    // 统一报「登录失败」会让人不知道该重试还是该找人配环境。
    loginMsg.value = loginErrorText(e)
  } finally {
    loginBusy.value = false
  }
}

function doLogout() {
  store.logout()
  loginMsg.value = ''
  toastShow('已退出登录')
}

/**
 * 把当前行程归属到我的账号。
 *
 * 只对**接账号体系之前创建的**行程有意义（那些行程没有归属，谁有分享码谁能改）。
 * 分享码本地就有，不需要用户重新输入 —— 它本来就是旧权限模型下的访问凭证。
 * 已经是别人名下的行程会被服务端拒绝（409），这里如实显示出来。
 */
async function doClaim() {
  if (!active.value || !code.value) return
  busy.value = true
  try {
    await store.claimTrip(active.value.id, code.value)
    await probe()
    toastShow('已归属到你的账号')
  } catch (e) {
    toastShow(e instanceof Error ? e.message : '认领失败')
  } finally {
    busy.value = false
  }
}

/**
 * 批量认领：把登录前就已上云的行程一次性归属到账号（逐个切「当前行程」再点认领
 * 太折磨，行程一多必然有人漏）。服务端对已有归属的行程返回 409 —— 那可能就是
 * 你自己的，也可能是别人的，两种都算「不用认领」，在结果列表里如实分开显示。
 */
const claimBusy = ref(false)
const claimResults = ref<ClaimAllResult[]>([])
/** 有「已上云」的行程才可能出现可认领的：纯本地行程推送时自动归属 */
const claimCandidateCount = computed(() => store.trips.filter((t) => store.sync.codes[t.id]).length)

async function doClaimAll() {
  if (claimBusy.value) return
  claimBusy.value = true
  try {
    const res = await store.claimAllLocal()
    claimResults.value = res
    const n = res.filter((r) => r.outcome === 'claimed').length
    const f = res.filter((r) => r.outcome === 'failed').length
    if (f) toastShow(`${n} 个已认领，${f} 个失败`)
    else if (n) toastShow(`已认领 ${n} 个行程`)
    else toastShow('行程都已有归属')
    await probe()
  } finally {
    claimBusy.value = false
  }
}

function claimLabel(r: ClaimAllResult): string {
  if (r.outcome === 'claimed') return '已归属'
  if (r.outcome === 'owned') return '已有归属'
  return r.error || '失败'
}

async function makeCode() {
  if (!active.value) return
  busy.value = true
  try {
    const c = await store.shareCodeOf(active.value.id)
    toastShow(`分享码 ${c}`)
  } catch (e) {
    toastShow(e instanceof Error ? e.message : '生成失败')
  } finally {
    busy.value = false
  }
}

function copyCode() {
  if (!code.value) return
  const trip = active.value
  uni.setClipboardData({
    data: `${trip?.title || '我的行程'}｜分享码 ${code.value}（在「同行」小程序的云同步里填这个码就能加入）`,
    success: () => toastShow('分享码已复制'),
    fail: () => toastShow('复制失败')
  })
}

async function doJoin() {
  const c = joinCode.value.trim().toUpperCase()
  if (c.length < 4) return
  busy.value = true
  joinMsg.value = ''
  try {
    const trip = await store.joinByCode(c)
    joinMsg.value = `已加入「${trip.title}」`
    joinCode.value = ''
    toastShow('已加入，正在同步')
  } catch (e) {
    joinMsg.value = e instanceof Error ? e.message : '加入失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <AppNav title="云同步" subtitle="行程与账单在多台设备、多位同行之间共享" back border />

    <div class="page-body">
      <!-- 状态 -->
      <div class="status" :class="'st-' + store.sync.lastStatus">
        <div class="st-head">
          <span class="st-dot" />
          <span class="st-title">{{ store.syncStatusText }}</span>
          <span class="st-time">{{ fmt(store.sync.lastSyncAt) }}</span>
        </div>
        <p class="st-desc">{{ desc }}</p>
        <!-- 实时通道与同步状态**分开两行**：它们是两条独立通道。
             实时断了不影响数据正确性（改动照样推上去），合成一句会让用户以为数据要丢。 -->
        <p class="st-rt" :class="'rt-' + store.realtime.status">
          <span class="rt-dot" />
          {{ store.realtimeStatusText }}
        </p>
        <button class="btn-primary st-btn" :disabled="store.syncing || !SYNC_ENABLED" @click="doSync">
          {{ store.syncing ? '同步中…' : '立即同步' }}
        </button>
      </div>

      <!-- 概要 -->
      <div class="stats card">
        <div class="stat">
          <p class="st-label">行程</p>
          <p class="st-value num">{{ store.trips.length }}</p>
        </div>
        <div class="stat">
          <p class="st-label">已上云</p>
          <p class="st-value num">{{ syncedTrips }}</p>
        </div>
        <div class="stat">
          <p class="st-label">待推送</p>
          <p class="st-value num">{{ dirtyCount }}</p>
        </div>
        <div class="stat">
          <p class="st-label">删除待报</p>
          <p class="st-value num">{{ store.sync.tombstones.length }}</p>
        </div>
      </div>

      <!-- 账号 -->
      <div class="sec-title"><h2>账号</h2></div>
      <div class="card pad">
        <template v-if="loggedIn">
          <div class="acct">
            <span class="acct-dot" />
            <span class="acct-name">已登录</span>
            <span class="acct-id">{{ identityLabel }}</span>
          </div>
          <p class="tip">
            新行程会归属到你名下：只有你邀请并凭码加入的人才能改动它。别的设备用别的微信号登录，
            就看不到、也改不了你的行程。
          </p>
          <p v-if="isDevLogin" class="tip warn">
            后端处于「开发登录」模式，身份是本地推演出来的、没有经过微信校验，仅供调试使用。
          </p>
          <p v-if="active && code" class="tip">
            当前行程「{{ active.title }}」如果是在登录之前建的，它还没有归属 —— 认领后只有你邀请的人能改。
          </p>
          <button v-if="active && code" class="btn-ghost" :disabled="busy" @click="doClaim">
            {{ busy ? '处理中…' : '把当前行程归属到我的账号' }}
          </button>
          <!-- 批量入口：候选 = 已上云的行程。逐个切换再认领在行程一多时必然漏，
               而且用户根本不知道哪些「还没归属」 —— 让服务端逐个回答，
               已有归属的如实标出来，不假装都认领成功了。 -->
          <template v-if="claimCandidateCount > 0">
            <button class="btn-ghost" :disabled="claimBusy" @click="doClaimAll">
              {{ claimBusy ? '认领中…' : '批量认领已有行程' }}
            </button>
            <div v-if="claimResults.length" class="claim-result">
              <div v-for="r in claimResults" :key="r.id" class="cr-row">
                <span class="cr-title ellipsis">{{ r.title }}</span>
                <span
                  class="tint cr-tag"
                  :class="r.outcome === 'claimed' ? 'visited' : r.outcome === 'owned' ? 'neutral' : 'failed'"
                >
                  {{ claimLabel(r) }}
                </span>
              </div>
            </div>
            <p class="tip">登录前创建并上过云的行程还没有归属，认领后只有你邀请的人能改；别人的行程会自动跳过。</p>
          </template>
          <button class="btn-ghost" @click="doLogout">退出登录</button>
        </template>
        <template v-else>
          <p class="tip only">
            用微信登录后，行程会归属到你名下，服务端才能判断「谁可以改哪个行程」。
          </p>
          <button class="btn-primary" :disabled="loginBusy || !SYNC_ENABLED" @click="doLogin">
            {{ loginBusy ? '登录中…' : '微信登录' }}
          </button>
          <p v-if="loginMsg" class="tip warn">{{ loginMsg }}</p>
          <p class="tip">不登录也能用：凭分享码协作即可，只是服务端无法分辨你和其他人。已经建好的行程不会因为登录而受限，可以在行程详情里认领。</p>
        </template>
      </div>

      <!-- 署名 -->
      <div class="sec-title"><h2>同步署名</h2></div>
      <div class="card pad">
        <div class="field">
          <label class="field-label">名字</label>
          <input
            v-model="author"
            class="field-input"
            maxlength="24"
            placeholder="同行的人靠它分辨是谁改的"
            @blur="saveAuthor"
          />
        </div>
        <p class="tip">只写在本机、随改动一起推给同行的人，作为展示用的称呼；真正的身份是上面的微信账号。</p>
      </div>

      <!-- 分享码 -->
      <div class="sec-title"><h2>邀请同行的人</h2></div>
      <div class="card pad">
        <div v-if="!active" class="tip only">先创建或选择一个行程</div>
        <template v-else>
          <div class="trip-name ellipsis">{{ active.title }}</div>
          <div v-if="code" class="code-box">
            <span class="code">{{ code }}</span>
            <button class="btn-ghost code-btn" @click="copyCode">
              <AppIcon name="copy" :size="15" />
              复制
            </button>
          </div>
          <button v-else class="btn-primary" :disabled="busy" @click="makeCode">
            {{ busy ? '生成中…' : '生成分享码' }}
          </button>
          <p class="tip">
            把 6 位码发给同行的人，他们在下面「加入行程」里填上，就能看到同一份行程和账单，改动会互相合并。
          </p>
        </template>
      </div>

      <!-- 加入 -->
      <div class="sec-title"><h2>加入别人的行程</h2></div>
      <div class="card pad">
        <div class="join-row">
          <input
            v-model="joinCode"
            class="field-input code-in"
            maxlength="8"
            placeholder="6 位分享码"
          />
          <button class="btn-primary join-btn" :disabled="joinCode.trim().length < 4 || busy" @click="doJoin">
            加入
          </button>
        </div>
        <p class="tip">{{ joinMsg || '加入后这份行程会出现在你的列表里，双方改动会自动合并。' }}</p>
      </div>

      <!-- 说明 -->
      <div class="sec-title"><h2>同步规则</h2></div>
      <div class="card pad">
        <div class="kv">
          <span class="muted">会同步</span>
          <span>行程、成员、每天的安排、账单</span>
        </div>
        <div class="kv">
          <span class="muted">不会同步</span>
          <span>城市足迹（另有独立共享）</span>
        </div>
        <div class="kv">
          <span class="muted">冲突处理</span>
          <span>按条目最后修改时间，后改的为准</span>
        </div>
        <div class="kv">
          <span class="muted">删除</span>
          <span>带删除标记同步，不会被旧数据顶回来</span>
        </div>
        <div class="kv">
          <span class="muted">离线</span>
          <span>改动先存本机，联网后自动补推</span>
        </div>
        <div class="kv">
          <span class="muted">服务端</span>
          <span class="ellipsis val">{{ base }}</span>
        </div>
        <div class="kv">
          <span class="muted">连通性</span>
          <span class="val" :class="online === false ? 'off' : online ? 'on' : ''">
            {{ online === null ? '检测中…' : online ? '可达' : '连不上' }}
          </span>
        </div>

        <!-- 自建服务器地址：真机连局域网 IP、或免费容器域名，按设备保存 -->
        <div class="base-edit">
          <input
            v-model="baseInput"
            class="base-input"
            placeholder="http://192.168.x.x:8787"
            :disabled="baseBusy"
            confirm-type="done"
            @confirm="saveBase"
          />
          <div class="base-actions">
            <button class="base-btn primary" :disabled="baseBusy" @click="saveBase">保存并连接</button>
            <button class="base-btn" :disabled="baseBusy" @click="resetBase">恢复默认</button>
          </div>
          <p class="base-tip">
            真机请填电脑的局域网 IP（手机与电脑同一 Wi-Fi，电脑上先 npm run server）；
            体验版需在右上角「…」打开开发调试，才能连自建地址。
          </p>
        </div>
      </div>

      <p class="foot">
        登录与同步使用你的微信身份，行程只有成员可见。自建服务器地址按设备保存，随时可改回默认。
      </p>
    </div>

    <div v-if="toast" class="toast toast-fade">{{ toast }}</div>
  </div>
</template>

<style scoped>
/* 状态卡去掉左侧 3px 彩条：状态已经由标题前的圆点表达了，
   再加一条竖色条只是把同一件事说两遍，而竖条还带圆角、
   在卡片上沿会拐出一道弧线，看起来像是渲染坏了。 */
.status {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.st-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;
}

.st-ok .st-dot,
.st-syncing .st-dot {
  background: var(--brand);
}

.st-offline .st-dot,
.st-error .st-dot {
  background: var(--warn);
}

.st-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.st-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-tertiary);
}

.st-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-top: 8px;
}

.st-btn {
  margin-top: 14px;
  height: 44px;
}

.stats {
  display: flex;
  margin-top: 12px;
  padding: 14px 8px;
}

.stat {
  flex: 1;
  text-align: center;
}

.st-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.st-value {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
  margin-top: 3px;
}

.pad {
  padding: 14px;
}

.tip {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
  margin-top: 10px;
}

.tip.only {
  margin-top: 0;
}

/* 提示但需要被看见（登录失败原因、开发登录警告）—— 用警示色而不是普通灰，
   否则「后端没配微信」这类运维问题会被当成一句无关紧要的说明略过 */
.tip.warn {
  color: var(--warn, #d97706);
}

/* 账号态：名称 + 短标识（openid 本身不适合直接展示给用户） */
.acct {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.acct-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success, #16a34a);
  flex: none;
}

.acct-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.acct-id {
  font-size: 12px;
  color: var(--text-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 批量认领结果：标题 + 结果标签，一行一个 */
.claim-result {
  margin-top: 10px;
  border: 0.5px solid var(--hairline);
  border-radius: var(--radius-md);
  padding: 2px 12px;
}

.cr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.cr-row + .cr-row {
  border-top: 0.5px solid var(--hairline);
}

.cr-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
}

/* 与 DiscoverPage 的足迹标签同一套口径：文字用 -deep，底用 -soft */
.tint.visited {
  color: var(--brand-deep);
  background: var(--brand-soft);
}

.tint.failed {
  color: var(--danger);
  background: var(--danger-soft);
}

/* 实时通道状态行：比主状态弱一级（它是加速层，出问题不丢数据），
   但必须**可见** —— 否则「实时断了」会以「怎么别人改了我不刷新」的形式出现，
   用户只会怀疑数据同步坏了。 */
.st-rt {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.rt-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex: none;
}

.rt-online .rt-dot {
  background: var(--success, #16a34a);
}

.rt-connecting .rt-dot {
  background: var(--warn, #d97706);
}

.rt-offline .rt-dot {
  background: var(--warn, #d97706);
}

.trip-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.code-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--brand-softer);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}

.code {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 3px;
  color: var(--brand-deep);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.code-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
  flex-shrink: 0;
}

.join-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.code-in {
  flex: 1;
  min-width: 0;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.join-btn {
  width: 84px;
  flex-shrink: 0;
  height: 46px;
  font-size: 15px;
}

.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  font-size: 13px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.base-edit {
  padding-top: 12px;
}

.base-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--bg-page, #f6f6f8);
  font-size: 13px;
  color: var(--text-primary);
}

.base-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.base-btn {
  flex: 1;
  /* 居中：global 的 button 重置剥掉了平台默认居中（新见真机「文字左上」问题），
     全库的钮一律显式 flex 居中 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 9px 0;
  border-radius: var(--radius-md);
  background: var(--bg-page, #f0f0f4);
  font-size: 13px;
  color: var(--text-secondary);
}

.base-btn.primary {
  background: var(--primary, #3b82f6);
  color: #fff;
}

.base-btn[disabled] {
  opacity: 0.55;
}

.base-tip {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

.kv:last-child {
  border-bottom: none;
}

.kv .val {
  color: var(--text-secondary);
  text-align: right;
  min-width: 0;
}

.kv .val.on {
  color: var(--brand-deep);
}

.kv .val.off {
  /* 与 .on 对称：on 用 brand-deep，off 原来用 warn 基色（压白底 3.27:1）→ warn-deep 5.77:1 */
  color: var(--warn-deep);
}

.foot {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
  padding: 16px 4px 0;
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
  padding-bottom: calc(var(--safe-bottom) + 24px);
}
</style>
