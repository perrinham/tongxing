# UI 改版交付说明 · 苹果（iOS）设计风格

> 目标：把界面改成 iOS 系统 App 的观感。约束：**`server/` 后端代码一行未动**。
> 验证：`typecheck` 0 错 · `build:mp-weixin` 通过 · `wxss:lint` 22 个文件全过 · 16 个页面逐页截图核对。

---

## 一、为什么原来的界面不好看

问题不在配色，在**版式语法**。原来的界面用的是「卡片流」：每一块内容都是独立白卡，
每张卡都带 `1px` 描边 + 一层投影，页面上还散着大量装饰——卡片顶部的 3px 彩色渐变条、
标题的品牌渐变字、按钮的彩色光晕、浅绿色的提示卡、手绘的山形插画。

结果是整屏都在画线、都在浮起，**没有层级**——因为所有东西都一样突出。

iOS 的做法是反过来的：

| | 改造前 | 改造后 |
|---|---|---|
| 分层 | 每张卡都描边 + 投影 | 灰底 `#F2F2F7` 上的白卡，**无描边无投影** |
| 分组 | 一行一张卡 | 一张卡里放多行，行间内缩发丝线 |
| 装饰 | 顶部彩条、渐变字、光晕、插画 | 全部撤掉 |
| 选中态 | 换底色 / 加绿描边 | 分段控件的白色滑块 |
| 颜色 | 品牌绿到处刷存在感 | 只用来编码信息（分类、状态、收支方向） |

---

## 二、做了什么

### 1. 先建基座，再逐页接（关键决定）

没有逐页去调样式，而是在 `theme.css` / `global.css` 里先定义一套 iOS 语汇，页面只消费类名。
这样 16 个页面共用一份口径，不会各写一套、下次改又要找 16 个地方。

新增的组件类：

- `.list` / `.list-row` / `.list-sep`（内缩发丝线，可用 `.indent-*` 对齐图标列）
- `.list-head` / `.list-foot`（卡片外的分组抬头与灰脚注）
- `.stat3`（三段式统计条，数值长时用 `.col` 变纵向）
- `.seg` / `.seg-item.active`（灰凹槽 + 白色滑块，真正的 UISegmentedControl 观感）
- `.tint`（同色浅底 + 同色文字的标签）
- `.btn-tint`（同色浅底按钮，补齐「填充 / 灰底 / 同色浅底」三级按钮体系）

### 2. 三条必须守住的规则

1. **分层靠底色差，不靠线和影。**
2. **留白只由一层负责。** `.page-body` 给左右 16px，`.sec-title` / `.list-head` / `.list-foot` 只给纵向内边距。
   两者都带横向 padding 时，内容左边线会随容器层数逐层内缩（改版中真的踩到了：旧值 `padding: 24px 20px 8px` 让标题比卡片多缩进 20px）。
3. **颜色只编码信息，不装饰。**

### 3. 逐页改造

| 页面 | 主要改动 |
|---|---|
| **AppNav / AppTabBar / AppSheet** | 毛玻璃导航与底栏（`blur(20px)` + 半透明白）、发丝分割线、iOS 弹层 |
| **AppEmpty** | 手绘路线图插画 → iOS「内容不可用」空态：灰圆 + 图标 + 一句话 + tinted 按钮 |
| **WelcomePage** | 删掉山峦 + 太阳 SVG、渐变标题、英文 eyebrow；改为 App 图标 + 大标题 + 分组特性卡 + 满宽 CTA |
| **ItineraryPage** | 概览卡（含顶部彩条与渐变数字）→ 分组列表；D1/D2/D3 方块 → **分段控件**；时间轴卡片流 → 单张分组卡 + 内缩发丝线 |
| **ExpensePage** | 总览 → 分组卡（34/700 纯色主数字 + 三格统计）；分类占比去装饰条；流水转分组行；悬浮按钮投影收淡 |
| **SettlePage** | 去顶部彩条与渐变数字；净额 / 转账 / 分类全部转分组行 |
| **MembersPage** | 浅绿提示卡 → 白卡一行 + 灰色脚注；N 张成员卡 → 单张分组卡（行 + 行内动作条） |
| **ProfilePage** | 当前行程转分组卡；行程选中由 `1.5px 绿描边` → 一个对勾；工具 / 关于转分组行 |
| **CityMapPage** | 统计卡 + 渐变按钮 → 分段控件 + tinted 按钮；城市列表转分组行；输入控件去描边 |
| **DiscoverPage / SyncPage** | 分区标题统一；列表并进分组卡；同步状态卡去掉左侧 3px 彩条（状态圆点已经表达了） |
| **MapPage** | 原本是 `.list` 白卡里再叠 N 张「白底 + 描边 + 投影」的 `.stop` 卡（白卡套白卡）→ 收敛成单张 `.list` + 发丝线；`步行/驾车` 的本地分段控件删掉，改用 global 的 `.seg`；地图块去描边去投影 |
| **TripCreatePage** | 提示块 `.tips` 去掉 `border: 1px solid var(--hairline)` + 投影，只留白底圆角 |

另清理两处**死引用**（视觉无变化）：`ItemEditPage` 的 `.type`、`ExpenseEditPage` 的 `.cat`
上那条已被中性化成近乎透明的 `box-shadow: var(--shadow-card)`，连同 `.active { box-shadow: none }` 一起删掉。

> 保留的描边是有意的：`ItemEditPage .dt-check`、`TripGeneratePage .pref-check` / `.radio`、
> `ExpenseEditPage .cb` 这四处 `1.5px solid var(--line-strong)` 是**复选框和单选圈的轮廓**，不是卡片线。
>
> 排查用的口径：`grep -n "border: 1px solid var(--hairline)\|box-shadow: var(--shadow-card)" src/`，
> 命中项逐条判断「是卡片还是控件轮廓」。

---

## 三、踩到并修掉的 6 个坑

1. **`<button>` 是替换元素**，在纵向 flex 容器里不会被 `align-items: stretch` 拉满 ——
   首屏两个 CTA 一直是「缩成一小条、悬在页面中间」。必须显式 `width: 100%`。
2. **H5 端 `<button>` 会被编译成 `<uni-button>`**，所以 `button { … }` 这条重置在浏览器里匹配不到它，
   平台默认描边漏出来 → H5 上按钮莫名其妙多一圈绿框，而小程序里是干净的。
   重置必须写 `button, uni-button { … }`，并清掉 `::after`（默认描边画在伪元素上）。
3. **统计条里数值一长，单位会被逐字折行** —— 出现过「人\n均」这种竖排的两个字。
   根因是「数值 + 单位」横向排在 1/3 列宽里放不下。加了 `.stat3.col` 纵向变体。
4. **横向滚动在小程序端必须用 `<scroll-view scroll-x>`**。普通 `<div>` + `overflow-x: auto`
   在微信里手指是划不动的（这是个既存 bug）。日期切换条、分类筛选条都已改。
5. **H5 构建环境是坏的**（与本次改版无关）：
   `Cannot find module 'vue-router/dist/vue-router.esm-bundler.js'`。
   `vue-router` 是 `@dcloudio/uni-h5` 的传递依赖，但 npm 把它嵌装在子目录里没提升到顶层，
   `uni-cli-shared` 在自己的层级解析不到。**小程序端不受影响**（`build:mp-weixin` 一直是好的）。
   > 现场用软链解开：`node_modules/vue-router -> ./@dcloudio/uni-h5/node_modules/vue-router`。
   > 永久修法（README 已记）：`npm i -D vue-router@4.4.4`。
   > ⚠️ 这条软链在 `npm install` 后会消失，需要重建或改用上面的声明式修法。
6. **固定定位的悬浮按钮会盖住列表最后一行** —— 记账页右下角的绿色「+」是 `position: fixed`，
   完全不占文档流；页面底部内边距只避开了 tabbar，没避开它。滚到最底时它正好压住最后一笔的金额。
   （实测：按钮 `x 318–372 / y 716–770`，末条金额滚到底后落在 `y 743–769`，横向也重叠 40px。）
   修法是在列表容器上补 `padding-bottom: 54 + 24 = 78px`。**凡是页面上有 fixed 元素，
   就要给它单独留白**，不能只依赖页面级 padding。

---

## 四、怎么复查视觉

小程序截图依赖开发者工具，所以我用 H5 预览做视觉回归：

