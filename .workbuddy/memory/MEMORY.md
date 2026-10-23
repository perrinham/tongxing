# 项目长期记忆 · 同行（tongxing）

uni-app 3（Vue3 + TS）行程规划与同行分摊 App，双端：**mp-weixin（主）+ H5（预览/走查）**。

## 硬约束

- **原纪律 `server/` 零改动、前端不得引入后端接口变更**（用户早期明确要求）。
  ⚠️ **2026-09-21 决策变更**：用户决定走**路 B 微信云开发重构**（接受重构、不要自托管），
  前端数据访问层改为云函数 + 云数据库，`server/` 不再被前端使用，原"零改动"纪律自然消解。
  完整迁移清单见 `CLOUD_MIGRATION_PLAN.md`。
- 双端都要能构建：`npm run build:h5` 与 `npm run build:mp-weixin` 均须 DONE。
- **高德 key 不进库**：真 key 在 `.env.local`（已被 `*.local` 忽略），入库的 `.env` 是空默认值。
  `src/config.ts` 读 `import.meta.env.VITE_AMAP_WEB_KEY`，空则自动降级本地 6 城库。

## 工程基建

- **git + 提交前 `npm run verify`**（`githooks/pre-commit` + `core.hooksPath`）；新机 clone 后 `npm run hooks:install`。
- **CI**：`.github/workflows/ci.yml`（Node22）推 GitHub 后跑 verify + build:h5 + 三段离线 smoke。
- **`npm run fix:env`**（幂等）：vue-router 软链 + esbuild 平台二进制补齐。
- **平台能力闸门 `npm run check:platform`**（进 verify 链）：`.self` / `inset:` / `canvas fillStyle=var()` /
  `createSelectorQuery` 无 `.in(` / `saveImageToPhotosAlbum` 无 H5 兜底 → 硬失败；`<Transition>` → 警告。
- **四段冒烟共用 `scripts/lib/test-harness.mjs` 的 `createHarness()`**，新断言一律从这里取，别重写 `let pass/fail`。

## 验证链（改完必跑，实际顺序）

`vue-tsc → check:tokens → contrast:audit → palette:audit → check:platform → build:mp-weixin → wxss:lint → city:smoke`。
另有 `palette:search`、`check:platform` 之外的冒烟（`city-smoke` 65 用例 / `client-sync`）。

> `build:h5` 清 `dist/build/h5/assets`（139 文件）会撞批量删除保护（阈值 50），只对这条命令放宽：
> `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=2000 npm run build:h5`。别改全局配置。

## 颜色约定（别违反）

- **三套色互斥**：品牌色 `--brand` / 语义色（accent·warn·danger）/ 分类色 `--cat-*`；身份色 `AVATAR_COLORS` 是第四套（已知待办，别改一半）。
- **选色不靠手感**：`scripts/search-palette.mjs` 按 CIE76 ΔE + WCAG 穷举。分类色两两 ≥ 20、vs 语义色 ≥ 22、压浅底 ≥ 3.0。
- **语义色分填充态 / 文字态两套**：浅底文字一律走 `-deep`（按最差浅底 `--bg-subtle`#E9E9EB 反推 `Y ≤ 0.14244`）；填充/图形用基色。`--danger` 按最差底反推 `#B01F16`。
- **分类色只当图标/条形填充，永远不当文字色**（最低 3.09:1 只够图形）；数字走 `--text-*`。
- **`--text-tertiary` 过不了 AA 是有意的**（压白 2.73:1，Apple tertiaryLabel 更浅）；但**别调亮**——提到 secondary 会撞选中态 `--brand-deep`（差 0.0073，`contrast:audit` 每轮重算并打印）。
- **压在色块上的文字一律 `avatarInk(底色)`**（黑白二选一，任何底 ≥ 4.58:1）；地图 callout/label 颜色是运行时 JS 常量、`contrast:audit` ⑥ 守调用点+实现。
- **`--line-strong` 只准画线（border/分隔线 background），不许当 `color`**（压白卡 1.52:1，已误用三次，运行时才抓到）。
- **「未选中态」一律留 tertiary**（tab 未选中、未点亮 ★、字中 `·`）。
- **禁用态只有一种**：`--bg-sunken` 底 + `--text-secondary` 字（`contrast:audit` ⑦c 守）；全局兜底收没写 `[disabled]` 的按钮。
- **特异性必须把 scoped 的 `[data-v-*]` 算进去**：页面 scoped 选择器多 +0,1,0，「全局」不一定压得住「局部」。
- **静态闸门与运行时体检互相看不见**：改完颜色两个都要跑（--line-strong 三次与 2.1:1 全是运行时先量出）。
- **一个令牌只担一个角色**（底色/文字/线各归各，值相同也不借）；`poster.ts` 已加 `textInverse` 防借 `bgCard`。
- **颜色只有「从令牌取」一个来源**，连 `poster.ts` 的 `'#FFFFFF'` 都不许有（⑥ 扫手写字面量）。
- **「搜旧色值」覆盖 `#RRGGBB` / `rgb()` / `rgba()` 两种写法**（旧米色藏在渐变透明端 rgba）；`#15795A`/`#1D9E75` 进 DEAD。
- **属性 props 是颜色最后一层来源**（`<AppIcon color>` 38 处），由 `contrast:audit` ⑧ 守；品牌色图标 < 3:1 是有意保留（绿色=可点视觉语言）。
- **写断言判据要细**，别留「动态表达式」万能豁免口（⑧ 曾把裸 hex 落 dynamic 直接放过，证伪才发现）。
- **`node` 脚本模板字符串里别写反引号**；**不再加渐变类令牌**；灰填充块只在白色卡片内成立（页面底与 `--bg-subtle` 差 <10 阶）。

