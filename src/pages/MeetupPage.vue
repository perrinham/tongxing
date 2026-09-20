<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onHide, onLoad, onShow } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import type { LocationShare, Member } from '@/types'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppAvatar from '@/components/AppAvatar.vue'

const store = useTripStore()
const tripId = ref('')

const trip = computed(() => store.trips.find((t) => t.id === tripId.value) || null)
const meetup = computed(() => (trip.value ? store.meetupOf(tripId.value) : null))
const members = computed(() => (trip.value ? store.membersOf(tripId.value) : []))
const selfMember = computed(() => members.value.find((m) => m.isSelf) || null)
const sharing = computed(() => (trip.value ? store.isSharingLocation(tripId.value) : false))

interface ShareRow {
  loc: LocationShare
  member: Member | undefined
  isSelf: boolean
}

/** 共享中的成员位置列表：自己排最前，其余按上报时间倒序 */
const shareRows = computed<ShareRow[]>(() => {
  if (!trip.value) return []
  const rows: ShareRow[] = store.memberLocationsOf(tripId.value).map((loc) => ({
    loc,
    member: members.value.find((m) => m.id === loc.memberId),
    isSelf: loc.memberId === selfMember.value?.id
  }))
  rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
    return (b.loc.updatedAt ?? 0) - (a.loc.updatedAt ?? 0)
  })
  return rows
})

/** 我自己的最新位置（给别人算距离用） */
const myLoc = computed(() => shareRows.value.find((r) => r.isSelf)?.loc ?? null)

// ── 集合点 ──

function chooseSpot() {
  const cur = meetup.value
  uni.chooseLocation({
    ...(cur ? { latitude: cur.lat, longitude: cur.lng } : {}),
    success: (r) => {
      store.setMeetup(tripId.value, {
        title: (r.name || '').trim() || '集合点',
        address: (r.address || '').trim(),
        lat: r.latitude,
        lng: r.longitude
      })
      uni.showToast({ title: '集合点已更新', icon: 'success' })
    },
    fail: (e) => {
      const msg = String((e as unknown as { errMsg?: string })?.errMsg || '')
      if (msg.includes('cancel')) return
      uni.showToast({ title: '选点失败，请检查位置权限', icon: 'none' })
    }
  })
}

function viewMeetup() {
  const m = meetup.value
  if (!m) return
  uni.openLocation({
    latitude: m.lat,
    longitude: m.lng,
    name: m.title,
    address: m.address || '',
    fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
  })
}

function clearMeetup() {
  uni.showModal({
    title: '清除集合点',
    content: '清除后所有人都看不到这个集合点。',
    confirmText: '清除',
    confirmColor: '#B01F16',
    success: (r) => {
      if (r.confirm) {
        store.removeMeetup(tripId.value)
        uni.showToast({ title: '已清除', icon: 'none' })
      }
    }
  })
}

// ── 共享位置 ──

/** 定时上报句柄；页面隐藏/卸载必须清掉，但共享记录本身保留（用户手动开关） */
let locTimer: ReturnType<typeof setInterval> | null = null
const SHARE_INTERVAL_MS = 15000

function reportOnce() {
  uni.getLocation({
    type: 'gcj02',
    isHighAccuracy: true,
    success: (r) => {
      store.updateLocation(tripId.value, r.latitude, r.longitude, r.accuracy ?? 0)
    },
    fail: () => {
      uni.showToast({ title: '定位失败，请检查位置权限', icon: 'none' })
    }
  })
}

function startTimer() {
  stopTimer()
  locTimer = setInterval(reportOnce, SHARE_INTERVAL_MS)
}

function stopTimer() {
  if (locTimer !== null) {
    clearInterval(locTimer)
    locTimer = null
  }
}

function toggleShare() {
  if (!trip.value) return
  if (sharing.value) {
    store.stopSharing(tripId.value)
    stopTimer()
    uni.showToast({ title: '已停止共享', icon: 'none' })
  } else {
    if (!selfMember.value) {
      uni.showToast({ title: '先在「同行的人」里标记这是你', icon: 'none' })
      return
    }
    reportOnce() // 立即报一次，成功即创建记录（= 开始共享）
    startTimer()
  }
}

onShow(() => {
  // 已在共享状态时回到本页，恢复定时上报
  if (sharing.value) startTimer()
})

onHide(stopTimer)
onUnmounted(stopTimer)

// ── 展示辅助 ──

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 球面距离（米） */
function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(s))
}

/** 距「我」的显示文案；无我的位置时返回空 */
function distOf(loc: LocationShare): string {
  const mine = myLoc.value
  if (!mine || (loc.id === mine.id)) return ''
  const d = distMeters(mine.lat, mine.lng, loc.lat, loc.lng)
  return d < 1000 ? `距你 ${Math.round(d)} 米` : `距你 ${(d / 1000).toFixed(1)} 公里`
}

