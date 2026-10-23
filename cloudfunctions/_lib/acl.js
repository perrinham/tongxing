/**
 * 访问控制口径（单一定义处）—— 云函数侧的 CommonJS 移植。
 *
 * 孪生文件链：
 *   1. server/lib/acl.mjs       （自托管参考实现）
 *   2. cloudfunctions/_lib/acl.js （云函数，本文件）
 *   3. 各云函数目录里的 _lib/acl.js 副本（由 scripts/cloud-lib-sync.mjs 生成，勿手改）
 *
 * 口径：无主空间（owner 为空且无成员行）保持开放；有主空间只有 owner / 成员可访问。
 * ⚠️ 不是机密性边界 —— id / 分享码仍是 capability（读开放），判定保护的是「谁能写」。
 */

/**
 * @param db 云数据库存储句柄（需提供 memberCountOf / memberRoleOf）
 * @param space 内存态空间对象
 */
function spaceHasOwner(db, space) {
  if (!space) return false
  return !!space.ownerOpenid || db.memberCountOf(space.id) > 0
}

/**
 * @returns {{ ok: true, reason: string } | { ok: false, status: number, message: string, reason: string }}
 */
function accessVerdict(db, space, openid) {
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

module.exports = { spaceHasOwner, accessVerdict }