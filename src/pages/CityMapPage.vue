<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useCityStore } from '@/stores/city'
import { nav } from '@/utils/nav'
import { AMAP_ENABLED, BACKEND_ENABLED } from '@/config'
import { todayISO, CANVAS_PALETTE, avatarInk } from '@/utils/format'
import type { CityPassport, CityStatus, CityGuide } from '@/types'
import markerVisited from '@/assets/marker-visited.png'
import markerWish from '@/assets/marker-wish.png'
import AppNav from '@/components/AppNav.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppSheet from '@/components/AppSheet.vue'
import AppTabBar from '@/components/AppTabBar.vue'

const city = useCityStore()

/* 地图 marker 与下方图例点的颜色。
   ⚠️ 不能用 CSS 变量：微信原生 `<map>` 的 `marker.label.bgColor` 是把值透传给原生渲染层的，
   那里解析不了 `var()`。所以取 `CANVAS_PALETTE` 里的字面值 —— 它是 theme.css 的唯一镜像。
   这么写同时修掉两处不一致：
     · 原值 `#1D9E75` 与品牌绿 `#1FA470` 差一点点，屏幕上就是「同一个绿有两块色差」；
     · 「想去」在地图/图例上是 `#D85A30`(橙红)，在标签上却是 `--warn`(琥珀) —— 同一语义两个色。 */
const VISITED_COLOR = CANVAS_PALETTE.brand
const WISH_COLOR = CANVAS_PALETTE.warn

const tab = ref<'visited' | 'wish'>('visited')
const showAdd = ref(false)
const showDetail = ref(false)
const showRemove = ref(false)

const addName = ref('')
const detailId = ref('')

// 详情表单（打开时从护照拷贝，保存时写回）
const form = ref({
  status: 'visited' as CityStatus,
  visitDate: '',
  guide: '',
  review: '',
  rating: 0,
  wishNote: ''
})

const list = computed(() => (tab.value === 'visited' ? city.visited : city.wish))

// 发布昵称（双向绑定到 store）
const nick = computed<string>({
  get: () => city.nickname,
  set: (v) => city.setNick(v)
})

// 当前打开城市的共享攻略（来自后端，多人可见）
const sharedList = computed<CityGuide[]>(() => {
  const target = city.all.find((x) => x.id === detailId.value)
  if (!target) return []
  return city.sharedOf(target.name)
})
const othersVisited = computed(() =>
  sharedList.value.filter((g) => g.status === 'visited' && g.author !== city.nickname)
)
const othersWish = computed(() =>
  sharedList.value.filter((g) => g.status === 'wish' && g.author !== city.nickname)
)

const center = computed(() => {
  const valid = city.all.filter((p) => p.lat && p.lng)
  if (valid.length) {
    const lat = valid.reduce((s, p) => s + p.lat, 0) / valid.length
    const lng = valid.reduce((s, p) => s + p.lng, 0) / valid.length
    return { latitude: lat, longitude: lng }
  }
  // 默认中国中心
  return { latitude: 34.0, longitude: 108.0 }
})

const markers = computed(() => {
  const valid = city.all.filter((p) => p.lat && p.lng)
  return valid.map((p, i) => {
    const pin = p.status === 'visited' ? VISITED_COLOR : WISH_COLOR
    return {
      id: i,
      latitude: p.lat,
      longitude: p.lng,
      width: 24,
      height: 24,
      iconPath: p.status === 'visited' ? markerVisited : markerWish,
      callout: {
        content: p.name,
        /* 12px 的城市名要过 AA 4.5:1。原来写死白字：压 --brand(#1FA470) 只有 3.18:1、
           压 --warn(#C77E1A) 3.27:1 —— 都不过，而这是**内容文字**不是图标。
           底色不能动（`bgColor` 必须和 marker 图标同色，见上方注释），所以按底色取墨色：
           两个底色的明度都过了黑白的交叉点（Y ≥ 0.1791），`avatarInk` 会给出黑字
           —— 实测 6.60:1 / 6.43:1。这是 H5 端看不见的路径（H5 用白面板地图），
           只能真机/小程序端肉眼确认，所以更不该靠猜。 */
        color: avatarInk(pin),
        fontSize: 12,
        bgColor: pin,
        padding: 8,
        borderRadius: 8,
        display: 'ALWAYS' as const,
        textAlign: 'center' as const
      }
    }
  })
})

