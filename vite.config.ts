import { defineConfig } from 'vite'
import uniModule from '@dcloudio/vite-plugin-uni'
import { fileURLToPath, URL } from 'node:url'

// 兼容 CJS/ESM 默认导出差异：部分加载器下 import 取到的是模块对象而非 .default 工厂函数
const uni = ((uniModule as unknown as { default?: typeof uniModule }).default ??
  uniModule) as typeof uniModule

export default defineConfig({
  plugins: [uni()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
