/**
 * 同日路线 2-opt 优化 —— 借鉴 liketrek/TREK 的路线模块「最近邻后 2-opt」思路
 * （AGPL，不抄代码，只借算法思想）。
 *
 * 我们的规则引擎按「最近邻生长」排一天的顺序，最近邻会产生交叉式绕路
 * （例：贪心序 32.83km，2-opt 后 31.11km）。2-opt 在这里做**路径版**
 * 反转子段：每次反转 (i..j) 一段，若总距离变短就采纳，反复扫描直到无改进。
 *
 * 口径：
 *  · 首点锁定 —— 种子（高分起点=上午从这开始）不动，只反转 i ≥ 1 的段；
 *  · 集合不变，只调顺序；
 *  · 只缩短不换向倾向：无改进时输出与输入一致（确定性）；
 *  · 攻略（真人玩法）天不参与。
 */
export function twoOptDay<T>(day: T[], km: (a: T, b: T) => number): T[] {
  if (day.length < 4) return day.slice()

  const lengthOf = (p: T[]): number => {
    let s = 0
    for (let i = 1; i < p.length; i += 1) s += km(p[i - 1], p[i])
    return s
  }

  const out = day.slice()
  let improved = true
  let sweeps = 0
  while (improved && sweeps < 6) {
    improved = false
    sweeps += 1
    for (let i = 1; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const before = lengthOf(out)
        const reversedSeg = out.slice(i, j + 1).reverse()
        const candidate = [...out.slice(0, i), ...reversedSeg, ...out.slice(j + 1)]
        if (lengthOf(candidate) < before - 1e-6) {
          for (let k = 0; k < out.length; k += 1) out[k] = candidate[k]
          improved = true
        }
      }
    }
  }
  return out
}