function passportByMarkerId(id: number): CityPassport | undefined {
  return city.all.filter((p) => p.lat && p.lng)[id]
}

function onMarkerTap(e: { detail: { markerId: number } }) {
  const p = passportByMarkerId(e.detail.markerId)
  if (p) openDetail(p.id)
}

function submitAdd() {
  const name = addName.value.trim()
  if (!name) {
    uni.showToast({ title: '请输入城市名', icon: 'none' })
    return
  }
  city.markCity(name, tab.value === 'visited' ? 'visited' : 'wish')
  addName.value = ''
  showAdd.value = false
  uni.showToast({ title: `已标记「${name}」`, icon: 'success' })
}

function openDetail(id: string) {
  const target = city.all.find((x) => x.id === id)
  if (!target) return
  detailId.value = id
  form.value = {
    status: target.status,
    visitDate: target.visitDate || '',
    guide: target.guide || '',
    review: target.review || '',
    rating: target.rating || 0,
    wishNote: target.wishNote || ''
  }
  void city.loadShared(target.name)
  showDetail.value = true
}

function setStatus(status: CityStatus) {
  form.value.status = status
}

function setRating(n: number) {
  form.value.rating = n
}

function onVisitDate(e: { detail: { value: string } }) {
  form.value.visitDate = e.detail.value
}

async function saveDetail() {
  const target = city.all.find((x) => x.id === detailId.value)
  if (!target) return
  // setStatus / saveGuide 内部已自动发布到后端（fire-and-forget），页面只管提示
  if (form.value.status !== target.status) city.setStatus(target.name, form.value.status)
  city.saveGuide(target.name, {
    guide: form.value.guide,
    review: form.value.review,
    rating: form.value.rating,
    visitDate: form.value.visitDate,
    wishNote: form.value.wishNote
  })
  uni.showToast({ title: BACKEND_ENABLED ? '已保存并发布' : '已保存', icon: 'success' })
  showDetail.value = false
}

async function confirmRemove() {
  const target = city.all.find((x) => x.id === detailId.value)
  if (!target) return
  const name = target.name
  // removeCity 内部已同步撤回后端上我发布的攻略（按 openid / 作者名）
  city.removeCity(name)
  showDetail.value = false
  showRemove.value = false
}

watch(
  () => city.all,
  (list) => {
    // 补全缺失坐标（表内没有的城市走高德地理编码）
    list.forEach((p) => {
      if (!p.lat || !p.lng) city.ensureCoords(p)
    })
  },
  { immediate: true }
)

onLoad(() => {
  city.load()
})
</script>

