<script setup lang="ts">
import { ref, watch, nextTick, getCurrentInstance, onUnmounted } from 'vue'
import { drawPoster, posterHeight, posterWidth, type PosterData } from '@/utils/poster'
import type { ReplayPosterData } from '@/utils/replay'

/**
 * 泛化的海报画布：默认画结算海报（utils/poster）；
 * 传入 draw/heightOf 就换成别的海报（行程回放 = utils/replay），复用全套
 * 画布就绪/双端语义/导出保存管道 —— 但绘制样式本身各写各的。
 */
const props = defineProps<{
  data: PosterData | ReplayPosterData | null
  /** 自定义画笔 (ctx, cssW, H, data)；缺省 = 结算海报的 drawPoster */
  draw?: (ctx: CanvasRenderingContext2D | any, cssW: number, H: number, data: any) => void
  /** 自定义测高 (data) => H；缺省 = 结算海报的 posterHeight */
  heightOf?: (data: any) => number
}>()
const emit = defineEmits<{ (e: 'saved', text?: string): void; (e: 'error', msg: string): void }>()

const canvasId = 'posterCanvas'
const cssW = posterWidth()
const sys = uni.getSystemInfoSync()
/** 展示尺寸：画布的后备存储由平台决定，这里只管 CSS 盒子的大小 */
const displayW = ref(Math.min(cssW, Math.max(280, (sys.windowWidth || 375) - 32)))
const displayH = ref(420)

/**
 * H5 与小程序的 canvas 语义差别很大，两条路径分开走 —— 原因见 renderH5 / renderMp
 * 上方注释。小程序端没有 document，用它当运行时判据最省事。
 */
const isH5 = typeof document !== 'undefined'

let rendering = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** 节点查询的最大等待：弹层有入场动画，首次挂载时机可能偏晚 */
const RETRY_MS = 120
const MAX_ATTEMPTS = 10

// 组件实例要在 setup 顶层同步取（运行期调 getCurrentInstance() 会拿到 null）
const instance = getCurrentInstance()

function clearTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 等 n 个「渲染节拍」再继续。用 setTimeout 而不是 rAF：页面在后台时 rAF 会被完全暂停 */
function waitTicks(n: number, cb: () => void) {
  if (n <= 0) return cb()
  retryTimer = setTimeout(() => waitTicks(n - 1, cb), 24)
}

/**
 * 组件作用域的节点查询。
 *
 * ⚠️ 小程序端 `createSelectorQuery()` 默认只查**页面范围**的节点，查不进
 * 自定义组件内部（微信文档：「初始时，选择器仅选取页面范围的节点」）。
 * canvas 在本组件里，不带 `.in(组件实例)` 在 mp-weixin 端永远查空 ——
 * 表现就是海报一片空白、保存报「海报尚未就绪」。H5 端 DOM 全局可查，所以那边不炸。
 */
function scopedQuery() {
  const q = uni.createSelectorQuery() as any
  const comp = (instance as any)?.proxy ?? instance
  if (comp && typeof q.in === 'function') q.in(comp)
  return q
}

function rootEl(): HTMLElement | null {
  const root = (instance as any)?.proxy?.$el
  return root && root.nodeType === 1 ? (root as HTMLElement) : null
}

/** H5 端拿到真实 DOM canvas（后备存储的持有者）。小程序端返回 null。 */
function realDomCanvas(): HTMLCanvasElement | null {
  if (!isH5) return null
  const root = rootEl()
  return root ? (root.querySelector('canvas') as HTMLCanvasElement | null) : null
}

/**
 * 把海报画进上下文：先按目标尺寸设好变换，再交给 drawPoster。
 * 用 `setTransform`（绝对赋值）而不是 `scale` —— `scale` 是**累乘**的，
 * 一旦某次尺寸赋值没生效，变换矩阵不会被重置，反复渲染就会越缩越小。
 */
function paint(ctx: any, sx: number, sy: number, H: number, data: any) {
  const paintFn = props.draw || drawPoster
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(sx, 0, 0, sy, 0, 0)
  } else {
    if (typeof ctx.resetTransform === 'function') ctx.resetTransform()
    ctx.scale(sx, sy)
  }
  paintFn(ctx, cssW, H, data)
}

