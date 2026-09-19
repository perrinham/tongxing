import { createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/theme.css'
import './styles/global.css'

export function createApp() {
  const app = createSSRApp(App)
  app.use(createPinia())
  // 全局运行时错误：统一打上 [app-err] 前缀记日志。
  // 平时靠 console 在开发者工具里捞；以后接线上日志/埋点时只要按前缀聚合即可（见 App.vue onError）。
  // 睡前别删 —— 这是「静默失败类 bug」的最后一层可见性（一个没有 errorHandler 的未捕获异常
  // 在 mp-weixin 端只会 console 一行，H5 端甚至什么都不显示）。
  app.config.errorHandler = (err, _instance, info) => {
    console.error(`[app-err:vue:${String(info)}]`, err)
  }
  return { app }
}