<template>
  <div class="page">
    <AppNav title="城市足迹" subtitle="标注去过的与想去的" back border />

    <!-- 去过 / 想去 是一个二选一筛选，正是分段控件的用例；
         右边「添加城市」用 tinted 按钮，不再抢主视觉。 -->
    <div class="top">
      <div class="seg tab-seg">
        <button class="seg-item" :class="{ active: tab === 'visited' }" @click="tab = 'visited'">
          去过 {{ city.countVisited }}
        </button>
        <button class="seg-item" :class="{ active: tab === 'wish' }" @click="tab = 'wish'">
          想去 {{ city.countWish }}
        </button>
      </div>
      <button class="btn-tint add-btn" @click="showAdd = true">
        <AppIcon name="plus" :size="15" />
        添加
      </button>
    </div>

    <!-- 地图 -->
    <div class="map-wrap">
      <map
        class="map"
        :latitude="center.latitude"
        :longitude="center.longitude"
        :scale="tab === 'visited' ? 4 : 4"
        :markers="markers"
        :show-location="false"
        @markertap="onMarkerTap"
      />
      <div v-if="!city.countVisited && !city.countWish" class="map-hint">
        <AppIcon name="map" :size="32" color="var(--text-tertiary)" />
        <p>地图还是空的</p>
        <span>点上面「添加」，标记你的第一座足迹</span>
      </div>
      <p v-if="!AMAP_ENABLED" class="map-tip">未配置高德 key，仅显示预设城市坐标</p>
    </div>

    <!-- 列表 -->
    <div class="page-body">
      <div class="sec-title">
        <h2>{{ tab === 'visited' ? '去过的城市' : '想去的清单' }}</h2>
        <span class="sec-hint">{{ list.length }} 座</span>
      </div>
    </div>

    <div class="page-body">
      <div v-if="list.length" class="list">
        <template v-for="(p, i) in list" :key="p.id">
          <div v-if="i" class="list-sep indent-dot" />
          <button class="city-row" @click="openDetail(p.id)">
            <span
              class="dot"
              :style="{ background: p.status === 'visited' ? VISITED_COLOR : WISH_COLOR }"
            />
            <span class="cc-main">
              <span class="cc-name">{{ p.name }}</span>
              <span v-if="p.guide || p.review" class="cc-sub ellipsis">
                {{ p.guide || p.review }}
              </span>
              <span v-else class="cc-sub muted">{{ p.status === 'visited' ? '去过了，写点攻略吧' : '种草中，写下想去理由' }}</span>
            </span>
            <span class="cc-right">
              <span v-if="p.rating" class="stars">{{ '★'.repeat(p.rating) }}</span>
              <AppIcon name="right" :size="15" color="var(--text-tertiary)" />
            </span>
          </button>
        </template>
      </div>
      <div v-else class="list empty">
        <p>{{ tab === 'visited' ? '还没有标记去过的城市' : '清单是空的，先加几个目的地' }}</p>
      </div>
    </div>

    <!-- 添加城市 -->
    <AppSheet v-model="showAdd" title="添加城市">
      <div class="form">
        <label class="field-label">城市名称</label>
        <input
          v-model="addName"
          class="text-input"
          placeholder="如：成都 / 大理 / 东京"
          confirm-type="done"
          @confirm="submitAdd"
        />
        <label class="field-label">标记为</label>
        <div class="seg">
          <button class="seg-item" :class="{ active: tab === 'visited' }" @click="tab = 'visited'">
            去过
          </button>
          <button class="seg-item" :class="{ active: tab === 'wish' }" @click="tab = 'wish'">
            想去
          </button>
        </div>
      </div>
      <template #footer>
        <button class="primary-btn" @click="submitAdd">添加</button>
      </template>
    </AppSheet>

    <!-- 城市详情 / 编辑 -->
    <AppSheet v-model="showDetail" :title="city.byName(city.all.find((x) => x.id === detailId)?.name || '')?.name || '城市'" max-height="82vh">
      <div class="form">
        <label class="field-label">状态</label>
        <div class="seg">
          <button class="seg-item" :class="{ active: form.status === 'visited' }" @click="setStatus('visited')">
            去过
          </button>
          <button class="seg-item" :class="{ active: form.status === 'wish' }" @click="setStatus('wish')">
            想去
          </button>
        </div>

        <template v-if="form.status === 'visited'">
          <label class="field-label">到访日期</label>
          <picker mode="date" :value="form.visitDate || todayISO()" @change="onVisitDate">
            <view class="picker-box">
              {{ form.visitDate || '选择到访日期' }}
              <AppIcon name="calendar" :size="16" color="var(--text-tertiary)" />
            </view>
          </picker>

          <label class="field-label">我的评分</label>
          <div class="rate">
            <button
              v-for="n in 5"
              :key="n"
              class="star"
              :class="{ lit: n <= form.rating }"
              @click="setRating(n)"
            >
              ★
            </button>
            <span class="rate-val">{{ form.rating ? `${form.rating}.0` : '未评' }}</span>
          </div>

          <label class="field-label">攻略</label>
          <textarea v-model="form.guide" class="text-area" placeholder="必吃、必玩、避坑、路线……写给以后想来的自己" />

          <label class="field-label">评价</label>
          <textarea v-model="form.review" class="text-area" placeholder="整体感受、值不值得、适合谁" />
        </template>

        <template v-else>
          <label class="field-label">想去理由</label>
          <textarea v-model="form.wishNote" class="text-area" placeholder="为什么想去？最想打卡的是什么？" />
          <p class="tip">标记去过之后，就能在这里写攻略和评价，给「想去」的自己参考。</p>
        </template>

        <!-- 共享攻略（来自后端，多人可见） -->
        <div v-if="BACKEND_ENABLED" class="shared">
          <label class="field-label">以 <input v-model="nick" class="nick-input" placeholder="昵称" maxlength="12" /> 的身份发布</label>

          <template v-if="othersVisited.length">
            <div class="shared-title">
              <AppIcon name="users" :size="14" color="var(--brand-deep)" />
              去过的人写的攻略 · {{ othersVisited.length }}
            </div>
            <div v-for="g in othersVisited" :key="g.id" class="shared-card">
              <div class="sc-head">
                <span class="sc-author">{{ g.author }}</span>
                <span v-if="g.rating" class="stars">{{ '★'.repeat(g.rating) }}</span>
              </div>
              <p v-if="g.guide" class="sc-text">{{ g.guide }}</p>
              <p v-if="g.review" class="sc-text review">{{ g.review }}</p>
              <span v-if="g.visitDate" class="sc-date">到访 {{ g.visitDate }}</span>
            </div>
          </template>

          <template v-if="othersWish.length">
            <div class="shared-title">
              <AppIcon name="users" :size="14" color="var(--danger)" />
              也想去的人 · {{ othersWish.length }}
            </div>
            <div v-for="g in othersWish" :key="g.id" class="shared-card">
              <div class="sc-head"><span class="sc-author">{{ g.author }}</span></div>
              <p v-if="g.wishNote" class="sc-text">{{ g.wishNote }}</p>
            </div>
          </template>

          <p
            v-if="!othersVisited.length && !othersWish.length"
            class="tip"
          >还没有其他人分享这座城市的攻略。你写的攻略发布后，想去的人就能在这里看到。</p>
        </div>
      </div>
      <template #footer>
        <div class="foot-row">
          <button class="ghost-btn danger" @click="showRemove = true">删除</button>
          <button class="primary-btn" @click="saveDetail">保存</button>
        </div>
      </template>
    </AppSheet>

    <!-- 删除确认 -->
    <AppSheet v-model="showRemove" title="删除这座城市？">
      <p class="tip">攻略、评价都会一起清空，且无法恢复。</p>
      <template #footer>
        <div class="foot-row">
          <button class="ghost-btn" @click="showRemove = false">取消</button>
          <button class="primary-btn danger" @click="confirmRemove">删除</button>
        </div>
      </template>
    </AppSheet>

    <AppTabBar current="city-map" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-page);
  display: flex;
  flex-direction: column;
}

