<script setup lang="ts">
import { onLaunch, onShow, onHide, onUnload, onError, onUnhandledRejection } from '@dcloudio/uni-app'
import { useTripStore } from '@/stores/trip'
import { SYNC_ENABLED } from '@/config'

const store = useTripStore()

// 全局错误可见性（和 main.ts 的 app.config.errorHandler 配套）：
// 统一挂 [app-err:…] 前缀，让「不报错、只是不对」这类静默失败至少有 console 痕迹，
// 也方便日后接入线上日志时按前缀一次性聚合。onUnhandledRejection 仅 mp-weixin 支持，
// H5 端无此回调（Vue 与 fetch 层错误由 errorHandler + onError 兜底）。
onError((err) => console.error('[app-err:lifecycle]', err))
onUnhandledRejection((err) => console.error('[app-err:unhandled-rejection]', err))

onLaunch(() => {
  store.load()
  // 已有进行中的行程直接进行程页；否则停留在欢迎页（entryPagePath）
  if (store.activeTripId && store.trips.length) {
    uni.reLaunch({ url: '/pages/ItineraryPage' })
  }
  // 后台静默同步：失败也不打扰用户，本地照常可用
  if (SYNC_ENABLED) void store.syncAll()
  // 实时通道：启动后常驻，同行的人一改这边就能看到。
  // 放在 syncAll 之后 —— 首次全量拉取自己会建立 rev 基线，订阅时才有东西可比。
  store.startRealtime()
})

onShow(() => {
  // 回到前台时补一次：别人可能在这期间改过。
  // 注意这条与实时通道**不重复**：实时只在连接活着时有效，而后台挂起期间连接多半已断，
  // 补拉一次能把「挂起期间错过的一批改动」一次性追平，比等逐条通知回来快得多。
  if (SYNC_ENABLED && store.ready) void store.syncAll()
  // 后台挂起期间 socket 往往已经被系统回收，这里立刻重连（已在线的则什么都不做）
  store.resumeRealtime()
})

/**
 * 切到后台就断开实时连接。
 *
 * 小程序 / 手机浏览器在后台会冻结网络与定时器，把连接留着只会让它变成半死状态 ——
 * 心跳发不出去、服务端那边过两个周期就把我们踢了，回到前台时看到的是一个
 * 「以为还在、其实早断了」的连接。主动断掉反而干净：回前台 resumeRealtime 重建。
 */
onHide(() => {
  store.stopRealtime()
})

onUnload(() => {
  store.stopRealtime()
})
</script>

<template></template>
