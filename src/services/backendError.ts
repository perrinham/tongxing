/**
 * 后端调用错误。
 *
 * 单独成文件是为了打破 `backend.ts <-> cloud.ts` 的循环依赖：
 *   - backend.ts 既走 HTTP 也走云函数，两种失败都要归一成这个类型；
 *   - cloud.ts 需要抛出同样的类型，但它不能反向 import backend.ts（会成环）。
 *
 * `status` 语义与 HTTP 状态码对齐（云函数也把错误码放在 status 上）：
 *   0       网络不可达 / 未知错误（客户端据此判断「离线」，静默降级）
 *   4xx/5xx 服务端明确拒绝
 */
export class BackendError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'BackendError'
    this.status = status
  }
}
