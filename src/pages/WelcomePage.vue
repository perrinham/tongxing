<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '@/stores/trip'
import { nav } from '@/utils/nav'
import AppIcon from '@/components/AppIcon.vue'

const store = useTripStore()
const working = ref(false)

const features = [
  { icon: 'sparkle', title: '一句话出草稿', desc: '说清目的地和天数，自动按地理顺路排好每一天' },
  { icon: 'wallet', title: '两下记一笔', desc: '谁付的、为谁付，其余交给算法' },
  { icon: 'scale', title: '结算不吵架', desc: '自动算出谁欠谁，并把转账笔数压到最少' }
]

function startCreate() {
  nav.to('trip-create')
}

function startDemo() {
  if (working.value) return
  working.value = true
  store.createDemoTrip()
  working.value = false
  nav.replace('itinerary')
}
</script>

<template>
  <!--
    首屏按 iOS 的「欢迎 / 引导」版式来：一块平的底色，居中一个 App 图标，
    大标题 + 一句副标题，下面是一张分组卡列出三件事，底部两个按钮。

    去掉了几样东西，理由值得写下来：
    · 那幅山峦 + 太阳的 SVG：它是纯装饰，占了首屏三分之一的面积，
      却不承载任何信息；iOS 的引导页从不用插画来垫场。
    · 标题的品牌渐变字：一个字里同时出现两种绿，在大字号下会发虚发脏。
    · 「TRIP · SHARED · SETTLE」这行英文：它只是把下面三件事换个语言又说了一遍。
    · 卡片外描边和图标底的 inset 描边：iOS 的分层靠底色差，不靠线。
  -->
  <div class="welcome">
    <div class="hero">
      <div class="brand-mark rise rise-1">
        <AppIcon name="map" :size="34" color="#fff" :stroke="1.8" />
      </div>
      <h1 class="rise rise-2">同行</h1>
      <p class="tagline rise rise-2">把行程和账，都放在一个空间里</p>
    </div>

    <ul class="feats list rise rise-3">
      <template v-for="(f, i) in features" :key="f.title">
        <div v-if="i" class="list-sep" />
        <li class="feat-row">
          <span class="feat-icon">
            <AppIcon :name="f.icon" :size="18" color="var(--brand)" />
          </span>
          <div class="grow">
            <p class="feat-title">{{ f.title }}</p>
            <p class="feat-desc">{{ f.desc }}</p>
          </div>
        </li>
      </template>
    </ul>

    <div class="actions rise rise-4">
      <button class="btn-primary cta" @click="startCreate">创建我的行程</button>
      <button class="btn-ghost cta demo-btn" :disabled="working" @click="startDemo">
        先看一份示例行程
      </button>
    </div>

    <p class="foot">数据只存在这台设备上，不上传</p>
  </div>
</template>

<style scoped>
.welcome {
  min-height: 100vh;
  padding: calc(var(--safe-top) + 76px) 20px calc(var(--safe-bottom) + 28px);
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

/* iOS App 图标：squircle 近似（圆角 = 边长的 22.5%），纯色填充 */
.brand-mark {
  width: 78px;
  height: 78px;
  border-radius: 18px;
  background: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 22px;
}

.hero {
  text-align: center;
  margin-bottom: 34px;
}

/* iOS 大标题：34/700，字距接近 0（系统字体的负字距来自字形本身，不靠 letter-spacing 造） */
.hero h1 {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0;
  color: var(--text-primary);
}

.tagline {
  margin-top: 8px;
  font-size: 16px;
  color: var(--text-secondary);
}

.feats {
  display: flex;
  flex-direction: column;
}

.feat-row {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 13px 16px;
}

.feat-icon {
  width: 30px;
  height: 30px;
  /* iOS 设置页里行首图标是「小圆角方块」，不是正圆 —— 正圆看起来像头像 */
  border-radius: 8px;
  background: var(--brand-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.feat-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}

.feat-desc {
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.45;
  margin-top: 2px;
}

.actions {
  margin-top: auto;
  padding-top: 34px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ⚠️ 必须显式给宽度。
   `<button>` 是替换元素，在 flex 容器里**不会**被 align-items: stretch 拉满 ——
   它的宽度由内容决定，结果就是按钮缩成一小条、居中悬在页面中间。
   （这是历史遗留问题：旧版首屏的按钮也一直是内容宽度，只是当时背景有山形
   插图，视线被引到别处，不明显。） */
.cta {
  width: 100%;
}

.demo-btn {
  height: 48px;
  border-radius: 14px;
  font-size: 16px;
}

.demo-btn[disabled] {
  opacity: 0.55;
}

.foot {
  margin-top: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
