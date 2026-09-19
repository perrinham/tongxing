# 项目长期记忆 · 同行（tongxing）

uni-app 3（Vue3 + TS）行程规划与同行分摊 App，双端：**mp-weixin（主）+ H5（预览/走查）**。

## 硬约束

- **`server/` 零改动**（用户明确要求）。前端改动不得引入后端接口变更。
- 双端都要能构建：`npm run build:h5` 与 `npm run build:mp-weixin` 均须 DONE。
- **高德 key 不进库**：真 key 在 `.env.local`（已被 `*.local` 忽略），入库的 `.env` 是空默认值。
  `src/config.ts` 读 `import.meta.env.VITE_AMAP_WEB_KEY`，空则自动降级本地 6 城库。

## 工程基建（2026-09-19 起）

- **有 git 了**：提交前强制 `npm run verify`（`githooks/pre-commit` + `core.hooksPath`）。
  新机器 clone 后跑一次 `npm run hooks:install`。嫌慢 `--no-verify` 跳过（常驻豁免=坏味道）。
- **有 CI 了**：`.github/workflows/ci.yml`（Node22），推 GitHub 后自动跑 verify + build:h5 + 三段离线 smoke。
- **环境修复**：`npm run fix:env`（幂等）——vue-router 软链 + esbuild 平台二进制补齐（原 README 两条手工 hack 脚本化）。
  踩过：`node <esbuild-bin>` 会把原生二进制当 JS 跑；拷贝目录要用 `cpSync` 不是 `copyFileSync`。
- **平台能力闸门**：`npm run check:platform`（已进 verify 链）——
  `.self` / `inset:` / `canvas fillStyle=var()` / `createSelectorQuery` 无 `.in(` / `saveImageToPhotosAlbum` 无 H5 兜底 → 硬失败；
  `<Transition>` → 警告（静态 toast 可，输入/受控弹层必须 CSS @keyframes，AppSheet 教训）。
- **四段冒烟共用一份断言宏**：`scripts/lib/test-harness.mjs` 的 `createHarness()`（ok/section/pass/fail）。
  新冒烟断言一律从这里取，别再在各自文件里重写一份 `let pass/fail`——「审计脚本各漂各的」是这项目的老病。
- Node 版冒烟的未捕获异常/未处理拒绝默认就让进程非零退出，不用再造；UI 侧运行时错误看 `[app-err:…]` 前缀。

## 验证链（改完必跑）

```bash
npm run typecheck          # vue-tsc，0 错
npm run check:tokens       # 令牌 ↔ canvas 字面值 / 位图 / pages.json 防漂移（8 项断言 + 解析覆盖率）
npm run contrast:audit     # 文字对比度闸门（45 条配对 + 七类断言 + 输入校验）
npm run palette:audit      # 色板体检：分类色三条约束，越界即返回非 0（23.5 / 25.9 / 3.09:1）
npm run check:platform     # 平台能力闸门：.self / inset: / fillStyle=var() / createSelectorQuery 无 .in / saveImageToPhotosAlbum 无 H5 兜底
npm run build:mp-weixin
npm run wxss:lint          # 22 个 wxss
npm run city:smoke         # 65 用例
npm run verify             # 上面几项的串链；四个闸门都在链里
```

链的实际顺序：`vue-tsc → check:tokens → contrast:audit → palette:audit → check:platform → build:mp-weixin → wxss:lint → city:smoke`。
另有 `npm run palette:search`（按约束穷举分类色候选）。
**别再把审计脚本放在链外** —— `palette:audit` 曾经只打印不判定，等于一份没人看的报告，
和「审计脚本写死快照」是同一个坑的两种形态。

> `build:h5` 会清 `dist/build/h5/assets`（139 个文件），会撞环境的批量删除保护（阈值 50）。
> 这是构建产物的正常重建，**只对这条命令放宽**即可：
> `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=2000 npm run build:h5`。别改全局配置。

