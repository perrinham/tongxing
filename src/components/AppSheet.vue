<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    modelValue: boolean
    title?: string
    /** 内容区最大高度，超出滚动 */
    maxHeight?: string
  }>(),
  { title: '', maxHeight: '78vh' }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <!--
    ── 为什么是「backdrop + sheet 兄弟节点」而不是「遮罩上判 target」──

    遮罩整块 + 点击判定的方案在小程序端全是坑（自动化实测复现过三种死法）：
    1. `@click.self` 编译到小程序时被**静默丢弃**（产物里没有 withModifiers），
       等效裸 @click —— 点弹层内任何元素都关弹层；
    2. 模拟器 / 非同层渲染下 `<input>` 等原生组件**不参与 WebView 命中测试**，
       点输入框的 tap 会「穿透」到遮罩本尊（target 就是遮罩、还带着遮罩的
       dataset）—— 按 target 判定照样误关，且与真·背景点击在事件层面无法区分；
    3. uni-app 包装后的事件**没有 changedTouches / clientY**（连 detail.y 都没有），
       按 y 坐标判「点在弹层上方」也不可行。

    拆成兄弟节点后问题在结构上消失：backdrop（flex:1）只覆盖 sheet 上方的区域，
    两者不重叠 —— 点弹层内任何东西（含原生穿透）都到不了 backdrop 的 handler。
  -->
  <!-- ⚠️ 刻意不用 <Transition>：小程序端 transition 靠 JS 切类，任何 setData
       重渲染都会把过渡类重置回 enter-from（opacity:0）→ 弹层隐身。
       纯 CSS animation 插入时自动播放、重渲染不重播，两端一致。 -->
  <!-- ⚠️ 不用 `inset: 0`：WXSS 编译器丢弃该简写 → 容器失去定位尺寸。 -->
  <div v-if="modelValue" class="wrap">
    <div class="backdrop" @click="close" />
    <div class="sheet" :style="{ maxHeight }">
      <div v-if="title" class="sheet-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="close">
          <AppIcon name="close" :size="20" />
        </button>
      </div>
      <div class="sheet-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="sheet-foot">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  animation: mask-in 0.18s ease-out;
}

.backdrop {
  flex: 1;
  /* iOS 遮罩更黑更透 */
  background: rgba(0, 0, 0, 0.35);
}

.sheet {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border-radius: 20px 20px 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: var(--safe-bottom);
  animation: sheet-up 0.26s cubic-bezier(0.25, 1, 0.5, 1);
}

/* iOS 抓手：居中短横条 */
.grabber {
  flex-shrink: 0;
  width: 36px;
  height: 5px;
  border-radius: 3px;
  background: var(--line-strong);
  margin: 8px auto 0;
}

@keyframes mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes sheet-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 8px;
  flex-shrink: 0;
}

.sheet-head h3 {
  font-size: 17px;
  font-weight: 600;
}

.close-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg-subtle);
  /* 里面是 SVG 的 ×，属图形，1.4.11 要 3:1 —— 而 tertiary 压 bg-subtle 只有 2.25:1，
     连图形线都不过。--text-secondary 压它是 4.69:1。 */
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-body {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 16px 8px;
  flex: 1;
}

.sheet-foot {
  padding: 12px 16px 16px;
  flex-shrink: 0;
  background: var(--bg-card);
  border-top: 0.5px solid var(--hairline);
}
</style>
