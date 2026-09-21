/**
 * 后端地址的运行时配置。
 *
 * config.ts 里的 BACKEND_BASE_URL 是**构建期默认值**（localhost 只在开发者工具/模拟器里有意义），
 * 真机上连不到电脑的 localhost。免费部署路线（自托管）下服务器地址经常变
 * （局域网 IP、家庭宽带、免费容器域名），所以支持在 SyncPage 里**按设备**覆盖：
 *
 * - 存储：设备级设置（uni storage 独立 key），不是业务数据，不走 storageFor(store) 工厂。
 * - 读取：每次现读（低频调用：请求封装、WS 建连、设置页展示），改完地址立即生效。
 * - 校验：必须 http(s):// 开头、去掉尾部斜杠，非法值静默回退默认。
 */

import { BACKEND_BASE_URL as BACKEND_BASE_DEFAULT } from '@/config'

const KEY = 'tx_backend_base'

export function getBackendBase(): string {
  try {
    const v = uni.getStorageSync(KEY)
    if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim())) {
      return v.trim().replace(/\/+$/, '')
    }
  } catch {
    // storage 不可用（极端环境）时退默认值
  }
  return BACKEND_BASE_DEFAULT
}

/** 保存并返回归一化后的地址；非法返回 null（调用方提示错误） */
export function setBackendBase(url: string): string | null {
  const t = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/\S+$/.test(t)) return null
  try {
    uni.setStorageSync(KEY, t)
  } catch {
    // ignore：写不进去只能本次会话生效
  }
  return t
}

export function resetBackendBase(): void {
  try {
    uni.removeStorageSync(KEY)
  } catch {
    // ignore
  }
}