## 颜色约定（别违反）

- **三套色互斥**：品牌色（`--brand`）/ 语义色（accent·warn·danger）/ 分类色（`--cat-*`）
  —— 分类色不得与品牌色或语义色重合；**身份色（`AVATAR_COLORS`）是第四套**，仍有重叠，
  属已知待办，`format.ts` 里已加注释，**别顺手改一半**。
- **选色不靠手感**：用 `scripts/search-palette.mjs` 按 CIE76 ΔE + WCAG 对比度穷举。
  阈值口径：分类色两两 ≥ 20（依据：iOS `blue↔indigo` ΔE=19.6 是苹果自己最挤的一对）、
  分类色 vs 语义色 ≥ 22、压浅底对比度 ≥ 3.0。
- **语义色分「填充态」和「文字态」两套值**：`--brand` / `--accent` / `--warn` 基色是给
  填充用的（条形、圆点、整块按钮底），明度天生偏高，当浅底上的小字只有 2.85~3.27:1。
  浅底上的文字一律走 `-deep` 变体；`--danger` 因为同时当「白底红字」和「白字按钮的底」，
  直接把基色按最差底色反推（`#B01F16`，双向 5.67~6.88:1）。
  填充和图形（SVG）用基色，文字用 `-deep` —— 这条别违反，`contrast:audit` 的 ② 会拦。
