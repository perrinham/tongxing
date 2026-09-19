<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { nav } from '@/utils/nav'

withDefaults(
  defineProps<{
    /** 大标题 */
    title: string
    /** 副标题 */
    subtitle?: string
    /** 是否显示返回按钮 */
    back?: boolean
    /** 是否显示返回首屏（欢迎页）的 home 键 */
    home?: boolean
    /** 右上角插槽名是否启用 */
    border?: boolean
  }>(),
  { subtitle: '', back: false, home: false, border: false }
)

function goBack() {
  nav.back()
}

function goHome() {
  nav.reLaunch('welcome')
}
</script>

<template>
  <header class="navbar" :class="{ 'has-border': border }">
    <div class="nav-left">
      <button v-if="back" class="nav-icon" @click="goBack">
        <AppIcon name="left" :size="22" />
      </button>
      <button v-else-if="home" class="nav-icon" @click="goHome" title="回到首页">
        <AppIcon name="home" :size="21" />
      </button>
      <slot name="left" />
    </div>

    <div class="nav-center">
      <h1>{{ title }}</h1>
      <p v-if="subtitle" class="nav-sub">{{ subtitle }}</p>
    </div>

    <div class="nav-right">
      <slot name="right" />
    </div>
  </header>
</template>

<style scoped>
.navbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--navbar-h);
  padding: calc(var(--safe-top) + 10px) 12px 10px;
  /* iOS 导航栏：半透明系统灰 + 高斯模糊 */
  background: rgba(242, 242, 247, 0.86);
  backdrop-filter: saturate(1.8) blur(20px);
  -webkit-backdrop-filter: saturate(1.8) blur(20px);
}

.navbar.has-border {
  border-bottom: 0.5px solid var(--hairline-strong);
}

.nav-left,
.nav-right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 44px;
}

.nav-right {
  justify-content: flex-end;
}

.nav-center {
  flex: 1;
  min-width: 0;
  text-align: center;
}

.nav-center h1 {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* iOS 导航键：裸图标，无底、无描边、无投影 */
.nav-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand);
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.nav-icon:active {
  opacity: 0.45;
  transform: scale(0.94);
}
</style>
