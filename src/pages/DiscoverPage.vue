<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { useCityStore } from '@/stores/city'
import { nav } from '@/utils/nav'
import AppNav from '@/components/AppNav.vue'
import AppTabBar from '@/components/AppTabBar.vue'
import AppEmpty from '@/components/AppEmpty.vue'
import AppIcon from '@/components/AppIcon.vue'
import type { CityGuide, DiscoverTrip } from '@/types'

const trip = useTripStore()
const city = useCityStore()

const trips = ref<DiscoverTrip[]>([])
const guidesByCity = ref<Record<string, CityGuide[]>>({})
const loading = ref(false)
const needLogin = ref(false)
const errorText = ref('')

/**
 * 足迹聚合：城市 → 谁去过 / 谁想去。
 * 数据来自共享攻略接口（getAllCities）—— 每个人的足迹发布后都在这里。
 */
const footprints = computed(() => {
  const out: { name: string; visited: CityGuide[]; wish: CityGuide[] }[] = []
  for (const [name, guides] of Object.entries(guidesByCity.value)) {
    const visited = guides.filter((g) => g.status === 'visited')
    const wish = guides.filter((g) => g.status === 'wish')
    if (visited.length || wish.length) out.push({ name, visited, wish })
  }
  return out.sort((a, b) => b.visited.length + b.wish.length - (a.visited.length + a.wish.length))
})

async function loadAll() {
  if (!trip.isLoggedIn()) {
    needLogin.value = true
    return
  }
  needLogin.value = false
  loading.value = true
  errorText.value = ''
  try {
    const [t, cities] = await Promise.all([
      city.api().listDiscoverTrips(),
      city.api().getAllCities()
    ])
    trips.value = (t.trips || []) as DiscoverTrip[]
    const map: Record<string, CityGuide[]> = {}
    for (const c of cities.cities || []) map[c.name] = c.guides || []
    guidesByCity.value = map
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 401) needLogin.value = true
    else errorText.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function openTrip(t: DiscoverTrip) {
  if (t.mine) {
    trip.setActiveTrip(t.id)
    nav.to('itinerary')
  } else {
    nav.to('trip-view', { id: t.id })
  }
}

async function doLogin() {
  try {
    await trip.login()
    await loadAll()
    void city.syncMine()
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '登录失败', icon: 'none' })
  }
}

function fmtDateRange(t: DiscoverTrip): string {
  if (!t.startDate) return ''
  return t.endDate && t.endDate !== t.startDate ? `${t.startDate} ~ ${t.endDate}` : t.startDate
}

onLoad(() => {
  void loadAll()
})
</script>

<template>
  <div class="page">
    <AppNav title="发现" subtitle="大家的行程与足迹" home border />

    <template v-if="needLogin">
      <AppEmpty
        icon="user"
        title="先登录再看"
        desc="登录后可以看到所有人的行程与足迹"
        action="微信登录"
        @action="doLogin"
      />
    </template>

    <template v-else>
      <div class="page-body">
        <p v-if="errorText" class="error">{{ errorText }}</p>

        <!-- ── 大家的行程 ── -->
        <div class="sec-title">
          <h2>大家的行程</h2>
          <span class="sec-hint">{{ trips.length }} 段</span>
        </div>

        <p v-if="loading" class="list-foot">加载中…</p>
        <div v-else-if="!trips.length" class="list hint-card">
          <p class="hint">还没有公开的行程，创建一个就会出现在这里</p>
        </div>
        <div v-else class="list">
          <template v-for="(t, i) in trips" :key="t.id">
            <div v-if="i" class="list-sep" />
            <button class="trip-row" @click="openTrip(t)">
              <span class="trip-main">
                <span class="trip-title">
                  {{ t.title }}
                  <span v-if="t.mine" class="tint mine-badge">我的</span>
                </span>
                <span class="trip-sub">
                  <template v-if="t.destination">{{ t.destination }} · </template>
                  <template v-if="t.startDate">{{ fmtDateRange(t) }} · </template>
                  {{ t.counts.days }} 天 {{ t.counts.items }} 个安排
                </span>
              </span>
              <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
            </button>
          </template>
        </div>

        <!-- ── 大家的足迹 ── -->
        <div class="sec-title">
          <h2>大家的足迹</h2>
          <span class="sec-hint">{{ footprints.length }} 座城市</span>
        </div>

        <div v-if="!footprints.length" class="list hint-card">
          <p class="hint">还没有人标注足迹，去「足迹」页标记你去的城市</p>
        </div>
        <div v-else class="list">
          <template v-for="(f, i) in footprints" :key="f.name">
            <div v-if="i" class="list-sep" />
            <div class="fp-card">
              <p class="fp-city">{{ f.name }}</p>
              <div v-if="f.visited.length" class="fp-row">
                <span class="tint fp-tag visited">去过</span>
                <span class="fp-who">{{ f.visited.map((g) => g.author).join('、') }}</span>
              </div>
              <div v-if="f.wish.length" class="fp-row">
                <span class="tint fp-tag wish">想去</span>
                <span class="fp-who">{{ f.wish.map((g) => g.author).join('、') }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>

    <AppTabBar current="discover" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-page);
  padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 16px);
}

.page-body {
  padding: 12px 16px 0;
}

.error {
  margin: 4px 0 8px;
  font-size: 13px;
  color: var(--danger);
}

.hint {
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.hint-card {
  padding: 18px 16px;
}

.trip-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  transition: background 0.12s ease;
}

.trip-row:active {
  background: var(--bg-subtle);
}

.trip-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.trip-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.mine-badge {
  height: 18px;
  background: var(--brand-soft);
  color: var(--brand-deep);
}

.trip-sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-card {
  padding: 12px 16px;
}

.fp-city {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.fp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.fp-tag {
  height: 19px;
}

.fp-tag.visited {
  color: var(--brand-deep);
  background: var(--brand-soft);
}

.fp-tag.wish {
  /* 与上面的 .visited 对称：visited 已经用 brand-deep，这里原来用 warn 基色
     （压 warn-soft 只有 2.97:1）—— 改成 warn-deep 5.25:1 */
  color: var(--warn-deep);
  background: var(--warn-soft);
}

.fp-who {
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
