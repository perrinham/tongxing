import type { Member, Poll, PollOption, Vote } from '@/types'

/** 某个候选选项的计票结果 */
export interface PollOptionTally {
  option: PollOption
  count: number
  voters: { memberId: string; name: string }[]
}

/** 一次投票的读端投影（成员实名票 + 分布 + 胜者） */
export interface PollTally {
  total: number
  options: PollOptionTally[]
  /** 得票最高的选项；无票时为 null。平票取选项创建顺序靠前的那个 */
  winner: PollOptionTally | null
}

/**
 * 计票：把某次投票的票集合投影成可展示的结构。
 *
 * 刻意做成纯函数（不读 store）：页面与测试都能直接喂数据进来，
 * 也不依赖 Pinia 的响应式 —— 页面从 store 里取 polls/votes 后再调它即可。
 */
export function tallyOf(poll: Poll | null | undefined, votes: Vote[], members: Member[]): PollTally | null {
  if (!poll) return null
  const counts = new Map<string, number>()
  const votersOf = new Map<string, { memberId: string; name: string }[]>()
  for (const opt of poll.options) {
    counts.set(opt.id, 0)
    votersOf.set(opt.id, [])
  }
  for (const v of votes) {
    counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1)
    const voters = votersOf.get(v.optionId) ?? []
    const m = members.find((x) => x.id === v.memberId)
    voters.push({ memberId: v.memberId, name: m?.name || '成员' })
    votersOf.set(v.optionId, voters)
  }

  let total = 0
  let max = 0
  const options: PollOptionTally[] = poll.options.map((opt) => {
    const count = counts.get(opt.id) ?? 0
    total += count
    if (count > max) max = count
    return { option: opt, count, voters: votersOf.get(opt.id) ?? [] }
  })
  const winner = max > 0 ? options.find((o) => o.count === max) ?? null : null
  return { total, options, winner }
}

/** 某成员在某次投票里投的票 */
export function ballotOf(pollId: string, memberId: string, votes: Vote[]): Vote | undefined {
  return votes.find((v) => v.pollId === pollId && v.memberId === memberId)
}