/**
 * ── 小程序端 ────────────────────────────────────────────────────────
 * `type="2d"` 拿到的就是真画布对象，宽高完全由我们控制：设成 逻辑尺寸 × dpr，
 * 再按同样的比例设变换，导出时是全分辨率。官方用法，没有额外干扰。
 */
function renderMp(H: number, data: any, attempt: number) {
  scopedQuery()
    .select('#' + canvasId)
    .fields({ node: true, size: true })
    .exec((res: any[]) => {
      const info = res && res[0]
      if (!info || !info.node) {
        // 节点还没就绪（弹层动画 / 首次挂载时机）：短重试，而不是静默放弃留一张空白海报
        if (attempt < MAX_ATTEMPTS) {
          retryTimer = setTimeout(() => render(attempt + 1), RETRY_MS)
          return
        }
        rendering = false
        emit('error', '海报渲染失败，请重试')
        return
      }
      const canvas = info.node
      const ctx = canvas.getContext('2d')
      const dpr = (uni.getSystemInfoSync().pixelRatio as number) || 2
      canvas.width = cssW * dpr
      canvas.height = H * dpr
      paint(ctx, dpr, dpr, H, data)
      rendering = false
    })
}

/**
 * ── H5 端 ──────────────────────────────────────────────────────────
 * uni 的 `<canvas>` 在 H5 上不是一块「随便设尺寸」的画布：外壳里挂着 ResizeSensor，
 * 布局一变就调 uni-h5 内部的 `wrapper()`：
 *
 *     canvas.width  = canvas.offsetWidth  * pixelRatio
 *     canvas.height = canvas.offsetHeight * pixelRatio
 *     ctx.__hidpi__ = true
 *
 * 它会**覆盖**我们写进去的后备存储尺寸（顺带清空画布）；而打了 `__hidpi__` 之后，
 * uni 在 pixelRatio ≠ 1 时又把 ctx 的绘制方法包了一层、把所有坐标内部乘一次
 * pixelRatio —— 换句话说：**H5 端要在 CSS 像素空间作画**。
 *
 * 之前踩的坑：先自己写 `canvas.width = 750`，紧接着读回也是 750，于是算出
 * scale = 1 并按 750 的宽度画下去；下一帧 ResizeSensor 把后备存储改回 313
 * （实测值），右边约 40% 就这么没了 —— 不报错，只是图不对，最难查的一类。
 *
 * 现在的策略：
 *   ① 先量 .poster-wrap 的可用宽度来定 displayW/displayH，保证画布的
 *      **CSS 盒子比例 = 海报比例**。不量的话 flex 会把宽度收缩（实测 328 → 313），
 *      比例一歪，画面就被纵向拉伸；
 *   ② 等两拍，让 ResizeSensor 按新尺寸把后备存储重置完；
 *   ③ 按 CSS 盒子的实际尺寸推导缩放，在 CSS 像素空间作画；
 *   ④ 下一拍再验一次尺寸，若 ResizeSensor 又动过，按新尺寸重画一遍。
 * 全程**不写** canvas.width/height —— 在 H5 上那是 uni 的地盘。
 */
function renderH5(H: number, data: any, attempt: number) {
  const canvas = realDomCanvas()
  const root = rootEl()
  const avail = root ? root.clientWidth : 0

  // 盒子还没量到（弹层尚未插入 / 宽度为 0）：再等一拍，别带着错的尺寸画下去
  if (!canvas || avail < 200) {
    if (attempt < MAX_ATTEMPTS) {
      retryTimer = setTimeout(() => render(attempt + 1), RETRY_MS)
      return
    }
    if (!canvas) {
      rendering = false
      emit('error', '海报渲染失败，请重试')
      return
    }
  }

  // ① 按可用宽度定显示尺寸（画布比例必须等于海报比例）
  if (avail >= 200) {
    const w = Math.min(cssW, Math.floor(avail))
    if (Math.abs(w - displayW.value) > 0.5) displayW.value = w
    displayH.value = Math.round((H * w) / cssW)
  }

  // ② 等布局 + ResizeSensor 定稿
  waitTicks(2, () => {
    const dom = realDomCanvas()
    if (!dom || !props.data) {
      rendering = false
      return
    }
    const ctx = dom.getContext('2d')
    const boxW = dom.offsetWidth || displayW.value
    const boxH = dom.offsetHeight || displayH.value
    paint(ctx, boxW / cssW, boxH / H, H, data)
    const bw = dom.width
    const bh = dom.height
    rendering = false

    // ④ 自检：尺寸又被改过就重画一次（最多一次，不会来回抖）
    waitTicks(1, () => {
      if (dom.isConnected && (dom.width !== bw || dom.height !== bh)) {
        const ctx2 = dom.getContext('2d')
        paint(ctx2, (dom.offsetWidth || displayW.value) / cssW, (dom.offsetHeight || displayH.value) / H, H, data)
      }
    })
  })
}

