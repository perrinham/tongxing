/**
 * 平台能力闸门：扫出「只在某端复现、不报错」那一类坑（见 dev log 里反复踩的族）。
 *
 * 用法：npm run check:platform（已进 verify 链）
 *
 * 规则一览 —— 硬失败（FAIL）：
 *   1. 事件修饰符 `.self`（`@click.self`）：编译到 mp-weixin 时被**静默丢弃**，
 *      等效裸 `@click`，点弹层内任何元素都会冒泡触发关闭。
 *      修法：遮罩 `data-role` + dataset 判定（AppSheet 已按此修）。
 *   2. CSS `inset:` 简写：WXSS 编译器丢弃 → 元素失去定位尺寸。
 *      修法：显式 top/right/bottom/left 四向写法（MapPage/AppSheet 已按此修）。
 *   3. canvas `fillStyle = 'var(--x)'`：非法值被**静默忽略**（保持上一个颜色）→
 *      整张图一个色。canvas 读不到 CSS 变量，必须走 CANVAS_PALETTE 字面值表。
 *   4. `createSelectorQuery()` 不带 `.in(组件实例)`：小程序默认只查页面范围节点，
 *      自定义组件内部查询永远查空 → 静默返回。修法：查组件实例（PosterCanvas 的 scopedQuery）。
 *   5. `saveImageToPhotosAlbum()` 所在文件没有 H5 替代路径：该 API 在 H5 是
 *      createUnsupportedAsyncApi，调用必失败。文件里必须同时存在 `isH5` 分支的 H5 下载路径。
 *
 * 警告（WARN，只报不判）：`<Transition>` —— AppSheet 案例证明小程序端任何 setData
 * 都会把过渡类重置回 enter-from（弹层输入一个字就整层变透明）。纯静态 toast（无输入、
 * 无 setData 驱动）可用；涉及输入/受控组件的弹层不要用，改 CSS @keyframes。
 */
import { globSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = globSync(join(root, 'src/**/*.{vue,ts,css}'))

function stripComments(src) {
  // 逐字符剥掉 /* */ 与 <!-- --> 块注释和 // 行注释，让闸门只审「活代码」。
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2)
      i = end === -1 ? n : end + 1
    } else if (c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
    } else {
      out += c
      i += 1
    }
  }
  return out
}

const fails = []
const warns = []
let checked = 0

function scan(file, src) {
  const clean = stripComments(src)
  const base = file.slice(root.length + 1)

  if (/@[\w.:-]+\.self\b/.test(clean)) {
    fails.push(`${base}: 事件修饰符 .self 会被 mp-weixin 静默丢弃，改用 dataset + data-role 判定`)
  }
  if (/\binset\s*:/.test(clean)) {
    fails.push(`${base}: inset: 简写会被 WXSS 丢弃，改显式 top/right/bottom/left`)
  }
  if (/fillStyle\s*[:=]\s*['"]var\(/.test(clean)) {
    fails.push(`${base}: canvas fillStyle 收到了 var() —— 非法值被静默忽略，走 CANVAS_PALETTE 字面值`)
  }
  if (/createSelectorQuery/.test(clean) && !/\.in\(/.test(clean)) {
    fails.push(`${base}: createSelectorQuery 没有 .in(组件实例)—— 小程序查不到自定义组件内部节点，将静默返回`)
  }
  if (/saveImageToPhotosAlbum\(/.test(clean) && !/\bisH5\b/.test(clean)) {
    fails.push(`${base}: saveImageToPhotosAlbum 在 H5 是未实现 API，文件里必须有 isH5 分支的 H5 下载路径`)
  }
  const transitions = [...clean.matchAll(/<Transition\b/g)].length
  if (transitions > 0) {
    warns.push(`${base}: 用了 ${transitions} 处 <Transition>——静态 toast 可，输入/受控组件弹层必须改 CSS @keyframes（AppSheet 教训）`)
  }
}

for (const file of files) {
  checked++
  scan(file, readFileSync(file, 'utf8'))
}

for (const w of warns) console.log('  ⚠', w)
for (const f of fails) console.log('  ✗', f)
console.log(`\n[check:platform] 扫描 ${checked} 个文件 ·${fails.length ? ` 失败 ${fails.length} 项 ✗` : ''} · 警告 ${warns.length} 项`)

process.exit(fails.length ? 1 : 0)