```bash
npm run build:h5
node scripts/serve.mjs                 # 静态服务 → http://localhost:5199
node scripts/seed-ui.mjs > /tmp/seed.js  # 生成一段注入 localStorage 的演示数据
```

演示数据是一份「成都三日」行程：4 人、3 天、11 个安排、10 笔账，覆盖有数据 / 空态两种形态。

两个换页诀窍（不这么做会一直看到同一页）：
- 只改 URL 的 hash **不会**重载 SPA，需要 `location.reload()`；
- 但 `App.vue` 的 `onLaunch` 在有进行中行程时会 `reLaunch` 到行程页，
  所以**换页要用应用内跳转** `location.hash = '#/pages/Xxx'`（不 reload）。

---

## 五、交付清单

- **改动文件**：`src/styles/theme.css`、`src/styles/global.css`、`src/pages.json`、`src/components/`（AppNav / AppTabBar / AppSheet / AppEmpty）、`src/pages/`（Welcome / Itinerary / Expense / ExpenseEdit / Settle / Members / Profile / CityMap / Discover / Sync / TripCreate / TripGenerate / ItemEdit / Map）（共 19 个前端文件）
- **第二/三轮追加改动**：`src/styles/theme.css`（分类色板整段换）、`src/utils/format.ts`（`CANVAS_PALETTE` / `CANVAS_CATEGORY_COLORS` 两张镜像表 + `avatarInk`）、`src/utils/poster.ts`（配色对齐令牌 + 初始字墨色）、`src/components/PosterCanvas.vue`（H5/小程序双路径重写）、`src/components/AppAvatar.vue`（初始字墨色）、`src/pages/`（Settle / CityMap / Map / ExpenseEdit）
- **新增开发辅助**：`scripts/serve.mjs`（静态预览）、`scripts/seed-ui.mjs`（演示数据注入）、`scripts/check-palette.mjs`（色板体检）、`scripts/search-palette.mjs`（约束搜索）、`scripts/check-token-sync.mjs`（防漂移闸门，已进 `verify` 链）
- **视觉回归截图**：`shots-ios/`（16 个页面 + 记账页滚到底一张，用于核对悬浮按钮是否遮住末行）
- **文档**：README 新增「视觉规范（iOS 风格）」一节（含「四个容易踩的实现坑」）+ H5 构建故障的两种修法
- **后端**：`server/` 零改动

## 六、死代码清理（已做完）

改版时把渐变令牌「中性化成同色」保了一轮兼容，收尾时确认零引用后已彻底删除：

| 删除项 | 引用数 | 说明 |
|---|---|---|
| `--brand-grad` / `--brand-grad-soft` / `--accent-grad` / `--page-glow` | 全仓 0 | 渐变 + 顶部辉光，iOS 不需要 |
| `--shadow-brand` / `--shadow-soft` | 全仓 0 | 彩色 / 柔和投影，旧视觉残留 |
| `.grad-text` / `.eyebrow` | 全仓 0 | 品牌渐变标题 + 彩色小标签；模板、`:class` 绑定、`pages.json` 都查过 |

保留 `--shadow-lift`：只给结算页「分享海报预览图」用（浮起的图片带影是 iOS 的常规做法）。

> 扫描口径（改完 UI 顺手跑一遍）：
> ```bash
> grep -rn --exclude-dir=node_modules --exclude-dir=dist "var(--brand-grad)" .
> ```

## 七、第二轮：分类色板重挑 + 海报画布修复

改版交付时留了两条「需先做取舍」的尾巴，这一轮把它们做掉了，顺手牵出并修掉了一个
**静默 bug**（海报在 H5 上右侧 40% 被裁，不报错、只是图不对）。

### 1. 分类色板：从「凭手感」改成「可计算的约束问题」

原来的分类色板有三对**逐字节等于语义色**：

| 分类色 | 原值 | 撞的是谁 |
|---|---|---|
| `--cat-food` | `#E8714A` | `--accent`（强调色） |
| `--cat-ticket` | `#1FA470` | `--brand`（品牌绿，按钮/选中态） |
| `--cat-entertain` | `#C77E1A` | `--warn`（警告色） |

所以「门票」条形和主按钮是同一个绿。要换，先得把「色板好不好用」变成能算的东西：

- **距离用 CIE76 ΔE\*ab**。经验值：ΔE < 10 基本同色、10~25 要并排才分得清、> 25 才算独立色。
- **阈值不拍脑袋，拿苹果自家色板当标尺**：iOS 系统色里最挤的一对是 `blue ↔ indigo`
  ΔE = **19.6**，苹果自己都这么用 —— 于是把「分类色两两 ≥ 20」定成有依据的线。
- **对比度按 WCAG 1.4.11**（非文本/UI 组件 3:1）。注意苹果自己的 `systemBlue #007AFF`
  压白底只有 3.6:1，所以正文的 4.5:1 是比苹果更严的标准，这里不套用。

三条硬约束，在候选色池里**穷举**（不试色）：

| 约束 | 内容 | 结果 |
|---|---|---|
| C1 | 任一分类色 vs 任一语义色 ΔE ≥ 22 | 有解 |
| C2 | 分类色两两 ΔE ≥ 20 | 有解 |
| C3 | 同色压浅底对比度 ≥ 3.0:1 | 有解（实际最低 3.09） |

**无解时先诊断、别急着改别的**：C1 抬到 25 直接 0 组合。加 diag 输出才看清是两个结构性冲突 ——
① 餐饮只能待在暖色带，而那里已经挤着 `accent` h15 / `danger` h4 / `warn` h35；
② 把 `warn` 挪到黄色带（七种候选）也救不回 25，因为橙和鲑红色距天生就近。
**结论：语义色一个都不动**，把 C1 定在 22 —— 避免了一堆无谓的破坏性改动。

新色板（`--cat-ticket` 从品牌绿改成**青** h190，离品牌绿 h157 有 33°，是「不撞品牌绿」的最近可用点）：

| 分类 | 色值 | 浅底 |
|---|---|---|
| 餐饮 | `#E8590C` | `#FCEBE2` |
| 交通 | `#0B6BCB` | `#E2EDF9` |
| 住宿 | `#5856D6` | `#EBEBFA` |
| 门票 | `#0E8FA8` | `#E2F2F5` |
| 购物 | `#D6336C` | `#FAE7ED` |
| 娱乐 | `#9333C9` | `#F2E7F9` |
| 其他 | `#7A7A80` | `#EFEFF0` |

三项指标全面改善：**离最近语义色 0.0 → 22.0**、**两两最挤 21.9 → 26.0**、**最低对比度 2.38 → 3.09**。

> ⚠️ **门票不再是绿色，这是有意的语义变化**（绿色会被读成「品牌/成功」，不适合当分类色）。
> ⚠️ **不要把分类色当白字底**：最低 3.09:1 只够画 UI 组件线，`.bd-amt` 这类数字用 `--text-*`。
> ⚠️ `其他` 用中灰，对比度只有 3.71 —— 灰色没有色相可用，这是它的天花板。

### 2. 顺手修掉两个静默失败

- **canvas 的 `fillStyle` 不认识 `var()`**，非法值会被**静默忽略**（`fillStyle` 保持上一个值），
  结果是海报上所有分类圆点/条形变成同一个色。修法：新增 `CANVAS_CATEGORY_COLORS`
  字面值表，`SettlePage` 传色时改用它。
- **两套绿**：`#1D9E75`（海报/地图里那个「看着一样」的绿）与 `#1FA470`（品牌绿）并存，
  且「想去」在地图上用 `#D85A30`、在标签上用琥珀 `--warn`，两处不一致。全部收敛到 `CANVAS_PALETTE`。

### 3. 海报在 H5 上被静默裁掉 40%（本轮最难的一个）

**症状**：截图里标题「成都三日 · 吃与**走**」的「走」、日期尾部都没了。

**排查**：先量已知量，发现数据链自相矛盾 ——
组件内部读数 `domW: 750, sx: 1`（我刚写的值），而页面实测唯一的 canvas 是 `313 × 737`。
两个假设都被证伪：不是「框架事后重置」（手设 750 后跨 6 帧仍是 750），
也不是「查到了不同节点」（全页只有一个 canvas）。