function render(attempt = 0) {
  if (!props.data) return
  if (attempt === 0) {
    if (rendering) return
    rendering = true
    clearTimer()
  }
  const data = props.data
  const H = (props.heightOf || ((d: any) => posterHeight(d as PosterData)))(data)
  displayH.value = Math.round((H * displayW.value) / cssW)

  nextTick(() => {
    if (isH5) renderH5(H, data, attempt)
    else renderMp(H, data, attempt)
  })
}

/**
 * H5 的「保存」。
 *
 * uni 的 `saveImageToPhotosAlbum` 在 H5 上是**未实现**的 API（uni-h5 里它就是一个
 * createUnsupportedAsyncApi），调用必然失败 —— 所以浏览器端改为直接下载文件。
 * 而且不能拿屏幕上那块画布导出：H5 的后备存储只有 CSS 盒子那么大（约 313 × 703），
 * 于是这里按逻辑尺寸离屏重绘一份 2 倍图再下载。
 * 离屏 canvas 的上下文没有 `__hidpi__` 标记，不会吃到 uni 的坐标缩放。
 */
function downloadH5(data: any) {
  if (!isH5) return
  const H = (props.heightOf || ((d: any) => posterHeight(d as PosterData)))(data)
  const off = document.createElement('canvas')
  const R = 2
  off.width = cssW * R
  off.height = H * R
  const octx = off.getContext('2d')
  if (!octx) {
    emit('error', '生成图片失败')
    return
  }
  octx.setTransform(R, 0, 0, R, 0, 0)
  ;(props.draw || drawPoster)(octx, cssW, H, data)
  off.toBlob((blob) => {
    if (!blob) {
      emit('error', '生成图片失败')
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${props.draw ? '行程海报' : '结算海报'}-${data.destination || data.title || '行程'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    emit('saved', '海报已下载')
  }, 'image/png')
}

function save() {
  const data = props.data
  if (!data) return
  if (isH5) {
    downloadH5(data)
    return
  }
  scopedQuery()
    .select('#' + canvasId)
    .fields({ node: true })
    .exec((res: any[]) => {
      const info = res && res[0]
      if (!info || !info.node) {
        emit('error', '海报尚未就绪')
        return
      }
      // ⚠️ 不传 x/y/width/height：type-2d 画布的导出坐标系在文档里有歧义
      // （内部尺寸是 cssW*dpr，传逻辑像素会裁掉一部分）。缺省即整幅，两端语义一致；
      // destWidth/Height 定成 2 倍，保证导出清晰度。
      uni.canvasToTempFilePath({
        canvas: info.node,
        destWidth: cssW * 2,
        destHeight: (props.heightOf || ((d: any) => posterHeight(d as PosterData)))(data) * 2,
        success: (r: any) => {
          uni.saveImageToPhotosAlbum({
            filePath: r.tempFilePath,
            success: () => emit('saved'),
            fail: () => emit('error', '保存失败，请允许相册权限')
          })
        },
        fail: () => emit('error', '生成图片失败')
      } as any)
    })
}

watch(() => props.data, () => render(), { immediate: true })
onUnmounted(clearTimer)
defineExpose({ save })
</script>

<template>
  <div class="poster-wrap">
    <canvas
      :id="canvasId"
      type="2d"
      :style="{ width: displayW + 'px', height: displayH + 'px' }"
      class="poster-canvas"
    />
  </div>
</template>

<style scoped>
.poster-wrap {
  display: flex;
  justify-content: center;
  padding: 4px 0 12px;
}
.poster-canvas {
  border-radius: 12px;
  /* 中性黑投影（原来是 rgba(44,44,42,…) 的暖黑，属旧视觉残留） */
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  display: block;
}
</style>
