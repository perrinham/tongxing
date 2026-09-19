<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    icon?: string
    title: string
    desc?: string
    action?: string
  }>(),
  { icon: 'pin', desc: '', action: '' }
)

defineEmits<{ (e: 'action'): void }>()
</script>

<template>
  <!--
    iOS「内容不可用」的空态：图标 + 标题 + 说明 + 一个按钮，居中。

    刻意不画插画。之前这里是一张手绘路线图（山形 + 光晕 + 彩色噪点），
    问题不在于画得好不好，而在于它把「这一屏什么都没发生」变成了一件
    需要解读的事 —— 用户得先看懂那张图讲的是什么，才知道自己能做什么。
    iOS 的做法相反：图标只负责表示「这里本该有内容」，一句话讲清下一步，
    按钮直接给出出口。三样东西，零解读成本。
  -->
  <div class="empty">
    <div class="empty-glyph" aria-hidden="true">
      <AppIcon :name="icon" :size="30" color="var(--text-tertiary)" :stroke="1.4" />
    </div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="desc" class="empty-desc">{{ desc }}</p>
    <button v-if="action" class="btn-tint empty-btn" @click="$emit('action')">
      {{ action }}
    </button>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 52px 24px;
}

/* 一圈极淡的系统灰，只为给图标一个落点，不承载任何色彩语义 */
.empty-glyph {
  width: 66px;
  height: 66px;
  border-radius: 50%;
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-desc {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.5;
  max-width: 250px;
}

.empty-btn {
  margin-top: 20px;
}
</style>