- **`-deep` 的取值口径是「最差底色反推」**：文字会落在白卡 / `--bg-page` / `--bg-subtle`
  三种浅底上，取最深的 `--bg-subtle`(#E9E9EB) 当界：`Y ≤ 0.14244`。别按「好看」挑。
- **禁用态用灰底表示「按不动」，但标签不能跟着变没**：`--text-tertiary` 压灰底只有
  ~2.2:1，那不是禁用、是坏了。`[disabled]` 的标签一律 `--text-secondary`。
- **分类色只当图标 / 条形填充，永远不当文字色**（最低 3.09:1 只够图形/UI 组件线）：
  数字用 `--text-*`；记账页分类块把分类色**只挂在图标上**，12px 标签走 `--text-primary`。
  「给每个分类再配一套 -deep」已试算并否掉 —— 压暗后餐饮 `#B9470A` 与 `--accent-deep`
  `#AB3D07` 的 ΔE 只有 3.9，等于让分类色变成「应付」的橙。
- **`--text-tertiary` 过不了 AA 是有意的**（压白底 2.73:1）：要在白底上过 4.5，文字明度得压到
  `Y ≤ 0.183`，而 `--text-secondary` 已是 0.135 —— 三级灰排不下；Apple 自家 `tertiaryLabel`
  更浅（≈1.9:1）。**但别顺手把它调亮**：底部 tab 的未选中态若提到 secondary，它的 `Y = 0.135`
  会和选中态 `--brand-deep` 的 `Y = 0.127` 撞在一起（差 0.0073，`contrast:audit` 每次重算并打印），
  选中/未选中只剩色相可辨，可用性反而降。
- **实心按钮的白字（3.18:1）和历史遗留的 `.btn-primary` 偏差是有意保留的**，别一起改。
- **凡是压在色块上的文字都走 `avatarInk(底色)`**（白/黑取对比度更高者）：13px 头像初始字、
  地图 `callout`（12px 城市名）/ `label`（序号）—— 写死白字只有 3.18~3.93:1。
  该规则对**任何**底色保证 ≥ 4.58:1（最差点在黑白相等处 `Y + 0.05 = 0.22913`）。
  地图那两个颜色是**运行时 JS 常量、不走 CSS**，`contrast:audit` 的 ⑥ 同时守调用点
  （必须含 `avatarInk(`）和实现（函数体必须真是黑白二选一）；头像那处由 `check:tokens` 守。
  `.btn-primary` 的白字压品牌绿（3.18:1）是**有意保留**的苹果惯例偏差，别一起改。
- **凡是「校验现状」的脚本，数据必须从源文件解析，不能写死**（`check-palette.mjs` 曾因写死
  「候选色板」而在色板落地后继续报旧数据 —— 审计脚本一旦漂移比没有更糟）。
- **「算出来的数」四个藏身处都别写死：审计脚本的表、不在校验链里的工具脚本、代码注释、文档**。
  判断标准一句话：**这个数会不会随代码变化？会 → 交给脚本重算/解析，注释与文档只写结论。**
  实际栽过三处：`theme.css` 注释里 `--brand-deep` 的 `Y = 0.146`（那是旧值 `#15795A` 的，
  真值 0.127）、文档里「tertiary 72 处」与「后端 313 / 客户端 137 / 城市 41 条断言」
  （实际一直在变：现在 72 处、340 / 149 / 56）、`search-palette.mjs` 的语义色锚点
  （还停在 `#15795A` / `#E03B30`，导致搜索建议基于过期前提）。现在 `contrast:audit` 第五节末尾
  **每次重算** `Y(--text-secondary)` 与 `Y(--brand-deep)` 的差并打印结论，那句
  「tab 未选中态别提到 secondary」的设计判断因此自带前提校验；`search-palette.mjs` 改成从
  `theme.css` 解析并「解析不到就抛错」。
- **写了「以脚本输出为准」就不要再补具体数字** —— 规则和例外在同一个括号里打架，等于没有规则
  （README 的「tertiary 70 处」就是这么活的）。
- **新写的闸门必须被证伪过一次才算数**：故意把被保护的东西弄坏，确认它变红。
  教训：`contrast:audit` 的 ⑥ 第一版是脚本**自己重算了一遍数学**（验的是「性质」而不是
  「`format.ts` 里那行字」），所以把 `avatarInk` 改成固定 `return '#FFFFFF'` 也照样全绿；
  补上「函数体必须真是黑白二选一」的结构断言后才抓得住。**没被证伪过的闸门比没有更糟**
  —— 它给的是虚假的安全感。
- **`--line-strong` 只准画线（border / 分隔线的 background），不许当 `color`**：它是发丝线的
  颜色，压白卡只有 1.52:1。同一个令牌已被误用**三次**，每次都是运行时体检才抓到的：
  当 `[disabled]` 按钮的**底**（上面压白字）、当 `.dot-sep` 的**正文色**、当「城市足迹」评分的
  未选中 ★ **字形色**。`contrast:audit` 的 ⑦ a 守着这条。
- **「未选中态」这一族一律留 tertiary**：tab 未选中标签、未点亮的 ★、字中间的 `·`。
  它们是同一类取舍 —— 信息不靠它们单独承载（★ 右边就是「3.0 / 未评」）。
- **禁用态只有一种样子：`--bg-sunken` 底 + `--text-secondary` 字**（`[disabled]` 规则的
  配色统一由 `contrast:audit` ⑦ c 守）。`global.css` 里有一条**同等特异性**的全局兜底
  （`uni-button[disabled][type="default"], uni-button[disabled]:not([type])` + 原生 `button` 两组），
  专收那些**没写 `[disabled]`** 的按钮 —— uni 内置的是 `#F7F7F7` + `rgba(0,0,0,.3)` = **2.1:1**。
- **特异性必须把 scoped 的 `[data-v-*]` 算进去**：页面 `<style scoped>` 编译后每条选择器都多
  一个属性选择器（+0,1,0），所以 `.key.save[disabled][data-v-x]` = **0,3,0** **高于**全局兜底的
  **0,2,1** —— **「全局」不一定压得住「局部」**，兜底只替没写的那批收尾。
  （我曾在这一点上先推理错、被实测纠正。）
- **静态闸门与运行时体检互相看不见对方那半边，改完颜色两个都要跑**：
  静态的看不见「底色来自祖先」（① 只算同一条规则里同时有 color + background 的配对）
  和「被框架样式盖出来的」（禁用态）；运行时的证明不了未来不回归。
  上面 `--line-strong` 那三次与 2.1:1 那处，**全是运行时先量出来的**。
- **一个令牌只担一个角色**（底色 / 文字 / 线，各归各的，哪怕当前值完全相同）：
  栽过两次 —— `--line-strong` 同时被当线、当按钮底、当字；`poster.ts` 的品牌带白字借
  `P.bgCard`（卡片底的角色）当文字。后者已加 `textInverse`(`--text-inverse`)，⑥ 断言不许借回去。
  理由是「改一个会牵动另一个，而且没人报警」。
- **颜色只有「从令牌取」一个来源，连 `poster.ts` 里的 `'#FFFFFF'` 都不许有**
  （值上等于 `bgCard` 也不行 ——「恰好相等」不是理由）。⑥ 会扫这个文件的手写颜色字面量。
- **「搜旧色值」必须覆盖所有等价写法**：`#RRGGBB` / `rgb(r,g,b)` / `rgba(...)`。
  只认十六进制时，旧米色 `#F8F7F4` 以 `rgba(248,247,244,0)` 活在**三处滚动渐变的透明端**里
  （渐变的透明端也要写目标底色的 RGB，插值会把它带出来）。④ 现在两种拼写都扫；
  旧 `--brand-deep` `#15795A` 也已进 DEAD（和 `#1D9E75` 同性质：**「另一个绿」**）。
- **属性（props）是颜色的最后一层来源**：`<AppIcon color="…">` 既不是 CSS 规则、
  也不是 `color: var(--x)` 写法，① 和 ② 都读不到（全仓 38 处）—— 由 `contrast:audit` 的 ⑧ 守
  （裸色值 `#fff` 除外 ✗ / `var()` 指向不存在的令牌 ✗ / 其余打印实测值）。
  注意 ② 的 `ICON_ALLOW = ['.nav-icon']` 是**照着 CSS 写法拟的**，与实际来源不是同一批。
- **品牌色图标低于 1.4.11 的 3:1，是有意保留**：`--brand` 压白卡 3.18（勉强）／
  页面底 **2.85**／`--brand-soft` **2.82**；tertiary 箭头 2.25~2.73。
  别把 ② 那句「图形只要 3:1」当成已达标 —— 它是取舍，实测值由 ⑧ 打印。
  压成 `-deep` 会丢掉「绿色 = 可点」这个视觉语言。
- **写断言时判据要写细，别给自己留「动态表达式」这种万能豁免口**：
  ⑧ 第一版把裸 hex 落进 `dynamic` 分支直接放过 —— 声称拒裸色值、实际一个都拒不了，
  **是证伪时发现的**（把 `color="var(--brand)"` 改成 `#1FA470` 照样全绿）。
- **`node` 脚本里别在模板字符串里写反引号**（`` `var(--token)` `` 会把模板串提前截断，
  报 `SyntaxError: missing ) after argument list`）。
- **不要再加渐变类令牌**；颜色只编码信息，装饰一律不要。
- 灰填充块只在**白色卡片内部**成立：页面底色 `#F2F2F7` 与 `--bg-subtle #E9E9EB` 差不到
  10 个色阶，直接在灰底上铺灰块会糊在一起。

## canvas 约定

- canvas / 微信 `<map>` 读不到 CSS 变量 → 字面值集中在 `CANVAS_PALETTE` /
  `CANVAS_CATEGORY_COLORS`（theme.css 的唯一镜像），由 `check:tokens` 守。
- `ctx.fillStyle = 'var(--x)'` 是**非法值、被静默忽略**（保持上一个色），会导致整张图一个色。
- **位图资源的颜色是「烤进像素」的**：`static/` 与 `src/assets/` 的 `marker-*.png` 由
  `scripts/gen-markers.mjs` 生成，改了 `--brand` / `--warn` 后必须跑 `npm run markers`
  （脚本自己从 `theme.css` 解析颜色，两个副本目录一起写 —— 别再手动拷）。
  `check:tokens` 的 ⑦ 会**解开 PNG 读中心像素**做断言：因为「全仓搜旧色值」只读文本文件，
  **扫不到字节** —— `#1D9E75` 曾长期活在 PNG 里，而它本身就躺在 `DEAD` 黑名单上。
- **平台配置文件里的颜色也要守**：`src/pages.json` 的 `globalStyle.navigationBarBackgroundColor`
  与 `backgroundColor` 必须 == `--bg-page`（`check:tokens` 的 ⑧）。它们读不到 CSS 变量，
  漂移了就是「导航栏 vs 页面底两块色」。
- **H5 端 canvas 的后备存储不归我们管**：uni 的 ResizeSensor 会按
  `offsetWidth × pixelRatio` 重置它并打上 `__hidpi__`（绘制坐标内部再乘 pixelRatio）。
  H5 要在 **CSS 像素空间**作画，且**不要写** `canvas.width/height`；
  小程序端（`type="2d"`）才由我们设尺寸。详见 `PosterCanvas.vue` 的 `renderH5()`。

## 走查/截图口径

- H5 预览：`node scripts/serve.mjs dist/build/h5 5199`（常驻）→ `agent-browser`。
  `set viewport 375 812` → `open` → `eval 种子`（`node scripts/seed-ui.mjs`）→ **`reload`**
  （只改 hash 不重载 SPA，种子不生效）→ `eval "location.hash='#/pages/X'"` 换页。
- **路由没有 `/index` 后缀**：`pages.json` 里写的是 `pages/CityMapPage`，所以 H5 要用
  `#/pages/CityMapPage`。写成 `#/pages/CityMapPage/index` 会**静默渲染空白页**（不报错），
  很容易白排查好几轮。
- 页面无 `<button>`：uni 编译成 `uni-button`（连 `global.css` 里写的 `button[...]` 选择器也会
  被 H5 构建改写成 `uni-button[...]`），点击用 `click ".btn-primary"` / `[class*=fab]`。
  要打开城市评分面板得先注入 `travel_cities_v1`（`city.load()` 读的就是它）+ 点 `.city-row`。
- **不要往 src 里塞 TEMP-DEBUG**：尺寸/`__hidpi__`/computed style 都能用 `agent-browser eval` 读到。
- 后端本地：`npm run server`（:8787）；不可达时前端静默回退纯本地，不崩。

## 微信开发者工具自动化调试

- CLI：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`
- 启动自动化：`cli open --project <path>` → `cli auto --project <path> --auto-port 9420`
- 协议：WebSocket JSON-RPC（`ws://127.0.0.1:9420`），方法名：`App.reLaunch`（via `App.callWxMethod`）、
  `App.getPageStack`、`App.captureScreenshot`；事件：`App.exceptionThrown`（运行时异常）
- `miniprogram-automator` 0.12.1 协议已逆向确认，与 DevTools CLI 自动化端口一致

## vendor.js Ms() 补丁（2026-09-19）

- **根因**：Vue3 mp-weixin vendor.js 的 `Ms()` 函数（组件 prop 缓存 key 解析）缺少类型守卫，
  `function Ms(e){if(!e)return;const[t,n]=e.split(",")}` 在 `e` 是 truthy 非字符串时崩溃
  （ProfilePage 的组件 prop 组合触发此路径，其他 14 页不触发）。
- **修复**：`scripts/patch-vendor.mjs` 在 `build:mp-weixin` 后自动修补 vendor.js 中 `Ms()`，
  加 `typeof e !== "string"` 守卫。已链入 npm script（幂等，重复运行无副作用）。
- **原因**：mp-weixin vendor.js 是 `@dcloudio/uni-mp-compiler` 编译产物，无法从源码层修复。
- **验证**：15 页自动化全部 0 异常（含 ProfilePage）。
