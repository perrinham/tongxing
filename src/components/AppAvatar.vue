<script setup lang="ts">
import { computed } from 'vue'
import { avatarColor, avatarInk } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    name: string
    colorIndex?: number
    size?: number
    ring?: boolean
  }>(),
  { colorIndex: 0, size: 32, ring: false }
)

const initial = computed(() => {
  const n = (props.name || '?').trim()
  if (!n) return '?'
  // 中文取末字（更像姓名识别），英文取首字母
  return /[\u4e00-\u9fa5]/.test(n) ? n.slice(-1) : n.slice(0, 1).toUpperCase()
})

const bg = computed(() => avatarColor(props.colorIndex))
/** 初始字颜色按底色亮度取（白/黑取对比度更高者），保证 13px 小字也过 AA —— 见 avatarInk 注释 */
const ink = computed(() => avatarInk(bg.value))
const fontSize = computed(() => Math.max(11, Math.round(props.size * 0.42)))
</script>

<template>
  <span
    class="avatar"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      background: bg,
      color: ink,
      fontSize: `${fontSize}px`,
      boxShadow: ring ? '0 0 0 2px var(--bg-card)' : 'none'
    }"
  >
    {{ initial }}
  </span>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  /* color 由 avatarInk(底色) 内联决定，不在这里写死 —— 写死白色会让 7/10 个头像的初始字低于 AA */
  font-weight: 500;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: 0;
}
</style>
