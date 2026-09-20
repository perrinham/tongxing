<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { nav } from '@/utils/nav'

defineProps<{ current: string }>()

const tabs = [
  { key: 'itinerary', label: '行程', icon: 'map' },
  { key: 'expense', label: '记账', icon: 'wallet' },
  { key: 'settle', label: '结算', icon: 'scale' },
  { key: 'city-map', label: '足迹', icon: 'pin' },
  { key: 'discover', label: '发现', icon: 'sparkle' },
  { key: 'profile', label: '我的', icon: 'user' }
]
</script>

<template>
  <nav class="tabbar">
    <button
      v-for="t in tabs"
      :key="t.key"
      class="tab"
      :class="{ active: current === t.key }"
      @click="nav.reLaunch(t.key)"
    >
      <span class="tab-icon">
        <AppIcon :name="t.icon" :size="22" :stroke="current === t.key ? 2.1 : 1.7" />
      </span>
      <span class="tab-label">{{ t.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 100%;
  max-width: 480px;
  height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  /* iOS tab bar：半透明白 + 毛玻璃 + 发丝线，无投影 */
  background: rgba(249, 249, 249, 0.85);
  backdrop-filter: saturate(1.8) blur(20px);
  -webkit-backdrop-filter: saturate(1.8) blur(20px);
  border-top: 0.5px solid var(--hairline-strong);
  display: flex;
  align-items: stretch;
  z-index: 30;
}

.tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding-top: 6px;
  color: var(--text-tertiary);
  transition: color 0.2s ease;
}

.tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
}

.tab-icon :deep(.icon) {
  display: block;
  flex-shrink: 0;
}

.tab-label {
  font-size: 10px;
  line-height: 1;
  font-weight: 500;
}

.tab.active {
  /* 选中态是 10px 小字 + 图标：基色 #1FA470 压毛玻璃底只有 3.18:1（iOS systemBlue
     也只有 3.6:1），压深到 brand-deep 后是 5.37:1，图标同时受益。
     未选中态**故意**保持 --text-tertiary：若提到 secondary，它的明度会和 brand-deep
     撞在一起，选中/未选中就只剩色相可辨 —— 见 theme.css 里那段推算。 */
  color: var(--brand-deep);
}

.tab:active .tab-icon {
  transform: scale(0.94);
}
</style>
