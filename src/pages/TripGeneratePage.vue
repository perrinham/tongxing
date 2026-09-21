<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import { PREF_OPTIONS, type PaceLevel } from '@/utils/itinerary'
import { isKnownCity } from '@/data/poi'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'

const store = useTripStore()

const tripId = ref('')
const pace = ref<PaceLevel>('normal')
const prefs = ref<string[]>(['food', 'history'])
const generating = ref(false)
// 页面卸载后不再执行完成跳转
let alive = true
onUnmounted(() => {
  alive = false
})
const result = ref('')
const error = ref('')
/** 在线城市的拉取提示（本地库城市为空） */
const loadingTip = ref('')

const trip = computed(() => store.trips.find((t) => t.id === tripId.value) || null)
const isKnownDest = computed(() => !!trip.value && isKnownCity(trip.value.destination))

const paces: { key: PaceLevel; label: string; desc: string }[] = [
  { key: 'relax', label: '松弛', desc: '每天 2 个点，睡到自然醒' },
  { key: 'normal', label: '标准', desc: '每天 3 个点，玩得比较全' },
  { key: 'packed', label: '紧凑', desc: '每天 4 个点，行程拉满' }
]

onLoad((options: Record<string, any> | undefined) => {
  const q = options?.tripId || ''
  tripId.value = q || store.activeTripId || ''
  if (!tripId.value && store.trips.length) {
    tripId.value = store.tripsSorted[0].id
  }
})

function togglePref(key: string) {
  const i = prefs.value.indexOf(key)
  if (i >= 0) prefs.value.splice(i, 1)
  else prefs.value.push(key)
}

async function run() {
  if (!trip.value) {
    error.value = '没有找到行程，请先新建一个'
    return
  }
  generating.value = true
  error.value = ''
  // 非库城市要实时问高德（1-2s，限流重试时更久），给用户明说在干嘛
  loadingTip.value = isKnownDest.value ? '' : `正在拉取「${trip.value.destination}」的高德点位，约 1-2 秒…`
  // 让 loading 状态先渲染出来，再跑（本地库同步完成；在线城市要等高德检索，约 1-2s）
  setTimeout(async () => {
    try {
      const summary = await store.generateAsync(tripId.value, {
        destination: trip.value!.destination,
        startDate: trip.value!.startDate,
        endDate: trip.value!.endDate,
        peopleCount: store.membersOf(tripId.value).length,
        prefs: prefs.value,
        pace: pace.value
      })
      result.value = summary
      // 用户若已手动返回，不再强制拉回行程页
      setTimeout(() => {
        if (alive) nav.replace('itinerary')
      }, 620)
    } catch (e) {
      // 在线城市的失败带具体原因（限流/断网），比笼统的「生成失败」可行动
      error.value = (e as Error)?.message || '生成失败，换个偏好再试一次'
    } finally {
      generating.value = false
      loadingTip.value = ''
    }
  }, 120)
}
</script>

<template>
  <div class="page">
    <AppNav :title="result ? '生成完成' : '生成行程草稿'" back />

    <div class="page-body">
      <div v-if="trip" class="card trip-card">
        <div class="row-between">
          <div class="grow">
            <p class="trip-title ellipsis">{{ trip.title }}</p>
            <p class="trip-sub">
              {{ trip.destination }} · {{ trip.startDate }} → {{ trip.endDate }}
            </p>
          </div>
          <span class="day-badge">{{ store.daysOf(trip.id).length || '—' }} 天</span>
        </div>
      </div>

      <div v-if="!result">
        <div class="sec-title">
          <h2>这次想要什么</h2>
          <span class="sec-hint">可多选</span>
        </div>
        <div class="card">
          <div class="pref-grid">
            <button
              v-for="p in PREF_OPTIONS"
              :key="p.key"
              class="pref"
              :class="{ active: prefs.includes(p.key) }"
              @click="togglePref(p.key)"
            >
              <span class="pref-check">
                <AppIcon
                  v-if="prefs.includes(p.key)"
                  name="check"
                  :size="12"
                  color="#fff"
                  :stroke="2.6"
                />
              </span>
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="sec-title">
          <h2>节奏</h2>
        </div>
        <div class="card">
          <div class="pace-list">
            <button
              v-for="p in paces"
              :key="p.key"
              class="pace"
              :class="{ active: pace === p.key }"
              @click="pace = p.key"
            >
              <div class="grow left">
                <p class="pace-label">{{ p.label }}</p>
                <p class="pace-desc">{{ p.desc }}</p>
              </div>
              <span class="radio" :class="{ on: pace === p.key }">
                <span v-if="pace === p.key" class="dot" />
              </span>
            </button>
          </div>
        </div>

        <p class="note">
          {{ isKnownDest
            ? '优先参考各城市经典路线（携程 / 高德热门玩法）排布；生成后可以随意拖动和增删。'
            : '该城市走高德在线点位库（景点 / 商圈 / 餐饮按评分取头部），生成约需 1-2 秒；离线时回退内置城市模板。' }}
        </p>
      </div>

      <div v-else class="done">
        <div class="done-icon">
          <AppIcon name="check" :size="26" color="#fff" :stroke="2.4" />
        </div>
        <p class="done-title">草稿已就绪</p>
        <p class="done-sub">{{ result }}</p>
      </div>

      <p v-if="loadingTip && generating" class="loading-tip">{{ loadingTip }}</p>
      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <div v-if="!result" class="foot-bar">
      <button class="btn-primary" :disabled="generating || !trip" @click="run">
        <AppIcon :name="generating ? 'refresh' : 'sparkle'" :size="18" />
        {{ generating ? '正在排布…' : '开始生成' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.trip-card {
  margin-top: 8px;
}

.trip-title {
  font-size: 16px;
  font-weight: 500;
}

.trip-sub {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.day-badge {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
}

.pref-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pref {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 14px;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.pref.active {
  background: var(--brand-soft);
  color: var(--brand-deep);
  font-weight: 500;
}

.pref-check {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: transparent;
}

.pref.active .pref-check {
  background: var(--brand);
  border-color: var(--brand);
}

.pace-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pace {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  text-align: left;
  transition: background 0.15s ease;
}

.pace.active {
  background: var(--brand-soft);
}

.pace .left {
  min-width: 0;
}

.pace-label {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.pace-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.radio {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.radio.on {
  border-color: var(--brand);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
}

.note {
  margin: 18px 4px 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

.done {
  text-align: center;
  padding: 56px 20px;
}

.done-icon {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 18px;
}

.done-title {
  font-size: 17px;
  font-weight: 500;
}

.done-sub {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

.err {
  margin-top: 14px;
  font-size: 13px;
  color: var(--danger);
  text-align: center;
}

.loading-tip {
  margin-top: 14px;
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
}

.foot-bar {
  position: sticky;
  bottom: 0;
  padding: 12px 16px calc(16px + var(--safe-bottom));
  /* 渐变的「透明端」也必须写 --bg-page 自己的 RGB（原来是旧米色 rgba(248,247,244,0)）。 */
  background: linear-gradient(to top, var(--bg-page) 72%, rgba(242, 242, 247, 0));
}
</style>