.top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}

.tab-seg {
  flex: 1;
  min-width: 0;
}

.add-btn {
  flex-shrink: 0;
}

.map-wrap {
  position: relative;
  height: 40vh;
  margin: 2px 16px 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  /* 白底：地图是「内容区」，空的时候也应该是一块看得见的白面板，
     而不是一个和页面底色融在一起、什么都看不出来的大坑。 */
  background: var(--bg-card);
}

.map {
  width: 100%;
  height: 100%;
}

.map-hint {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  color: var(--text-tertiary);
  text-align: center;
  padding: 0 30px;
}

.map-hint p {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-top: 4px;
}

.map-hint span {
  font-size: 12px;
  color: var(--text-tertiary);
}

.map-tip {
  position: absolute;
  left: 8px;
  bottom: 8px;
  font-size: 10px;
  color: var(--text-tertiary);
  background: rgba(255, 255, 255, 0.8);
  padding: 2px 8px;
  border-radius: 8px;
}

.city-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  transition: background 0.12s ease;
}

.city-row:active {
  background: var(--bg-subtle);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.list-sep.indent-dot {
  margin-left: 37px;
}

.cc-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cc-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.cc-sub {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 100%;
}

.cc-sub.muted {
  color: var(--text-tertiary);
}

.cc-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.stars {
  /* ★ 是文字字形（不是 SVG），所以走「浅底上的字用 -deep」这条规则：3.27 → 5.77:1 */
  color: var(--warn-deep);
  font-size: 12px;
  letter-spacing: 1px;
}

.empty {
  text-align: center;
  padding: 30px 0;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* 共享攻略 */
.shared {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--hairline-strong);
}

.nick-input {
  display: inline-block;
  width: 92px;
  padding: 2px 8px;
  background: var(--bg-sunken);
  border: none;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-primary);
  text-align: center;
}