**真因**（读 uni-h5 产物源码定位到，不在文档里）：uni 的 `<canvas>` 外壳里挂着 ResizeSensor，
布局一变就调内部 `wrapper()`：

```js
canvas.width  = canvas.offsetWidth  * pixelRatio
canvas.height = canvas.offsetHeight * pixelRatio
ctx.__hidpi__ = true                            // 之后所有绘制坐标内部再乘一次 pixelRatio
```

于是：我们写 750 → 立刻读回 750 → 算出 scale = 1 → 按 750 画进 313 宽的后备存储；
**下一帧** ResizeSensor 把尺寸改回 313（顺带清空）。41.7% 可见，正是观察到的 ~40%。

**修法**（`PosterCanvas.vue` 拆成 `renderMp` / `renderH5` 两条路径）：

1. 按 `.poster-wrap` **实测宽度**定 displayW/displayH —— 保证画布的 CSS 盒子比例 = 海报比例
   （原公式 `windowWidth - 32` 在桌面 H5 上不准：滚动条吃掉 15px，且 flex 还会把宽度收缩 328 → 313，
   比例一歪画面就被纵向拉伸）；
2. 等两拍，让 ResizeSensor 按新尺寸把后备存储重置完；
3. 按盒子实际尺寸推导缩放，在 **CSS 像素空间**作画；
4. 下一拍再验一次尺寸，若又被改过就重画一遍。全程**不写** `canvas.width/height`。

小程序端保持原样（`type="2d"` 拿到的就是真画布，宽高完全可控，导出全分辨率）。
实测结果：盒子 313 × 704，海报比例 2.2492 vs 2.248（差 0.05%，纯舍入）。

**顺带修好 H5 的「保存」**：uni 的 `saveImageToPhotosAlbum` 在 H5 上是**未实现**的 API
（就是一个 `createUnsupportedAsyncApi`），点了必然失败。改为按逻辑尺寸**离屏重绘**一份 2 倍图
再用浏览器下载：实测导出 **1500 × 3372 PNG**，六个分类色各不相同。

### 4. 金额输入去下划线

`.amount-row` 从「绿色下划线」改成**白块浮在灰页面上**。
⚠️ 不能用灰填充块：页面底色 `#F2F2F7` 与 `--bg-subtle #E9E9EB` 差不到 10 个色阶，
灰块会糊进背景（CityMapPage 空态踩过同一个坑）——**灰填充块只在白色卡片内部才成立**。

### 5. 新增三个可复跑的脚本

| 脚本 | 作用 |
|---|---|
| `scripts/check-palette.mjs`（`npm run palette:audit`） | 色板体检：ΔE / 两两距离 / 对比度，内置苹果系统色参照标尺，输出「现有 vs 候选」 |
| `scripts/search-palette.mjs`（`npm run palette:search`） | 约束搜索：C1/C2/C3 三轮扫描，穷举出可行色板 |
| `scripts/check-token-sync.mjs`（`npm run check:tokens`，**已进 `verify` 链**） | 防漂移闸门：`CANVAS_PALETTE` ↔ theme.css、`CANVAS_CATEGORY_COLORS` ↔ `--cat-*`（含反向）、`AVATAR_COLORS[0] == --brand`、全仓搜旧色值 |

> 写「全仓搜旧色值」这类检查时注意：**块注释的续行要按「行首是否像注释」判断**，
> 否则会把自己写的说明性注释（里面往往就引用了旧色值）误报成残留。
> `check-token-sync.mjs` 为此写了 `computeCommentLines()` 逐字符跨行跟踪 `/* … */`。

### 6. 本轮验证（全绿）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| `npm run check:tokens` | 通过（含 ⑤ 号「初始字不能写死白」断言） |
| `npm run build:h5` | DONE |
| `npm run build:mp-weixin` | DONE |
| `npm run wxss:lint` | 22/22 |
| `npm test`（全套冒烟） | server **313/0** · client **137/0** · city **56/0** · amap **17/0** |

逐页截图核对：Expense / ExpenseEdit / Settle / Profile / Members / Sync / CityMap / Discover /
Map（连同结算海报、导出图共 10 张）。

**小程序端产物静态核对**（canvas 属关键路径，而这里跑不了微信运行时，所以直接读产物）：

- `components/PosterCanvas.wxml` → `<canvas id type="2d" style="width/height">` 在，
  外层 `block wx:if="{{r0}}"` 是 uni 的约定 —— `vendor.js` 里对每个 page/component 都会
  `t.r0 = 1`（原生组件 canvas/textarea 都这么包），不是 bug；
- `components/PosterCanvas.js` → `.in(`（组件作用域查询）、`setTransform`、
  `canvasToTempFilePath` 都在；H5 分支代码虽被打进产物，但被 `typeof document !== 'undefined'` 挡住，端上不执行；
- `components/AppAvatar.js` / `utils/poster.js` → `avatarInk(...)` 都已生效。

## 八、第三轮：头像初始字的对比度（顺带量化了身份色）

上一轮把「头像身份色与分类色重叠」记成了待办。这一轮**先量再动手**，结果推翻了原本的假设：
真正的问题不在色相重叠，而在**初始字看不清**。

### 1. 实测：10 个身份色里 7 个压白字不达 AA

头像上的字是 `size × 0.42`（32px 头像 → **13px**），属 WCAG **小字**，要 **4.5:1**。
而 `AppAvatar.vue` 和海报都写死白字 —— 实测 3.18 ~ 3.93:1（最差是品牌绿 `#1FA470` 的 3.18:1）。
在手机上这就是「糊」，但**不报错**，跟海报裁切是同一类问题。

### 2. 修法：初始字颜色跟着底色走（`avatarInk`）

在「白」与「黑」里取对比度更高的那个。这不是随手写的 if —— 它有一条**与底色无关的下界**：

```
c白 = 1.05/(Y+0.05)   c黑 = (Y+0.05)/0.05
两者相等时 (Y+0.05)² = 1.05×0.05 → Y+0.05 = 0.2291 → 两边都是 4.58:1
```

也就是**不管以后往 `AVATAR_COLORS` 里塞什么颜色**，取较大者都必然 ≥ 4.58:1。
若改用 `#1C1C1E` 这种深灰，下界会掉到 4.11 —— 正好压线不过，所以这里必须是纯黑。

实测：最差 3.18:1 → **5.34:1，10 个全部过 AA**。落地在 `AppAvatar.vue`（DOM）
与 `poster.ts`（canvas）两处，并加了 `check:tokens` 的 ⑤ 号断言防止有人改回硬编码白。

### 3. 试过并否掉的方案（留个记录，别重复走）

「把 7 个偏浅的身份色压暗到白字过 AA」看起来更保值（白字才是头像的常规观感），
但算出来是**双输**：

| 方案 | 初始字对比度 | 身份色两两最挤 | `我 = 品牌绿` |
|---|---|---|---|
| 现状（写死白字） | 3.18:1 ✗ | 17.7 ✓ | 保持 ✓ |
| 墨色跟底色走（**采纳**） | **5.34:1** ✓ | 17.7 ✓ | 保持 ✓ |
| 压暗 7 个色 | 4.60:1 ✓ | **11.3 ✗ 变差** | **被破坏 ✗** |

压暗会把两个蓝挤到一起（`#1178C9` ↔ `#185FA5` ΔE 只剩 11.3，低于苹果自家最挤的 19.6），
而且「我」的绿会变成 `#008657`，不再是品牌绿 —— 为了修对比度去牺牲这套色板存在的理由（区分度）不划算。

### 4. 身份色的量化边界（不再靠感觉）

`npm run palette:audit` 现在会自动解析源文件并打印身份色体检（**审计脚本自身也会漂移**：
它第一版把「候选色板」写成了字面量，色板落地后脚本还停在旧提案上 —— 已改成解析
`theme.css` / `format.ts`，并注明「审计脚本一旦漂移比没有更糟」）：

- 两两最挤：`#378ADD ↔ #185FA5` ΔE = **17.7**（略低于苹果自家 19.6，但 > 10，列表里并排分得清）；
- 离最近语义/分类色 < 12 的只有三项：`#D85A30`(vs accent 9.5)、`#BA7517`(vs warn 4.8)、
  `#0F6E56`(vs brandDeep 6.0)，其中 `#1FA470 = 品牌绿` 是**有意的**（「我」= 品牌色）。

