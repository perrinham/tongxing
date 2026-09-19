import { createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/theme.css'
import './styles/global.css'

export function createApp() {
  const app = createSSRApp(App)
  app.use(createPinia())
  return { app }
}
