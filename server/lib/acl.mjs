/**
 * 访问控制口径 —— 单一定义处。
 *
 * ── 为什么要单独一个模块 ──
 *
 * 这套规则（「有主 / 无主」的兼容口径）在 Step 4 是写在 routes/trips.mjs 里的
 * 两个内部函数。Step 5 加实时同步后，**订阅一个空间**也要判同一件事：
 * 「这个人有没有资格收到这个空间的变更推送」。
 *
 * 一旦在 realtime 里再抄一份，两份规则迟早会漂移 —— 而漂移的方向必然是
 * 「其中一条路径忘了收紧」，也就是一个静默的越权口子。所以这里把口径抽出来，
 * REST 与 WebSocket 共用同一份实现。
 *
 * ── 口径本身 ──
 *
 *   无主空间（owner 为空且没有任何成员行）→ **保持开放**
 *       这是接账号体系之前创建的存量数据。收紧它们会让「群里那几个人一起
 *       记的账」当场全部改不动，而那些人根本没做错什么。
 *   有主空间 → 只有 owner / 成员能访问
 *
 * 想让旧空间进入账号体系，用户得显式调 `/claim`（需出示分享码）——
 * 自动认领会把「谁知道 id」偷偷变成「谁拥有它」，那是个静默的权限变更。
 *
 * ⚠️ **这不是一个机密性边界**。`GET /api/trips/:id` 与 `by-code` 目前仍允许
 * 任何拿到 id / 分享码的人读取（id 是 `uid('trip')` 生成的随机串，当作 capability
 * 用）。所以这里的判定保护的是「谁能写」与「谁能收到变更通知」，
 * 别把它当成「看不到内容」的保证 —— 已知边界，见 README。
 */

/**
 * 空间是否已经「有主」——即是否已经进入账号体系。
 *
 * 两个来源任一生效即算有主：空间行上的 `ownerOpenid`，或成员表里有行。
 * 看两处而不是一处是有原因的：写入空间与写入成员行不在同一个事务里，
 * 极端情况下（写完成员行之前进程被杀）只会有其中一个存在。
 * 任一存在就算有主，宁可严一点，也不会把 owner 自己锁在门外。
 */
export function spaceHasOwner(db, space) {
  if (!space) return false
  return !!space.ownerOpenid || db.memberCountOf(space.id) > 0
}

/**
 * 判定某身份能否访问该空间。
 *
 * @returns {{ ok: true, reason: string } | { ok: false, status: number, message: string, reason: string }}
 */
export function accessVerdict(db, space, openid) {
  if (!space) return { ok: false, status: 404, message: 'not found', reason: 'missing' }
  if (!spaceHasOwner(db, space)) return { ok: true, reason: 'orphan-open' }
  if (!openid) {
    return {
      ok: false,
      status: 403,
      message: 'this trip belongs to an account; sign in first',
      reason: 'anonymous-on-owned'
    }
  }
  if (space.ownerOpenid === openid) return { ok: true, reason: 'owner' }
  const role = db.memberRoleOf(space.id, openid)
  if (role) return { ok: true, reason: 'member:' + role }
  return { ok: false, status: 403, message: 'not a member of this trip', reason: 'not-member' }
}