**结论口径**：头像永远是「实心圆 + 初始字」，分类色是「浅色圆角方 + 描边图标」，形状与位置都不同，
所以 ΔE < 20 不构成实际混淆 —— **不要为了数字好看把它们重挑成一堆深浊色**。

> ⚠️ 另一处**有意保留**的同类偏差：`.btn-primary` 是白字压品牌绿（3.18:1，15~16px），
> 低于 4.5:1 但符合苹果自家惯例（`systemBlue` 压白底也只有 3.6:1）。
> 按钮底色固定且字号更大，与头像（颜色按人变化、13px）性质不同，故不改品牌色。

## 九、第四轮：把「语义色当文字」这一整类问题收干净

第三轮只修了头像一个点（彩色底上写死白字）。这一轮把**同一类**扫完，
并且把它变成**闸门** —— 肉眼审不出这类问题，靠清单也修不完（第十处一定会漏）。

### 1. 根因：调色板只有「填充态」，没有「文字态」

`--brand` / `--accent` / `--warn` / `--danger` 都是照着**填充**设计的：条形、圆点、
整块按钮底，要鲜亮。它们的明度天生偏高，直接拿去做浅底上的小字就是「看得见、但费劲」：

| 令牌 | 当文字压白底 | 谁在用错 |
|---|---|---|
| `--brand` #1FA470 | **3.18:1** | `.btn-text`、`.tl-nav`、`.add-text`、`.fill-btn`、选中态 tab |
| `--accent` #E8714A | **3.05:1** | `.bal-net.minus`（应付金额）、`.tool-badge` |
| `--warn` #C77E1A | **3.27:1** | `.fp-tag.wish`、`.kv .val.off`、`.remain.warn`、`.stars` |
| `--danger` #E03B30 | **4.34:1** | 6 处红字 + `.btn-danger` 的白字底 |

注意 `--danger` 那一行：4.34 差 0.16 不到 4.5，**而且它同时担任两种角色**
（白底上的红字、白字按钮的底），两种都差一点 —— 最容易漏的就是这种「看着没问题」。

另外 `.bal-net.plus` 早就用了 `--brand-deep`，而兄弟选择器 `.bal-net.minus` 还在用
`--accent` 基色 —— 同一对「应收/应付」，一个修了一个没修。

### 2. 修法：`-deep` 按**最差底色**反推，不按好看挑

