import { onScopeDispose, ref } from 'vue'

/**
 * 页面内轻提示（页面自己画的 toast DOM，走统一设计令牌，不是 uni.showToast 原生弹层）。
 *
 * 收口各页曾裸写的 `toast.value = msg; setTimeout(() => (toast.value = ''), 1800)`：
 * 裸写连点两次时旧定时器会把新提示提前清掉（后一条显示不满 1.8s）——
 * 这里先 clear 再 set，保证每条提示都完整展示。
 */
export function useToast(duration = 1800) {
  const toast = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null
  function toastShow(msg: string) {
    toast.value = msg
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => (toast.value = ''), duration)
  }
  // 页面在 toast 显示期间卸载时不再留悬挂回调（写入已卸载实例的 ref 虽无害，但不干净）
  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
  })
  return { toast, toastShow }
}