function locSub(loc: LocationShare): string {
  const parts = [distOf(loc), timeAgo(loc.updatedAt ?? 0)].filter(Boolean)
  return parts.join(' · ')
}

function viewMember(row: ShareRow) {
  uni.openLocation({
    latitude: row.loc.lat,
    longitude: row.loc.lng,
    name: row.member?.name || '成员位置',
    address: `上报于 ${timeAgo(row.loc.updatedAt ?? 0)}`,
    fail: () => uni.showToast({ title: '无法打开地图', icon: 'none' })
  })
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
      :title="trip ? trip.title : '集合点'"
      :subtitle="trip ? '约好在哪里碰头' : ''"
      back
      border
    />

    <template v-if="!trip">
      <AppEmpty
        icon="flag"
        title="还没有行程"
        desc="集合点挂在行程上，先创建一段旅程"
        action="创建我的行程"
        @action="nav.to('trip-create')"
      />
    </template>

    <template v-else>
      <div class="page-body">
        <!-- ── 集合点 ── -->
        <div class="sec-title"><h2>集合点</h2></div>
        <div class="list">
          <button class="list-row" @click="chooseSpot">
            <AppIcon name="location" :size="18" color="var(--brand)" />
            <div class="grow pad main">
              <p class="val" :class="{ unset: !meetup }">
                {{ meetup ? meetup.title : '未定，点这里选一处碰头地点' }}
              </p>
              <p v-if="meetup && meetup.address" class="sub ellipsis">{{ meetup.address }}</p>
            </div>
            <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
          </button>
          <template v-if="meetup">
            <div class="list-sep" />
            <div class="list-row acts">
              <button class="btn-tint sm" @click="viewMeetup">
                <AppIcon name="map" :size="15" /> 查看地图
              </button>
              <button class="btn-text sm danger" @click="clearMeetup">清除</button>
            </div>
          </template>
        </div>

        <!-- ── 共享位置 ── -->
        <div class="sec-title"><h2>共享位置</h2></div>
        <div class="list">
          <div class="list-row">
            <AppIcon name="users" :size="18" color="var(--text-secondary)" />
            <div class="grow pad main">
              <p class="val">共享我的位置</p>
              <p class="sub">{{ sharing ? '正在上报，成员可见' : '开启后成员能在地图上看到你' }}</p>
            </div>
            <button class="toggle" :class="{ on: sharing }" @click="toggleShare">
              <span class="knob" />
            </button>
          </div>
          <p class="list-foot">仅在本页打开期间上报位置；退出页面后成员看到的是你的最后位置。</p>

          <template v-if="shareRows.length">
            <div class="list-sep" />
            <button
              v-for="row in shareRows"
              :key="row.loc.id"
              class="list-row"
              @click="viewMember(row)"
            >
              <AppAvatar
                :name="row.member?.name || '?'"
                :color-index="row.member?.colorIndex ?? 0"
                :size="30"
              />
              <div class="grow pad main">
                <p class="val">
                  {{ row.member?.name || '已退出的成员' }}
                  <span v-if="row.isSelf" class="tint">我</span>
                </p>
                <p class="sub">{{ locSub(row.loc) }}</p>
              </div>
              <AppIcon name="location" :size="15" color="var(--brand)" />
            </button>
          </template>
          <div v-else class="list-row">
            <span class="grow pad muted none-hint">还没有人在共享位置</span>
          </div>
        </div>

        <p v-if="!selfMember" class="list-foot">
          还没有标记「我」—— 到
          <a class="lnk" @click="goMembers">同行的人</a>
          里点自己一下，才能共享位置。
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pad {
  margin-left: 10px;
}

.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.val {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.val.unset {
  color: var(--text-tertiary);
  font-weight: 400;
}

.sub {
  font-size: 12px;
  color: var(--text-tertiary);
  max-width: 100%;
}

/* 操作行：白底行里放两个轻按钮，用 margin 拉开而不是贴边 */
.acts {
  gap: 10px;
}

.acts .btn-tint.sm,
.acts .btn-text.sm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 12px;
  font-size: 13px;
}

.btn-text.danger {
  color: #b01f16;
}

/* 开关：44×26 圆角滑轨 + 白色滑块，on 时滑轨染品牌色 */
.toggle {
  position: relative;
  width: 44px;
  height: 26px;
  border-radius: 13px;
  background: var(--line-strong);
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.toggle.on {
  background: var(--brand);
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

.toggle.on .knob {
  transform: translateX(18px);
}

.none-hint {
  font-size: 13px;
}

.lnk {
  color: var(--brand-deep);
}
</style>
