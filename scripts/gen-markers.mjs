// 生成城市足迹地图用的标记图标（不依赖任何第三方库，纯 Node 内置 zlib）。
// 输出：static/marker-visited.png（去过·品牌绿）、static/marker-wish.png（想去·强调橙）
import zlib from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* 颜色**不写死**：从 theme.css 解析，与 CANVAS_PALETTE 同源。
   教训：这里原来是 [29,158,117](#1D9E75) 与 [216,90,48](#D85A30) 两个字面值，
   而 CityMapPage 的标签侧早就改成了 CANVAS_PALETTE.brand / warn ——
   注释里那句「同一个绿有两块色差」指的就是这里，但当时只修了标签侧、没修这个脚本。
   实测：PNG 实心色 vs 标签底色 ΔE = 6.6（绿）/ 29.2（橙红），
   后者比本项目分类色两两的阈值 20 还远 —— 同一个「想去」在地图上有两个差得离谱的颜色。 */
const THEME = readFileSync(join(__dirname, '..', 'src', 'styles', 'theme.css'), 'utf8')
const VARS = {}
for (const m of THEME.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
  VARS[m[1]] = m[2].toUpperCase()
}
if (!VARS['--brand'] || !VARS['--warn']) {
  throw new Error('theme.css 里没解析到 --brand / --warn —— 令牌改名了？')
}
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const VISITED_RGB = hexToRgb(VARS['--brand'])
const WISH_RGB = hexToRgb(VARS['--warn'])

/* 输出两个目录：`static/`（历史位置）与 `src/assets/`（源码 import 的那个）。
   以前是生成到 static/ 再手动拷进 src/assets/ —— 手动一步就是漂移机会，所以一起写。 */
const OUT_DIRS = [join(__dirname, '..', 'static'), join(__dirname, '..', 'src', 'assets')]
for (const d of OUT_DIRS) mkdirSync(d, { recursive: true })

const SIZE = 30 // 偶数，便于居中
const CENTER = SIZE / 2
const FILL_R = 11 // 实心半径
const RING_R = 13 // 白边外缘半径

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
  }
  return (~c) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function makeMarker(rgb) {
  const [R, G, B] = rgb
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let p = 0
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - CENTER
      const dy = y + 0.5 - CENTER
      const d = Math.sqrt(dx * dx + dy * dy)
      let a = 0
      let r = 0
      let g = 0
      let b = 0
      if (d <= FILL_R) {
        r = R
        g = G
        b = B
        a = 255
      } else if (d <= RING_R) {
        r = 255
        g = 255
        b = 255
        a = 255
      } else {
        a = 0
      }
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = a
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const d of OUT_DIRS) {
  writeFileSync(join(d, 'marker-visited.png'), makeMarker(VISITED_RGB))
  writeFileSync(join(d, 'marker-wish.png'), makeMarker(WISH_RGB))
}
console.log('markers generated ->', OUT_DIRS.join('  '))
console.log(`  visited = ${VARS['--brand']}   wish = ${VARS['--warn']}`)