.shared-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 2px;
}

.shared-card {
  background: var(--bg-subtle);
  border: none;
  border-radius: var(--radius-md);
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sc-author {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.sc-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.sc-text.review {
  color: var(--text-tertiary);
}

.sc-date {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* 表单容器。`.field-label` 由 global.css 提供，这里不再重复定义。 */
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 6px;
}

/* 空列表：仍然是一张白卡，只是内容居中的一句灰字 */
.empty {
  text-align: center;
  padding: 30px 20px;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* 表单：iOS 的输入控件是「浅灰圆角块」，没有描边 ——
   描边叠在灰底上只会让每一格看起来都像一个需要填的框。 */
.text-input,
.text-area,
.picker-box {
  width: 100%;
  background: var(--bg-sunken);
  border: none;
  border-radius: var(--radius-md);
  padding: 12px 13px;
  font-size: 15px;
  color: var(--text-primary);
  line-height: 1.5;
}

.text-area {
  height: 92px;
}

.picker-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-primary);
}

/* `.seg` / `.seg-item` 已由 global.css 提供（凹槽 + 白色滑块），
   这里不再覆写 —— 之前本地那份是「两个灰按钮 + 绿色描边选中」，
   和小程序里其他分段的观感不一致。 */

.rate {
  display: flex;
  align-items: center;
  gap: 4px;
}

.star {
  font-size: 26px;
  line-height: 1;
  /* 未选中态。原来写的是 `--line-strong`(#D1D1D6) —— 那是**分隔线**的颜色，
     而 ★ 是**字形**（和 `.stars` 里那几个一样），压白卡只有 1.52:1，
     等于把「这里有 5 颗星可以点」这件事藏起来。
     改成 tertiary（2.73:1）：和旁边 `.rate-val`、右侧箭头同级，
     仍然一眼是「空的」，与 -deep 的琥珀色拉得开。
     它到不了 1.4.11 的 3:1 —— 这和 tab 未选中态是同一类有意取舍：
     信息不靠这一颗星单独承载（右边就是「未评 / 3.0」）。 */
  color: var(--text-tertiary);
  transition: color 0.12s ease, transform 0.12s ease;
}

.star.lit {
  /* 同上；它同时是个可点控件（WCAG 1.4.11 要 3:1），-deep 一并解决 */
  color: var(--warn-deep);
}

.star:active {
  transform: scale(0.92);
}

.rate-val {
  margin-left: 8px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.tip {
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.5;
  margin-top: 4px;
}

.foot-row {
  display: flex;
  gap: 10px;
}

.primary-btn {
  flex: 1;
  height: 48px;
  border-radius: 12px;
  background: var(--brand);
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}

.primary-btn.danger {
  background: var(--danger);
}

.ghost-btn {
  flex: 1;
  height: 48px;
  border-radius: 12px;
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: 16px;
}

.ghost-btn.danger {
  color: var(--danger);
}
</style>