## canvas 约定

- canvas / `<map>` 读不到 CSS 变量 → 字面值集中在 `CANVAS_PALETTE`/`CANVAS_CATEGORY_COLORS`（theme.css 唯一镜像），`check:tokens` 守。
- `ctx.fillStyle='var(--x)'` 非法被静默忽略，整图一个色。
- **位图颜色烤进像素**：`marker-*.png` 由 `scripts/gen-markers.mjs` 生成（改色后 `npm run markers`），`check:tokens` ⑦ 解 PNG 读中心像素。
- **pages.json 的 navigationBarBackgroundColor / backgroundColor 必须 == `--bg-page`**（⑧）；H5 canvas 在 CSS 像素空间作画、不写 `canvas.width/height`，小程序端 `type="2d"` 才自设尺寸。

## 走查 / 自动化调试

- H5 预览：`node scripts/serve.mjs dist/build/h5 5199` → agent-browser（`set viewport 375 812` → open → seed → **reload** → 换页 `#/pages/X`）。
- 路由无 `/index` 后缀，写 `#/pages/CityMapPage`，写 `/index` 静默空白页。
- 微信开发者工具 CLI：`cli open --project` → `cli auto --project --auto-port 9420`；协议 WS JSON-RPC（`App.reLaunch`/`App.callWxMethod`/`App.captureScreenshot`，事件 `App.exceptionThrown`）。

## vendor.js Ms() 补丁（2026-09-19）

mp-weixin vendor.js 的 `Ms()` 缺类型守卫（`function Ms(e){if(!e)return;const[t,n]=e.split(",")}` 在 e 非字符串时崩，ProfilePage 触发）。`scripts/patch-vendor.mjs` 在 `build:mp-weixin` 后加 `typeof e!=="string"` 守卫，已链入 npm script，幂等。15 页自动化 0 异常。

## 部署路线决策（2026-09-21）

- **用户选路 B：微信云开发重构**（接受重构，不要自托管）。完整清单 `CLOUD_MIGRATION_PLAN.md`。
- **云开发费用事实（已核实，修正旧 MEMORY 的"无免费档"误记）**：
  - FREE 免费体验版 ¥0/月（3000 资源点/月，每账号 1 免费环境）。
  - 免费云环境活动（截止 2026-12-31）：小程序**未发布上线**阶段免费；**正式发布上线后自动转 19.9元/月**。
  - 用户"只发体验版不上线" → 0 元；免服务器/备案/HTTPS/request 合法域名（mp 端 callFunction 走微信内网）。
  - 免费档不支持按量付费，超额即停用、不扣费（对体验项目安全）。配额：调用 20万次/月、2GB、QPS 500。
- **自托管路线（未采用，备选要点）**：`server/` 零 npm 依赖（node:http + Node22 node:sqlite）→ Dockerfile 用 node:22-alpine；后端地址运行时可配（`services/backendBase.ts` 设备级 key）；HF Spaces 免费容器磁盘临时 → `server/backup.mjs` 每小时 push 库到 `_backup/` 启动前恢复；坑：`git -c http.extraHeader` 须与 push 同次调用、演练假数据须合法 SQLite。