文字实际会落在白卡 / `--bg-page` / `--bg-subtle`(#E9E9EB) 三种浅底上，
取最深那个当界：`Y ≤ 0.14244`（= 0.866/4.5 − 0.05）。

| 令牌 | 新值 | 白 | 页面 | bg-subtle | 自身 soft |
|---|---|---|---|---|---|
| `--brand-deep` | `#15795A` → `#12724F` | 5.92 | 5.31 | 4.88 | 5.25 |
| `--accent-deep` | 新增 `#AB3D07` | 6.17 | 5.53 | 5.09 | 5.46 |
| `--warn-deep` | 新增 `#91590A` | 5.77 | 5.28 | 4.76 | 5.25 |
| `--danger` | `#E03B30` → `#B01F16` | 6.88 | 6.16 | 5.67 | 6.01 |

`--brand-deep` 原来压 `bg-subtle` 只有 4.42:1。当前没有一处这么用，
但「-deep 在任何浅底上都安全」这条不变式值得是真的，所以一起压深了。

`--danger` 取 `#B01F16` 还顺手解决了另一件事：它和「餐饮」的 ΔE 从 21.9 抬到 **27.7**，
把分类色/语义色那个 22 的约束线解开了（原来正卡在线上）。

### 3. 分类色：不新增 7 个 `-deep`，而是**结构上限制用途**

分类色最低只有 3.09:1（`--cat-food` 压 `--cat-food-bg`），只够 WCAG 1.4.11 的
图形/UI 组件线。记账页的分类块原来是
`:style="{ background: bg, color: color }"` 挂在**按钮**上 —— 12px 的标签跟着一起被染色。

试算过「给每个分类也配一套 `-deep`」，**否掉了**：
压暗到能过 4.5:1 之后，餐饮的 `#B9470A` 和 `--accent-deep` `#AB3D07` 的 ΔE 只有 **3.9**，
等于让分类色变成「应付」的橙 —— 正是这套色板当初（`--cat-ticket == --brand`）要防的事。
暖色带里塞不下第二个「深橙」，和第 1 条是同一个物理限制。

**改成结构性约束**：分类色只挂在图标 `<span class="cat-ic">` 上（图标是 SVG，图形，3:1 线），
标签 `.cat-label` 走 `--text-primary`（13.95:1）。选中态由「浅底 + 图标上色 + 标签变深」三处叠加表明。

### 4. 顺带修掉三处闸门自己抓出来的（我手查时漏了）

| 位置 | 原状 | 修后 |
|---|---|---|
| `AppSheet .close-btn` | `--text-tertiary` 压 `--bg-subtle` **2.25:1** —— 里面是 SVG 的 ×，连图形线 3:1 都不过 | `--text-secondary` → 4.69:1 |
| `global.css .btn-primary[disabled]` | `--text-tertiary` 压 `--bg-sunken` **2.14:1** | `--text-secondary` → 4.45:1 |
| `ExpenseEditPage .key.save[disabled]` | 白字压 `--line-strong` **1.52:1** —— 那是**分隔线**的颜色被当底用 | `--text-secondary` → 3.74:1 |

前两处的结论可以记成一条规则：**禁用态用灰底表示「按不动」，但标签不能跟着变没** ——
`--text-tertiary` 压灰底只有 ~2.2:1，那不是禁用，是坏了。

### 5. 海报：品牌带压深 + 去掉半透明白

海报是发出去的、会被压图、会在手机上缩到 1/4 看，比 App 内更不该有「费劲」的字。
原来带底是 `P.brand` + 三处半透明白（0.78 / 0.86 / 0.92）：

| | 原 | 现 |
|---|---|---|
| 带底 | `--brand` `#1FA470` | `--brand-deep` `#12724F` |
| 带上的字 | 半透明白 → 实测 **2.51 ~ 2.92:1** | 实白 → **5.92:1** |

半透明会把白往绿里拉，是本来最糊的一批。负额金额也顺带从 `P.accent`(3.05) 换成
`P.accentDeep`(6.17)，「→」从 `P.brand`(3.18) 换成 `P.brandDeep`(5.92)。
导出仍是 **1500 × 3372**，尺寸未变。

### 6. 新增闸门：`npm run contrast:audit`

`scripts/check-contrast.mjs`（零依赖）五项断言：

1. **①** 每个同时声明 `color` + `background` 的 CSS 规则逐条算对比度。
   阈值：正文 4.5、大字（≥24px，或 ≥18.66px 加粗）3.0。
   实心控件（白字压语义色底）与 `[disabled]` 按 3.0 记「△ 已知取舍」（Apple 自家
   `systemBlue` 按钮也只有 3.6:1；inactive 组件 WCAG 1.4.3 豁免）。
2. **②** 源码里不得出现 `color: var(--brand|--accent|--warn)`（唯一例外：`.nav-icon`，里面是 SVG）。
3. **③** `-deep` / `--danger` 令牌自检（压三种浅底 + 自身 soft ≥ 4.5）。
4. **④** 分类色不得挂在**含文字**的元素上 —— 靠内联 style 上来的颜色 ① 看不到，
   所以单独做一条模板级检查（看 `color: CATEGORY_META[...]` 后面的元素里有没有 `{{ }}`）。
5. **⑤** 只报告不判失败：`--text-tertiary` 的全部用法（本轮结束时 70 处 —— 数量会随代码变化，
   **以脚本输出为准**），并说明为什么它是**有意的层级取舍**而不是 bug（见下）。

### 7. 两处**有意保留**，都写进了 README 的「已知取舍」

- **实心按钮的白字是 3.18:1**（`.btn-primary` / `.chip.active` / `.key.save` / `.dur.active`）。
  要抬到 4.5 得把品牌绿压到 `--brand-deep` 那么深，按钮就没鲜亮度了。苹果自己也是 3.6:1。
- **`--text-tertiary` 过不了 AA**（压白底 2.73:1），这不是配错色，是**数学上不可能**：
  要在白底上过 4.5，文字明度得压到 `Y ≤ 0.183`，而 `--text-secondary` 已经是 0.135 ——
  三级灰合格所需的三个点排不下。Apple 自己的 `tertiaryLabel` 更浅（≈1.9:1）。
  它现在 70 处用法（数量以 `contrast:audit` 的输出为准；其中 `.tab` 的**未选中态**是有意
  留在 tertiary 里的），`contrast:audit` 全量登记。

  一条**反例**，说明为什么不能「顺手续调亮」：底部 tab 的未选中态若提到 `--text-secondary`
  （5.7:1），它的明度 `Y = 0.135` 会和选中态 `--brand-deep` 的 `Y = 0.127` **几乎相同** ——
  选中/未选中只剩色相可辨，可用性反而下降。所以未选中保持 tertiary 靠「绿 vs 灰」区分，
  选中态压深到 `brand-deep` 保住文字可读（3.18 → 5.92）。
  这两个明度由 `contrast:audit` 第五节末尾重算并打印（当前差 0.00726）—— 前提若变会直接提示。

### 8. 本轮验证（全绿）

```
typecheck        0 错
check:tokens     通过（6 项，新增第 ⑥ 项：海报品牌带底必须是 brandDeep、且无半透明白字）
contrast:audit   通过（44 条 color+background 配对；2 处内联分类色只作用于图标）
palette:audit    ① 语义色距离 22.0 → 23.5  ② 两两 25.9  ③ 最低对比度 3.09  ⑤ -deep 最差 4.76
build:h5         DONE（1500 × 3372 导出复核）
build:mp-weixin  DONE
wxss:lint        22/22
npm test         server 340 / client 149 / city 56 / amap 17　全部 0 失败
```

> 构建小坑：`build:h5` 会清 `dist/build/h5/assets`（139 个文件），
> 触发环境的批量删除保护（阈值 50）。这是构建产物的正常重建，
> 只对这条命令放宽阈值即可（`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=2000 npm run build:h5`），
> 不用改全局配置。

## 十、第五轮：地图 `callout` / `label` —— 这一类「闸门看不见」的地方

第四轮把 CSS 里的颜色收干净了，但有一处**同一类问题**始终没进闸门：微信原生 `<map>` 的
`callout.color` / `label.color`。它们是**运行时 JS 常量**，不经过 CSS —— ① 只读 CSS 规则，
完全看不到（和 ④ 那个「内联 style 来的分类色」是同一个盲区）。

| 位置 | 原来 | 问题 |
|---|---|---|
| `CityMapPage.vue` `callout` | `color: '#FFFFFF'`，底 `--brand`(#1FA470) 或 `--warn`(#C77E1A) | 白字 3.18 / 3.27:1，而 `content` 是 **12px 城市名**（正文，要 4.5） |
| `MapPage.vue` `label` | `color: '#FFFFFF'`，底 `CANVAS_PALETTE.brand` | 白字 3.18:1；它是压在色块上的**序号**，没必要卡在 1.4.11 的 3:1 线上 |

修法与头像同源：**按底色取墨色**，直接复用现成的 `avatarInk()`。两个底色（Y = 0.280 / 0.271）
都过了黑白的交叉点（`Y ≥ 0.1791`），所以都给黑字 —— **6.60:1 / 6.43:1**。

**底色没动**，这是有意的：`bgColor` 必须和 marker 图标同色（本节上方的注释写过，
原来就是为了消掉「同一个绿两块色差」），所以只能改文字色。

### 为什么值得单独记一节：⑥ 这个新闸门差点是假的

新加 ⑥ 时我写了两条断言。第二条是「`avatarInk` 对 `CANVAS_PALETTE` 里每个底色都要 ≥ 4.5:1」，
打印 ✓ 之后我做了**证伪测试**：把 `avatarInk` 的实现改成 `return '#FFFFFF'` ——
**闸门依然全绿**。原因是那段代码**自己重算了一遍 avatarInk 的数学**，验证的是「这个性质」，
不是「`format.ts` 里那行字」。

补上一条**结构断言**（函数体里必须同时出现黑与白两个返回值、且必须基于 `relLuminance(bg)`）
之后，同一个破坏立刻被抓住（`黑=false` → ✗）。

> **教训：闸门必须被证伪过一次才算数。** 写完闸门后故意把被保护的东西弄坏，
> 确认它会红 —— 否则你守的可能只是自己写的一段复述。

⑥ 现在输出：
```
✓ 2 处 map callout/label 的 color 都走 avatarInk（没有写死白/黑）
✓ avatarInk 对 CANVAS_PALETTE 全部 13 个底色都 ≥ 4.5:1（最差 textSecondary #66666E → #FFFFFF 5.69:1）
✓ avatarInk 的实现仍是 relLuminance(底色) → 黑白二选一（与底色无关的下界 4.58:1）
```

三次证伪测试都做了：① 把 `MapPage` 的 `color` 改回 `'#FFFFFF'` → ✗；② 把 `avatarInk`
改成固定返回白 → ✗；③ 见下一节（marker PNG）。之后恢复，探针残留检查 clean。

### 附带发现：同一类里还有一处 —— marker PNG 的像素色

查「凡是颜色不进 CSS 就没闸门守」时把剩下的来源排了一遍：`pages.json` 的
`globalStyle.navigationBarBackgroundColor` / `backgroundColor` 是 `#F2F2F7`（= `--bg-page`，
目前一致，但只靠人眼维持）；源码里没有运行时的 `setNavigationBarColor` 调用。
真正出问题的是**位图** —— `scripts/gen-markers.mjs` 里写死了两个 RGB：

```js
makeMarker([29, 158, 117])   // #1D9E75 ← 旧品牌绿
makeMarker([216, 90, 48])    // #D85A30 ← 旧「想去」橙红
```

而 `CityMapPage.vue` 的标签侧早就改成了 `CANVAS_PALETTE.brand` / `.warn` ——
那句「同一个绿有两块色差」的注释**指的就是这里**，但当时只修了标签侧。把 PNG 解开量了一下：

| 状态 | PNG 实心色 | 标签 `bgColor` | ΔE |
|---|---|---|---|
| 去过 | `#1D9E75` | `#1FA470` | **6.6** |
| 想去 | `#D85A30`（橙红） | `#C77E1A`（琥珀） | **29.2** |

29.2 比本项目分类色两两的阈值 20 还远 —— 同一个「想去」在地图上出现了两个差得比不同分类色
还远的颜色。

**为什么 ④（全仓搜旧色值）没抓到**：④ 只读 `.ts/.vue/.css/.json` 文本，而 `#1D9E75`
在 PNG 里是**字节**，永远不会以那个字符串形式出现。它甚至就躺在 `DEAD` 数组里 ——
闸门宣称它「不该出现」，却看不见它活着的那个地方。

修法：

- `gen-markers.mjs` 改成**从 `theme.css` 解析** `--brand` / `--warn`（解析不到就抛错）；
- **两个副本目录一起写**（`static/` 与 `src/assets/`）—— 以前是生成到 `static/` 再手动拷过去，
  手动一步就是漂移机会；
- 新增 `npm run markers` 作为入口；
- `check:tokens` 新增 **⑦**：把 PNG **解开读中心像素**，断言等于 `CANVAS_PALETTE` 对应值、
  且两个副本像素必须一致 —— 脚本对、但 PNG 忘了重新生成，同样应该红。

⑦ 也做了证伪：把生成脚本临时改回 `#1D9E75` 并重新生成 → 两处都 ✗（退出码 1）；恢复后 ✓。

顺带把**最后一层**也闭合：`pages.json` 的 `globalStyle.navigationBarBackgroundColor` /
`backgroundColor` 是 `#F2F2F7`（= `--bg-page`），此前只靠人眼维持一致 —— 加 **⑧** 断言。
证伪：把它改成 `#F2F2F6`（只差 1 个 hex 字符）→ ✗，恢复 → ✓。

至此这个盲区排完了，一共六层（按被收服的顺序）：
**CSS 变量 → canvas 字面值 → 内联 style / JS 常量 → 原生组件属性 → 位图资源 → 平台配置**。

### 验证

```
typecheck        0 错
check:tokens     通过（8 项，新增 ⑦ marker PNG 像素 + ⑧ pages.json 底色）
contrast:audit   通过（新增 ⑥：map callout/label + avatarInk 机制）
build:mp-weixin  DONE
build:h5         DONE
wxss:lint        22/22
city:smoke       56 通过 / 0 失败
```

产物核对（`dist/build/mp-weixin`）：
```
CityMapPage  callout:{content:e.name,color:i.avatarInk(a),fontSize:12,bgColor:a,...}
MapPage      label:{content:String(a+1),color:n.avatarInk(n.CANVAS_PALETTE.brand),bgColor:n.CANVAS_PALETTE.brand,...}
```
`color` 与 `bgColor` 同源，不再有写死的 `'#FFFFFF'`。

H5 端地图是白面板，所以这处**只能真机 / 小程序端肉眼确认** —— 但也正因为看不见，
更不该让它停在「写死白字」上。

## 十一、第六轮：把「运行时体检」当交叉验证 —— 它反过来抓到两处

前几轮的闸门都是「读源码算颜色」。这一轮换个方向：把 H5 起来 + `agent-browser`，
拿 8 个页面逐页跑**运行时**体检（`getComputedStyle` + 向上找真实底色 + 只看元素自己的
文字节点 + 阈值随字号走）。它不是要替代静态闸门 —— 两者盲区不同，正是这一点让它有价值。

结果分两半：

**好的一半**：八个页面里「低于 3.0」的项**全部**是 `--text-tertiary` 家族（有意保留，见第九节），
非 tertiary 项 = **0**。

**有用的一半**：它顺手量出两处**静态闸门结构上看不见**的真缺陷。

| 位置 | 问题 | 静态闸门为什么看不见 | 修法 | 实测 |
|---|---|---|---|---|
| `ExpensePage .dot-sep` | `color: var(--line-strong)` → **1.52:1** | ① 只算「**同一条规则里**同时声明 color 和 background」的配对；这条规则**只声明了 color**，底色来自白卡祖先 | 改 `--text-tertiary`（与左右两个字同一级灰，读起来是连续的） | `rgb(156,156,161)` = 2.73:1 |
| 全局 `button[disabled]` | 落到 uni 内置的 `#F7F7F7` 底 + `rgba(0,0,0,.3)` 字 = **2.1:1** | 禁用态是被**框架样式盖出来的**，元素自己没声明 background | `global.css` 加全局兜底 | `#66666E` on `#E3E3E8` = 4.45:1 |

### 「逐个按钮补 `[disabled]`」这条路是怎么被证伪的

补了 5 处（`.btn-primary` / `.key.save` / `.ma` / `.tool` / `.demo-btn`）之后，
运行时体检**仍在** MembersPage 的「添加」按钮上量到 2.1:1 —— 因为那个按钮压根没写 `[disabled]`。
只要有一个按钮忘了，就退回 2.1:1；这种「靠记得」的覆盖法必然留着缺口，所以改成全局兜底。

### 特异性这一课（第一版兜底为什么无效，以及后来发现的反转）

- 第一版写的是 `button[disabled], uni-button[disabled]` = **0,1,1** → 输给 uni 的
  `uni-button[disabled][type="default"], uni-button[disabled]:not([type])`（**0,2,1**）。
  实测仍是 `rgb(247,247,247)`，一点没生效。
- 改成把「有 type / 无 type」两组都列全（0,2,1），且本文件在 uni 的样式之后加载 → 赢。
- **反转**：页面自己的 scoped 规则更高。`.key.save[disabled]` 编译后是
  `.key.save[disabled][data-v-de0df97c]` = **0,3,0**，高于兜底 —— 所以那个按钮的
  禁用底色一直是 `--line-strong`，兜底根本没碰到它。
  这一条我是**先推理错、后被实测纠正**的（原以为兜底会覆盖它）；
  实测 `bg = rgb(209,209,214)` 才说明真相。顺手把它也统一到 `--bg-sunken`（3.74 → 4.45），
  让「禁用态只有一种样子」成立。

换句话说：**兜底只替「没写 `[disabled]` 的按钮」收尾**；写了的以本文件为准。
两条腿都要有 —— 否则就会出现「有的按钮 4.45、有的按钮 3.74、有的 2.1」这种三档禁用态。

### 顺带发现：H5 构建会把 `button` 改写成 `uni-button`

实测 `document.styleSheets` 里我们那条兜底只剩 `uni-button[disabled][...]` 两段 ——
`button[disabled][type="default"], button[disabled]:not([type])` 被构建改掉了。
所以源码里「两套写法都列上」不是重复，是**各自负责一个平台**（H5 用 `uni-button`，
mp-weixin 用原生 `button`；微信端无法运行时验证，那里的 per-file `[disabled]` 规则就是第二道保险）。

### 新增闸门 ⑦（`contrast:audit` 第六条）

```
⑦ a) 源码里不得出现 `color: var(--line-strong)` —— 它是分隔线的颜色，压白卡 1.52:1
     （已抓到三次同一令牌的误用：当 `[disabled]` 按钮的底 → 当 `.dot-sep` 的正文色 → 当未选中星标色）
   b) global.css 的**全局禁用兜底**必须存在：选择器要含 `:not([type])` 或 `[type="default"]`、
      算得出 ≥ 3.0:1、且**不许**写 opacity（`.ma`/`.tool`/`.demo-btn` 用 opacity 表达禁用）
   c) 所有 `[disabled]` 规则的配色统一到 `--bg-sunken` + `--text-secondary`
```

⑦ **逐条证伪过**（每条都要确认会红、退出码 1，再恢复）：

| 故意破坏 | 结果 |
|---|---|
| `.star` 改回 `var(--line-strong)` | ✗ 1 处（`CityMapPage.vue:677 .star`） |
| `.key.save[disabled]` 底色改回 `var(--line-strong)` | ✗ 1 处（`ExpenseEditPage.vue:883`） |
| 兜底选择器降级成 `button[disabled], uni-button[disabled]` | ✗ 1 处（「全局禁用兜底不见了」） |
| 往兜底里塞 `opacity: 0.5` | ✗ 1 处 |

### 一个「不写进文档」的数

禁用态标准 `--bg-sunken` + `--text-secondary` = **4.45:1**，差 0.05 不到 AA；
换成 `--bg-subtle` 是 **4.69:1**。这两个数都由脚本算出来打印（跟着令牌走），**不抄进这里**。
仍然不换：`--bg-sunken` 才是「按下 / 禁用」的语义槽位，且 1.4.3 与 1.4.11 对 inactive 组件双双豁免
—— 这条守的是「别退回 2.1:1」，不是「过 AA」。

### 验证

```
typecheck        0 错
check:tokens     通过（8 项）
contrast:audit   通过（45 条配对 + 六类断言）
build:mp-weixin  DONE
build:h5         DONE
wxss:lint        22/22
npm test         server 340 · client 149 · city 56 · amap 17 —— 0 失败
```

## 十二、第七轮：属性里的颜色 + 旧色值的第二种拼写

第六轮是「运行时反过来喂静态闸门」。这一轮是把喂进来的东西固化成断言，顺带又扫出两层新盲区
—— 都不是靠体检，是靠**问「还有什么写法是这个闸门读不到的」**。

### 1) `<AppIcon color="…">` —— 属性色，① 和 ② 都读不到

`AppIcon` 的颜色是**属性**，不是 CSS 规则：

- ① 只算「同一条规则里同时有 color + background」的配对 → 读不到；
- ② 只找 `color: var(--brand)` 这种**CSS 写法** → 也读不到。

于是全仓 `var(--brand)` ×11、`var(--danger)` ×3、`var(--text-tertiary)` ×18、`#fff` ×6
一条都没被读过。更值得记的是：② 里的允许清单 `ICON_ALLOW = ['.nav-icon']` 是**照着 CSS 写法拟的**，
跟这些图标的真实来源（模板属性）根本不是同一批 —— 清单在守一个几乎不存在的地方。

**顺手量出的真话**：② 那句「图标属图形，1.4.11 只要 3:1」在本项目**站不住**：

| 图标色 | 白卡 | 页面底 | bg-subtle | 自己的 -soft |
|---|---|---|---|---|
| `--brand` | 3.18 | **2.85** | **2.62** | `--brand-soft` **2.82** |
| `--text-tertiary` | **2.73** | **2.45** | **2.25** | — |
| `--brand-deep` | 5.92 | 5.31 | 4.88 | — |
| `--danger` | 6.88 | 6.16 | 5.67 | `--danger-soft` 6.01 |

`.nav-icon` 的底色就是页面底 → 品牌色箭头 **2.85:1**，`.tool-icon`（底是 `--brand-soft`）
里的图标 **2.82:1**。**有意保留**（把品牌绿压成 `-deep` 会丢掉「绿色 = 可点」这个视觉语言，
Apple 自家 tint 图标也在 3:1 附近），但**不能写成达标** —— 所以把 ② 的注释改成了实话，
并让 ⑧ 把这些数算出来打印。

新增闸门 **⑧**：`AppIcon` 的属性色只判两种硬错 —— 裸色值（`#fff` 除外）、
`var()` 指向不存在的令牌；其余按「图形 3:1」把每个色的实测值和使用次数打出来（< 3.0 标 △）。

> ⚠️ **⑧ 差点又是个假闸门**：第一版把「裸 hex」落进了 `dynamic` 分支（当成「动态表达式，
> 静态算不了」直接放过）—— 断言声称拒裸色值，实际一个都拒不了。
> 证伪时才发现：故意把 `color="var(--brand)"` 改成 `color="#1FA470"`，它照样全绿。
> 判据要写细：`/^#[0-9A-Fa-f]{3,8}$/` 才算裸色值，`c.color` 这种标识符才是动态。

### 2) 同一个旧色值有第二种拼写

`check:tokens` 的 ④（「源码里不该再有旧色值」）只认**十六进制**。于是旧米色
`#F8F7F4` 以 `rgba(248, 247, 244, 0)` 的形式活在**三处滚动渐变的透明端**里：

```css
background: linear-gradient(to top, var(--bg-page) 72%, rgba(248, 247, 244, 0));
```

它肉眼几乎看不出来（两端都是近白），但它就是旧视觉的残留 —— 而且**十六进制搜索永远扫不到它**。
给 ④ 加上「分量形式」的正则之后，**当场报出这 3 处**（这一次的证伪是天然的：
先加扫描、后修，红→绿）。现在每个 DEAD 值都有 `#RRGGBB` 和 `rgb(r, g, b)` 两种匹配。

顺带把旧 `--brand-deep` `#15795A` 也加进 DEAD —— 它和 `#1D9E75` 同一性质：**「另一个绿」**。

### 3) 海报里最后一个手写色值，以及「一个令牌两个角色」

`poster.ts` 里散着 4 处 `ctx.fillStyle = '#FFFFFF'`。值上等于 `bgCard`，看着无害，
但 `--bg-card` 一变它们就成了新的漂移源。**「恰好相等」不是理由，唯一来源才是。**
改法：全部走 `P.xxx`，并加断言「这个文件里不许出现手写颜色字面量」。

改的过程中发现另一件事：品牌带上的白字用的是 `P.bgCard`（**卡片底**的角色）。
两者今天同为 `#FFFFFF`，所以不影响观感 —— 但角色不同。加了 `textInverse` 这一项
（`--text-inverse`），品牌带的 5 处文字改用它，`check:tokens` 的 ⑥ 断言「不许借 `bgCard` 当白字」。

> 这和 CSS 里的 `--line-strong` 是**同一类错误**：一个令牌担两个角色。
> 表现上「现在没问题」，风险是「改一个牵动另一个，而且没人报警」。

### 另一个「过期快照」

`poster.ts` 品牌带的注释写着「底 = brandDeep `#15795A` → 白字 5.37:1」——
**值和结论双错**：令牌早已是 `#12724F`，白字压它是 5.92:1（⑥ 每次算出来打印）。
按规矩改成「别在这儿写数字」，只留结论。

### 验证

```
check:tokens     通过（8 项；④ 现在两种拼写都扫，⑥ 多两条：文字色角色 + 无手写字面量）
contrast:audit   通过（45 条配对 + 七类断言；⑧ 报告图标属性色）
build:mp-weixin  DONE
build:h5         DONE
wxss:lint        22/22
npm test         server 340 · client 149 · city 56 · amap 17 —— 0 失败
```

证伪记录：④ 分量形式（天然红→绿，3 处）· ⑥ 手写字面量（✗ 8 处）·
⑥ 品牌带借 `bgCard`（✗ 1 处）· ⑧ 裸色值（✗ 2 处，退出码 1）。全部恢复后复跑通过。

## 十三、第八轮：色板约束终于有闸门了；以及一个横跨三个脚本的假绿灯

前七轮都在问「**颜色**还有什么来源在闸门视野之外」：CSS 变量 → canvas 字面值表 → 内联 style →
原生组件属性 → 位图资源 → 平台配置文件 → 模板属性。这一轮把问题转向**审计脚本自己**。

### 1) 起点：`palette:audit` 只打印，不判定，也不在链里

它的输出一直很漂亮 —— iOS 系统色的参照标尺、历史 vs 当前的对比、七行分类色网格。
但读完 `checkSemantic` / `checkPairwise` / `checkContrast` / `checkInk` / `checkIdentity` 后发现：
它们**全部只有 `console.log`**，返回的 `worst.d` 只被用于「历史 vs 当前」那个对比行，
脚本里**没有一个 `process.exit`**；而 `package.json` 的 `verify` 是

```
vue-tsc && check-token-sync && check-contrast && build -p mp-weixin && lint-wxss && city-smoke-test
```

—— 没有 `palette:audit`。也就是说：把 `--cat-food` 改成 `--accent` 的值，
`check:tokens` 的 ② 照过（两边同值就算过关），而分类色的 ΔE 约束被打破，**没有任何东西报警**。

这和第三轮那个「不在校验链里的审计脚本」是同一个坑：**一份没人看的报告比没有更糟**，
因为它的存在会让人以为那里有保护。

补判定时按文档口径取三个阈值（两两 ΔE ≥ 20 / vs 语义色 ≥ 22 / 压同色浅底 ≥ 3.0:1，
与 `search-palette.mjs` 同一套；网格上标的 ⚠ 用 25，那只是自我提醒的余量），
**身份色（头像）只报告不判** —— 它的 ΔE 是有意放宽的（`[0]` 就是品牌色本身），
拉进来判会逼着去重挑一套更难看的身肤色，属于「为了数字好看而变差」。

对比度那一项离阈值很近（3.09 vs 3.0），所以它**打印两位小数**，否则「刚好擦线」会被四舍五入藏起来。

### 2) 我在脚本里写了一句假话，而且是同一轮发现的

判定块的输出里我写了：

```js
console.log('\n\n############ 判定（会返回非 0，已进 verify 链） ############')
```

可 `package.json` **那时还没改**。这正是这几轮一直在治的病（「文档只写结论，别写没发生的事」），
所以顺序上先把链改了、再跑，而不是反过来。

### 3) 换问法：这个闸门读的是**哪一种写法**？

闸门接进链里之后，问题变成：它真的读得到我改的东西吗？`check-palette.mjs` 的颜色**全部**来自：

```js
src.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)   // 只认十六进制
```

而分类色是**带回退值**的：

```js
LIVE[k] = { color: VARS[`--cat-${k}`] || '#000000', bg: VARS[`--cat-${k}-bg`] || '#FFFFFF' }
```

于是 `--cat-food: rgb(232, 89, 12);`（**＝ `#E8590C`，视觉上一模一样**）解析不到 → 回退成纯黑。
实测结果：

```
餐饮  #000000 (h0)    78   56   86   87   80      ← 本该是 #E8590C (h24)
→ 最接近：门票 ↔ 品牌深绿  ΔE=38.5  ✓ 通过        ← 真实值是 23.5
✓ 分类色 vs 语义色 ΔE：38.5（要求 ≥ 22）
✓ 分类色压同色浅底的最差对比度：3.31:1（要求 ≥ 3:1）
EXIT=0
```

**三项数字全部变好看**，因为黑离谁都远。真实越界会被这份「更好的报告」盖过去。
这比漏检更危险：漏检只是没发现，这是**主动给出更好看的错数**。

### 4) 同一份正则，在对比度闸门里是另一种静默

`check-contrast.mjs` 里是同一份 hex 正则，但它的失败姿态不同：

```js
const bg = resolve(bgRaw)
const fg = resolve(colorRaw, bg || '#FFFFFF')
if (!bg || !fg) continue        // ← 解析不了就丢掉这一对
```

断言写的是「**已参检的**配对全部达标」，所以「配对数缩水」是唯一能让它悄悄放水的路径。
实测把 `--text-primary` 写成 `rgb(28, 28, 30)`：

```
✓ 37 条「color + background」配对全部达标（其中 11 条按 3:1 记取舍）
对比度闸门通过：配对达标、语义色未误当文字、-deep 无条件过 AA、禁用态统一、图标属性色可解析
EXIT=0
```

45 条 → **37 条**，8 条凭空消失，而输出仍写「全部达标」。`--text-primary` 是**正文墨色的主令牌**
—— 消失的恰好是正文那批配对。

**而且这是撞运气。** 52 个令牌里只有 6 个被 `TOKENS['--x']` 直接解引用
（`--bg-page` / `--bg-subtle` / `--text-secondary` / `--text-tertiary` / `--brand-deep` / `--line-strong`）：

| 换写法的令牌 | 实际表现 |
|---|---|
| 那 6 个之一（如 `--text-secondary`） | 抛 `TypeError: Cannot read properties of undefined (reading 'replace')`。退出码是 1，但诊断信息是**零** —— 堆栈指向 `hex.replace`，没人看得出该改哪儿；而且 ① 已经先报了「32 条配对全部达标」 |
| 另外 **46 个**（如 `--text-primary`） | **干净的假绿灯**：EXIT=0，报「全部达标」 |

### 5) 修法：一份共用解析 + 解析覆盖率硬失败

把解析抽到 `scripts/lib/theme-tokens.mjs`，**三个闸门共用一份**。
这不是洁癖 —— 这个项目已经栽过两次「同一份东西散在多处、各漂各的」
（`check-palette.mjs` 的历史基线快照、`SEMANTIC` 的字面量快照），
而同一份 hex 正则各写一遍正是同一个隐患的第三次现身。

判定口径：

- 松扫描拿到 theme.css 里**所有** `--x: <值>;` 声明，紧解析只收十六进制，两者做差；
- 差集里的值**不透明**（`rgb(r,g,b)` / `hsl()` / 色名）→ **硬失败**。它明明可以写成 hex；
- 差集里的值**带 alpha**（`rgba(...)` / `hsla(...)`）→ **放行但记账**。半透明表达不了成 hex，
  `--hairline: rgba(60, 60, 67, 0.1)` 的 alpha 本身就是信息。**注意这一类的配对确实不参与体检**，
  覆盖率行就是让这件事看得见。

> 这里踩过一个小坑：第一版 `HAS_ALPHA` 写成 `/^rgba?\([^)]*,\s*[\d.]+\s*\)$/`，
> 而 `rgb(102,102,110)` **也能匹配**它（`[^)]*` 贪婪回退）——
> 于是「带 alpha 所以放行」这条豁免会把本次要治的病原样放过。
> 必须**要求第 4 个分量**：`/^rgba\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*\)$/`。

另外两条可见性：

- ① 报告头打**解析覆盖率行**：`theme.css 52 条声明，32 条参检；2 条带 alpha 未参检 —— --hairline(=…)、--hairline-strong(=…)`；
- ① 把「有 `color` + `background` 但解析不出实色因而没参检」的规则**逐条列出**
  （渐变 / 半透明 / 多重背景是正常原因，但必须看得见）。实测立刻印出 3 条。

还加了**令牌依赖清单**（`assertRequired`）。它防的是与「换写法」**不同**的一种情况：
令牌被整个删掉 —— 那时文件里连声明都没有，松扫描天然抓不到。

### 6) 判据必须证伪，这次四次

| # | 动作 | 预期 | 实测 |
|---|---|---|---|
| 1 | `--cat-food: rgb(232, 89, 12)` | 色板体检硬失败 | ✗ **（修之前 EXIT=0，假绿）** → 修后 `✗ 色板体检无法开始` EXIT=1 |
| 2 | `--text-primary: rgb(28, 28, 30)` | 三个闸门全硬失败 | 修前 EXIT=0；修后三个都 `✗ …无法开始：theme.css 里有颜色令牌换了写法` EXIT=1 |
| 3 | 删掉 `--text-secondary` 的**声明**（引用还在） | 依赖清单拦下 | `✗ …缺少本闸门依赖的令牌  --text-secondary`，两个闸门都 EXIT=1 |
| 4 | 全部恢复 | 三个都绿 | EXIT=0 ×3，覆盖率行正常 |

第 3 条有个细节值得记：文件里 `var(--text-secondary)` 的**引用**还在，
所以「这个字符串出现了吗」这种检查会误判成「还在」—— 依赖清单看的是**声明**，不是引用。

### 7) 顺手清掉四个过期数字

README 里写着「后端 313 项 / 客户端 137 项 / 城市足迹专项 41 项断言」、「tertiary 70 处」——
实际是 **340 / 149 / 56 / 72**。这和第十一轮海报注释里那个「`#15795A` / 5.37:1」的过期快照是同一类：
**会随代码变化的数字，写进文档就是下一个谎**。四处全改成「以脚本输出为准」。
其中「tertiary 70 处」那句本来已经写了「以脚本输出为准」，却在同一个括号里补了个具体数字
—— 规则和例外在同一个括号里打架，等于没有规则。

### 验证

```
verify           EXIT=0（链：vue-tsc → check:tokens → contrast:audit → palette:audit
                        → build:mp-weixin → wxss:lint → city:smoke）
check:palette    通过（分类色 23.5 / 25.9 / 3.09:1；三条约束都在）
contrast:audit   通过（45 条配对 + 七类断言 + 输入校验）
build:mp-weixin  DONE
build:h5         DONE
wxss:lint        22/22
npm test         server 340 · client 149 · city 56 · amap 17 —— 0 失败
```

### 这一轮最可复用的两句话

1. **「这个闸门读的是哪一种写法？」** —— 同一个东西常有几种等价写法（`#66666E` / `rgb(102,102,110)`；
   `color: var(--x)` / `color="var(--x)"`），而检查通常只认其中一种。
   这个问法在前一轮扫出了「模板属性色」，这一轮扫出了「解析层的第二种拼写」。
2. **「解析不到的时候，它做了什么？」** —— 回退默认值、跳过、抛异常，三种都是静默或不可诊断，
   而且**回退默认值最坏**：它会让数字变好看。凡是「解析 → 计算 → 断言」的脚本，
   都要在解析层先问这一句。

## 十四、后续可选

- **头像色（身份色）与分类色/品牌色仍有重叠**：已在上一节量化（两两最挤 17.7、三项离语义/分类色 < 12）。
  结论是**不动**：形状与位置已足够区分，而动它会牺牲区分度。真要动请先用 `palette:search` 试算。
- **`我 = 品牌绿` 的映射**：靠 `check:tokens` 的 ③ 号断言守着（`AVATAR_COLORS[0] === --brand`）。
  想改成「每个人一个无关色」时要先决定这条映射要不要保留。
- **`--hairline` / `--hairline-strong` 的配对确实不参与对比度体检**：它们是带 alpha 的，
  `resolve()` 虽能合成实色，但脚本只从**声明**里取令牌，取不到就返回 `null`。
  今天这两条只用在 `border`（不承载文字），所以不影响结论；覆盖率行会一直提醒这件事。
- **H5 端地图是空白**：uni 的 `<map>` 在 H5 需要 `manifest.json → h5.map` 的地图 SDK key，
  当前没配，所以 CityMapPage / MapPage 的地图区在浏览器里是白面板（标记色与标记图标只能在
  真机/小程序端肉眼确认 —— 数值侧由 `contrast:audit` 的 ⑥ 和 `check:tokens` 的 ⑦ 兜底，
  见上一节）。
  顺带：`CityMapPage` 无数据时的白色空面板若想更接近 iOS，可改为「空态直接不渲染 `<map>`，
  换成一张带边框的占位图」。
- **H5 端海报画质受 CSS 盒子限制**：屏幕上那块画布的后备存储只有 313 × 704（dpr=1 时），
  所以「保存」走的是离屏 2 倍重绘（1500 × 3372）。若以后要在 H5 做更高倍导出（如 3 倍），
  改 `downloadH5()` 里的 `R` 即可 —— 顺带注意内存：`R = 2` 时一块 1500 × 3372 的画布约占 20 MB。

