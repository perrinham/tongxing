# 同行 · 旅行规划与 AA 分摊

一个 uni-app（Vue3 + Vite + TS）应用，主交付形态为 **微信小程序**：**一次旅行 = 一个共享空间**，行程规划和同行 AA 记账共用同一组成员、同一份数据；并内置「城市足迹地图」标注去过 / 想去、沉淀攻略与评价。行程、账单与城市攻略都可同步到自带的轻量后端，多人多端共享，**对方改完本端实时可见**（WebSocket）。

## 一分钟跑起来

本项目已迁移为 **uni-app（Vue3 + Vite + TS）→ 微信小程序（mp-weixin）**。高德 Web Service Key 已写入 `src/config.ts`，无需再填。

```bash
# 本地开发预览（H5，可选）
npm run dev:h5

# ⚠️ 如果 dev:h5 / build:h5 报 "Cannot find module 'vue-router/dist/vue-router.esm-bundler.js'"：
#    vue-router 是 @dcloudio/uni-h5 的传递依赖，npm 有时把它嵌在
#    node_modules/@dcloudio/uni-h5/node_modules/ 下而不提升到顶层，
#    于是 vue-cli-shared 在自己的层级解析不到它。H5 构建会直接失败
#    （小程序端不受影响）。两种修法，任选其一：
#      a) 声明依赖（推荐，可复现）：npm i -D vue-router@4.4.4
#      b) 临时软链（不动 package.json）：
#         ln -sfn ./@dcloudio/uni-h5/node_modules/vue-router node_modules/vue-router

# 类型检查 + 构建（提交前跑一遍）
npm run verify

# 产物：微信小程序工程在 dist/build/mp-weixin
npm run build:mp-weixin

# 共享后端（零依赖，Node 内置模块即可跑）
npm run server         # 监听 http://localhost:8787

# 导进微信开发者工具（需要真实小程序 AppID，见下文「导入微信开发者工具」）
npm run devtools       # 打开 dist/build/mp-weixin

# 样式体检：用开发者工具自带的官方 WXSS 编译器逐个文件校验
# （WXSS 会拒绝 `*` 这类合法 CSS，而工具的报错不给文件与行列号 —— 导入前跑一次省很多事）
npm run wxss:lint

# 测试
npm run test           # = server:smoke + client:smoke + city:smoke + lib:parity + amap:smoke + cloud:smoke
npm run server:smoke   # 后端：城市攻略 + 行程同步 + 写入校验 + 安全防线 + SQLite + HLC + 字段级合并 + 账号授权 + WebSocket 实时
npm run client:smoke   # 客户端：三台设备跑完整同步流程（真实 store + 真实后端）+ HLC 自检 + 字段级合并 + 身份登录 + 实时通道
npm run city:smoke     # 城市足迹专项（已接入 verify）：markCity / saveGuide / 持久化 / 别名解析 / publishMyGuide / loadShared / retractMyGuide / 后端不可达静默回退
npm run lib:parity     # 孪生实现一致性：HLC / LWW 合并 / ACL 的 server/lib/*.mjs 与 cloudfunctions/_lib/*.js 喂同一批语料逐项比对（含边界）
npm run cloud:smoke    # 云函数专项（离线）：用内存版 wx-server-sdk 驱动真实云函数，覆盖行程/攻略/登录/天气/建集合/大空间分页
npm run amap:smoke     # 高德在线生成端到端：本地城回归 + 任意城市（长沙）在线抓池生成 + 完全断网语义。**真实调用高德 API**（需网络，每次约 6 个请求）
```

**不写死断言条数** —— 每个脚本末尾都会打 `===== 结果：N 通过 / M 失败 =====`，以输出为准。
（这里原来写着「后端 313 / 客户端 137 / 城市 41」，早已过期成 340 / 149 / 56；
凡是会随代码变化的数字，写进文档就是下一个谎。）

`client:smoke` 用 esbuild 把真实的 Pinia store 打包到 Node 里跑，模拟三台各自独立存储的设备，
覆盖「凭码加入 / 互相改 / 删条目 / 离线改 / 并发改 / 删整个行程」。
服务端的合并规则写得再对，只要 store 漏打一次 `updatedAt`、或删除忘了记墓碑，
用户看到的现象就是「改完同步后变回去了」——这类问题服务端测试发现不了，
也没法在微信开发者工具里手动重现。

### 部署后端

```bash
# 开发：不带密钥，方便本地联调（启动时会打印警告）
npm run server

# 上线：至少配上密钥与来源白名单
AUTH_TOKEN='一串足够长的随机字符串' \
ALLOWED_ORIGINS='https://your.domain' \
DATA_DIR=/var/lib/tongxing \
PORT=8787 \
node server/index.mjs
```

配了 `AUTH_TOKEN` 后，小程序端 `src/config.ts` 的 `BACKEND_TOKEN` 必须与之一致，否则全部请求 401。
完整环境变量清单见 `server/index.mjs` 顶部注释（体积上限、限流窗口、日志等级等）。

实时同步默认开启，与 `SYNC_ENABLED` 同生共死（关掉云同步就没必要建长连接）：

```bash
WS_ENABLED=1            # 实时通道开关（默认跟随云同步）
WS_PING_MS=25000        # 心跳间隔；连续两个周期没有任何帧才判死（下限 1000）
WS_MAX_CONNS=500        # 单实例最大长连接数（超出在握手前回 503）
WS_COALESCE_MS=80       # 同一空间的变更合并窗口，窗口内多次改动合成一条通知
```

反向代理要放行升级请求：`Upgrade` / `Connection` 两个头必须透传，且**读超时要大于 `WS_PING_MS`**
（nginx 默认 `proxy_read_timeout 60s`，心跳 25s 够用；调大心跳就得同步调代理）。
`ALLOWED_ORIGINS` 同样作用于握手阶段的 `Origin` 校验。

### 部署到微信云开发（云函数 + 云数据库）

后端有**两条并行通道**，由是否配置 `VITE_CLOUD_ENV_ID` 决定走哪条：

| 通道 | 触发条件 | 说明 |
|---|---|---|
| 自托管 HTTP + WebSocket | 默认 | 上面「部署后端」那套，`server/` 保留为自托管方案与测试参考实现 |
| 微信云开发（云函数 + 云数据库） | `VITE_CLOUD_ENV_ID` 非空 **且** 运行环境有 `wx.cloud` | 小程序端专用；云函数无长连接，实时同步自动降级为「按需拉取」 |

```bash
# .env.local（不入库）：填环境 ID 即切到云函数通道；留空/删掉即回退 HTTP
VITE_CLOUD_ENV_ID=cloud1-d9gujmuaxb69ab976

# 构建时自动完成：同步 _lib 副本 -> 拷 cloudfunctions 到产物 -> 写 cloudfunctionRoot
npm run build:mp-weixin
```

产物 `dist/build/mp-weixin/` 里会多出 `cloudfunctions/{auth,trips,guides,weather,migrate}`，
`project.config.json` 的 `cloudfunctionRoot` 也由 `scripts/patch-mp-cloud.mjs` 自动写成 `cloudfunctions/`
（**别手改产物**，下次构建会被覆盖）。部署步骤：

1. **建集合**：云开发控制台 → 数据库 → 新建 `spaces` / `records` / `tombstones` / `space_members` / `guides`；
   或者跑一次 `npm run cloud:setup`（见下，走开发者工具自动化，等价于调 `trips`/`guides` 的 `{action:'setup'}`）。
2. **建索引**（控制台手动建，SDK 建不了）：`spaces.code`、`spaces.owner_openid`、`spaces.updated_at`(DESC)、
   `records.space_id`、`tombstones.space_id`、`space_members.space_id`、`guides.city_name`、`guides.author_openid`。
   数据量小时不建也能跑（全表扫），但早晚要建。
3. **上传云函数**：开发者工具 → 云开发 → 云函数 → 对 `auth` / `trips` / `guides` / `weather` 右键
   「上传并部署：云端安装依赖」。每个函数都自带独立的 `_lib` 副本（生成物，勿手改）。
   也可以用命令行（IDE 必须先打开、登录）：
   ```bash
   CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
   "$CLI" cloud functions deploy --env cloud1-d9gujmuaxb69ab976 \
     --names auth trips guides weather --project "$PWD/dist/build/mp-weixin" --remote-npm-install
   # 新建函数有 Creating 竞态，报「处于Creating状态」就等 20 秒重跑一次
   "$CLI" cloud functions list --env cloud1-d9gujmuaxb69ab976 --project "$PWD/dist/build/mp-weixin"
   ```
4. **⚠️ 把 `weather` 的超时从 3 秒调到 20 秒**（控制台 → 云函数 → weather → 配置）。
   默认 3 秒对冷启动不够：首次调用会 `FUNCTIONS_TIME_LIMIT_EXCEEDED`，之后热调用只要 0.5 秒。
   这是唯一需要出网的函数，其余函数冷启动也在 3 秒内。
5. **建集合 + 端到端体检**（走开发者工具自动化端口，需要 IDE 打开项目）：
   ```bash
   npm run build:mp-weixin
   CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
   "$CLI" auto --project "$PWD/dist/build/mp-weixin" --auto-port 9420   # 保持运行
   npm run cloud:setup     # 建集合
   npm run cloud:verify    # 建集合 + 真实调用：auth 登录 / trips 列表 / guides / weather / 写路径往返
   ```
   `cloud:verify` 是**对着真实云环境**跑的（不是 mock）：它会 push 一个空间再删掉、写一条攻略再删掉，
   用来验证 records/tombstones/guides 集合与 LWW 写入确实通了。断言失败会非 0 退出。
6. **迁移历史数据**（可选，一次性）：
   ```bash
   npm run migrate:export    # 读 server/data/travel.sqlite3 -> cloudfunctions/migrate/snapshot.json
   ```
   然后上传 `migrate` 云函数，调用 `{ "action": "plan" }` 先看将写入的行数，确认后再 `{ "action": "run" }`；
   导入完成后**删除 `migrate` 云函数**（它自带整库快照，长期留着不合适）。
   快照含真实用户数据，已在 `.gitignore` 里排除，**不要提交**。

云函数之间的共享代码只有 `cloudfunctions/_lib/` 一处源头，`npm run cloud:sync-lib` 负责分发到各函数目录
（`cloud:smoke` 与 `build:mp-weixin` 都会先跑它）。改了 `_lib` 记得重新上传受影响的所有函数。

云函数侧的身份一律取 `cloud.getWXContext().OPENID`，匿名语义由客户端声明 `loggedIn` 决定 ACL；
返回约定：成功直接返回数据对象，失败返回 `{ e: { status, message } }`，适配层转成 `BackendError`。

**两条容易踩的坑**（都是真机部署时才现形的，`cloud:smoke` 的假 SDK 覆盖不到）：

- **「集合已存在」的报错形态不统一**：有时只给 `errCode: -502005`、有时只给 `errMsg: "collection already exists"`。
  只判 errCode 的话，第二次跑 `setup` 就会 500。`_lib/store.js` 的 `ensureCollection` 现在两样都判。
- **`cloudfunctionRoot` 是产物内的相对路径**（`cloudfunctions/`），不是仓库根。DevTools 打开的项目根是
  `dist/build/mp-weixin/`，指到项目外它不认。所以云函数是**拷进产物**的（`scripts/patch-mp-cloud.mjs`），
  源仍然是仓库根的 `cloudfunctions/`。

**关于 `npm install` / 构建的一个环境说明（重要）**
当前沙箱里 `npm install` 因 broker 限制无法完成 `node_modules/.bin` 的符号链接，故标准 `npm run *` 脚本可能跑不起来。可改用直接调用 uni CLI：

```bash
node node_modules/@dcloudio/vite-plugin-uni/bin/uni.js build -p mp-weixin
# 类型检查
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
```

或直接 `npm run verify`（已把上述命令包进脚本）。

**导入微信开发者工具**

先在另一个终端把后端跑起来（不然页面能开、但同步与实时都会退化成离线）：

```bash
WX_DEV_LOGIN=1 SESSION_SECRET='local-dev-secret' npm run server
```

`WX_DEV_LOGIN=1` 是让本地登录可用的开关：没有 `WX_APPID` / `WX_SECRET` 时，服务端用 code 推导一个
确定性的假 openid（**仅供本地，生产必须关**，启动时会打警告）。不配它就只能以匿名身份用。

然后二选一：

```bash
# 方式一：CLI 打开（需要真实小程序 AppID）
npm run devtools         # = cli open --project dist/build/mp-weixin
npm run devtools:build   # 先构建再打开
npm run devtools -- --print   # 只看前置检查结果，不真的调用

# 切 AppID（只改 src/manifest.json 这个源头，别手改构建产物）
npm run appid            # 看当前值
npm run appid -- wx1234567890abcdef

# 方式二：GUI 导入
# 开发者工具 → 导入项目 → 选 dist/build/mp-weixin
```

`appid` 在项目里只有一个权威位置：`src/manifest.json`。`dist/build/mp-weixin/project.config.json`
里那份是构建生成的，手改会在下次构建被覆盖 —— 这就是把切换动作收进 `npm run appid` 的原因。

**CLI 有两个不写在帮助里的前置条件**（都踩过一次，所以 `scripts/open-devtools.mjs` 里显式判了）：

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `工具的服务端口已关闭…` | 「服务端口」默认关闭。开一次即持久化 | GUI：设置 → 安全设置 → 服务端口；或冷启动一次 `open -a /Applications/wechatwebdevtools.app --args --enable-service-port`（**对已运行实例无效**）。端口号写在 `~/Library/Application Support/微信开发者工具/<hash>/Default/.cli` |
| `不存在此 AppID 请检查后重新输入` | 工具日志里的原文是 `formatProject reject tourist/empty appid` —— **CLI 不支持游客 AppID**，和 AppID 填错报的是同一句话 | 游客模式只能用 GUI 导入；要 CLI 就填真实 AppID（改 `src/manifest.json` 的 `mp-weixin.appid` 后重新构建） |

项目用 `touristappid`（游客模式）时 GUI 可以直接跑，但**不能真机调试，`uni.login` 也拿不到可用 openid**
—— 也就是说「账号体系」那部分只有配上真实 AppID 才能真正验到。

首次打开后还需：勾选「不校验合法域名 / TLS 版本 / HTTPS 证书」（`urlCheck` 已在 `project.config.json`
里设为 `false`），正式发布时在 **开发管理 → 服务器域名** 里加入 `https://restapi.amap.com` 与后端域名。

### 两个只在开发者工具里才暴露的坑

这两个都**不影响 `npm test`**（服务端 + 客户端两组断言全绿），只在把产物导进开发者工具后才现形 —— 记在这里，
免得下次再从零查一遍。

**1. WXSS 不支持通用选择器 `*`**

`*{...}` 与 `.a > *{...}` 都会被编译器直接拒掉。报错只有一句
「编译 .wxss 文件错误，错误信息如上，可在控制台查看更详细信息」——**不给文件、不给行列号**，
细节只落在模拟器控制台里，二十来个 wxss 只能靠猜。

```bash
npm run wxss:lint   # 用工具自带的官方编译器逐个文件校验，精确到 文件(行:列)
```

顺带纠正一个直觉上的误判：`@media (prefers-reduced-motion: reduce)` **本身是合法的**，
被拒的是它里面的 `*`。别把「媒体特性不支持」当成结论 —— 用 `wcsc -sd '<css>'` 单独试一条就知道了。
小程序端没有 `*`、也没有读取「减弱动态效果」的途径，所以这段用条件编译只下发 H5
（`src/styles/global.css`）；全局盒模型在小程序侧改成显式列出内置组件标签。

**2. `uni.connectSocket` 不传回调时返回的是 `Promise`，不是 `SocketTask`**

uni-app 的 API 约定：**不传 `success` / `fail` / `complete` 就把接口 Promise 化**。于是
`next.onOpen(...)` 是 `undefined`，注册监听时抛 `TypeError`，异常一路穿出 `connect()` → `start()`
→ `startRealtime()` → **`onLaunch` 被截断**。现象是「实时永远停在 `connecting`」，
既没有报错也没有任何提示 —— 因为异常根本没被谁接住。修法是显式传三个回调，
并加一道返回值形状校验（见 `src/services/realtime.ts`）。

值得留意的是**为什么测试没拦住**：H5 与 `scripts/uni-mock.ts` 都直接返回 SocketTask。
现在 mock 照实还原了 uni-app 的这条约定 —— 少传回调就会拿到 Promise，测试立刻会红。

## 功能

**行程规划**
- 内置 6 个城市的精修点位库（成都 / 西安 / 大理 / 厦门 / 三亚 / 重庆，共约 150 个 POI，含真实经纬度 + 携程/高德风格经典路线）
- **任意城市**：6 城之外的目的地现场走高德「国家级景点 + 风景名胜/景区关键词 + 餐饮 + 商圈」多路检索，按评分取头部组装候选池，再走同一套规则引擎（地理聚类分天、远郊拆分、补餐饮）。高德失败/离线时回退本地模板并生成提示，不崩
- 按目的地 + 天数 + 偏好 + 节奏生成草稿
- 同一天的点按地理近邻排序（球面距离），远郊单独占一天
- 按天卡片流、时间轴自动推算、上移下移、打卡、一键导航（高德）
- ⚠️ 高德 /v3/place/text 的**纯类型翻页检索排序与质量无关**（橘子洲这类大地标会落在第 6 页之后），所以在线抓池用的是「细分类型 110203 + 关键词」多路组合，各自第 1 页即可拿到高质量头部

**AA 记账**
- 两字段核心模型：**谁付的 + 为谁付**
- 三种分摊口径：均分 / 按权重 / 不等额
- 金额按「分」计算，均分尾差自动抹平，保证份额之和恒等于总额
- 分类占比、按日分组、人均与个人份额统计

**结算**
- 净额 = 已支付 − 应分摊，正数应收、负数应付
- 贪心配对把 N 笔账压到最少转账笔数（通常 ≤ 人数 − 1）
- Canvas 生成结算海报（1080 × 自适应高度），可下载分享

**城市足迹地图（City Footprint）**
- 一张地图标注每个城市：去过 / 想去
- 去过的城市可写 **攻略 + 评价 + 星级评分 + 到访日期**
- 想去的城市可写 **想去理由**
- **多人共享**：已接入后端，想去的人打开某城市能直接读到所有去过的人写的攻略与评价（按城市聚合，带作者昵称）；后端不可达时自动回退纯本地，不崩
- 坐标优先查本地 `src/data/citiesGeo.ts`（约 55 个主要城市 gcj-02 中心坐标），查不到再走高德地理编码兜底
- 入口：`pages/CityMapPage.vue`（个人页可进入）；行程页每个「天」有「看路线」按钮进入 `pages/MapPage.vue` 看当天点位路线（步行/驾车切换，调用高德路线规划）

**我的攻略（云端足迹管理，`pages/MyGuidesPage.vue`）**
- 与「城市足迹」页的分工：那页管**本机**（编辑 / 地图标点），这页看**服务端记在我名下的**（`/api/my/guides`，按 openid 归属，跨设备）
- 「对不上的」差异区：本机有、云端没有 → 一键补发（补发后重拉确认真的上去了）；云端有、本机没有 → 一键并入本机
- 重复行清理：改过发布昵称会让同一城市在云端留下多条，页面标「多条」，可逐条按 id 撤回（服务端校验归属，别人的删不掉）
- 三种空态分开：未启用云同步 / 未登录 / 拉取失败各有文案与出口；未登录不会被显示成「云端还没有记录」
- 入口：`pages/ProfilePage.vue` → 行程工具 → 我的攻略

**行程与账单云同步**
- 一个行程 = 一个云端空间，发起人拿到 **6 位分享码**，同行的人凭码加入同一份数据
- 同步范围：行程信息、成员、每天的安排、账单（城市足迹另有独立共享）
- **离线优先**：改动先落本机，联网后自动补推；后端挂了不影响使用，只显示「离线，稍后自动重试」
- **实时通道**：连上后对方一改立刻可见，不用等下一次同步；断线自动退避重连，重连时按 rev 比对补上漏掉的改动
- 入口：`pages/SyncPage.vue`（个人页 → 云同步），首次进入自动同步，回到前台也会补一次

合并规则（`server/routes/trips.mjs`）：
- **按字段的 LWW**：每条记录按 id 对齐，再**逐字段**比各自的时间戳（见下节「字段级合并」），
  后者胜；两人各改同一条记录的不同字段时**两边都保住**。重复推送幂等，可安全重试
- **删除靠显式墓碑**，不靠「快照里没有这条」——否则一台离线设备上线时会把已删记录整批推回来
- 记录比墓碑新视为「删后又改」，以改为准
- 服务端空间版本号 `rev`，客户端带上 `baseRev`；不一致时回 `staleBase: true` 提示「别人改过」，但仍然完成合并（不做硬冲突，离线场景下硬冲突会让一方白改）

已知取舍（诚实记录）：两台设备在同一毫秒改同一个**字段**时只保一份（按字段的时间戳定序）。
不同字段之间已互不干扰，这是字段级合并的直接收益。

**时钟（HLC 混合逻辑时钟）**

「谁更新」不再直接比各设备的 `Date.now()`，而是比各自的 HLC
（`{t: 物理毫秒, c: 同毫秒计数, n: 节点号}`，实现见 `server/lib/hlc.mjs` 与 `src/services/hlc.ts`）：

- **因果性**：客户端每次编辑递增自己的 HLC；收到服务端数据时先把本地时钟推到对方之后
  （`observe`）。于是「看到 A 的改动之后才改的」这件事被写进时间戳本身 ——
  即使 B 的手机慢 10 分钟，B 的改动也一定排在 A 之后。这是纯物理时钟给不了的。
- **封顶**：时间戳超前服务端 `MAX_CLOCK_SKEW_MS`（默认 60s）的一律拉到上界，
  挡住「手机时钟快 3 小时」的设备（这类设备否则永远压过别人，且别人赢不回来）。
  只压 `t`、**保留 `c` 与 `n`**：两条都超前的记录仍能分先后，而不是塌成同一个值。
- **封顶只作用于比较，绝不改写存储**。封顶值依赖 `now`，一旦写回，同一条超前记录每次推送
  都会被封到一个更大的值 → 服务端每次都判 `changed:true` → `rev` 无限增长 →
  所有客户端被迫反复全量拉取。保持原值入库 ⇒「同一输入同一判定」，幂等性才成立。
- **编码**：三元组编成定长字符串 `TTTTTTTTTTTTTTT-CCCCCC-NNNNNNNN`，
  使**字典序 == 三元组序**，JS 的 `cmpHlc` 与 SQL 的 `MAX()` 结论完全一致。
  两端各自对同一组字面量做断言（`server/smoke.mjs` [15] 与 `scripts/client-sync-test.mjs` [0]），
  任何一侧改了格式都会炸。
- **老数据兼容**：没有 HLC 的老记录直接拿 `updatedAt` 当 `t`（节点号全零，同刻时让位给新格式），
  新旧数据在同一把尺子上排队，不需要一次性迁移。
- **陈旧 HLC 兜底**：归一化一律走 `recordHlc(raw.hlc, updatedAt)` 取两者较晚者。
  客户端本地那条记录是从服务端同步下来的（带着服务端给的 HLC），若编辑时只更新了
  `updatedAt`，而服务端直接采信那个陈旧 HLC，编辑会被**静默丢弃**
  （既不算更新也不算冲突，`applied.conflicts === 0` 且内容纹丝不动）。

**字段级合并（per-field LWW）**

合并单位从「整条记录」下沉到「字段」：记录上多一个 `fhlc: { 字段名: HLC }`，
逐字段比时间戳、各取较晚者。于是「A 改标题、B 改预算」两边都保住 ——
按记录比大小必然丢一边，因为后推的那份会把对方的改动整条盖掉。
实现见 `server/lib/lww.mjs` 与 `src/services/lww.ts`。

- **字段戳映射必须完整**。缺失的字段会退回记录级 HLC（= 各字段戳的最大值，会被别的字段顶高），
  于是「只改了预算」的客户端会把没动过的标题也顶到一个新时刻，反过来盖掉别人刚改的标题 ——
  **比记录级还糟**。所以写入路径先补全映射、再只顶本次改动的字段
  （`stampFields(recs, fields)`），`commit()` 里还有一道 `ensureFieldStamps` 兜住新建路径。
- **平局口径：严格更晚才赢，相等保留 `base`**。两端的 `base` 都是「服务端那一版」
  （服务端 = 库里内容；客户端 = 刚拉下来的服务端版本，incoming = 本地含未推送改动），
  于是平局时两端都归到服务端的值，不会来回翻。
- **记录级 `hlc` / `updatedAt` 由字段戳推导**（取最大值），不允许各自独立赋值：
  记录级 HLC 只用来跟墓碑比「删后又改」，语义就是「最后一次被碰是什么时候」。
- **客户端也必须做这一遍**。只在服务端做是不够的：本地有未推送改动（戳 H2）时拉下
  服务端新版本（别人改标题，戳 H3），若按记录级比大小，本地整条 H3 落败 →
  本地那笔金额改动被覆盖，推上去时它已经不在了 → **真实数据丢失**。
- **`.mjs` / `.ts` 孪生维护**：两端无法共享源码（零依赖 + 小程序引不到 Node 内置模块），
  只能各写一份，靠 `scripts/client-sync-test.mjs` 里的**导出一致性守卫**钉住
  「双方都必须导出的那份清单」，改一边忘了另一边会直接变红。
- `applied` 语义随之调整：`updated` = 至少一个字段被 incoming 赢走；`conflicts` = 一个字段都没赢。

**账号（微信 openid）**

把「谁是谁」从**客户端自报**换成**服务端可校验**的标识。之前城市攻略用自填昵称认作者、
行程协作靠分享码，结果是：改个昵称就能冒名；服务端**无法**回答「这个人有没有资格改这个行程」。
openid 是微信签发的、同一小程序内唯一且不可自选的标识，用它作身份键之后，授权才成立。

实现见 `server/lib/identity.mjs`（服务端）与 `src/services/identity.ts`（客户端）。

- **两套凭据正交，别混**：
  `Authorization` / `X-Api-Key` = 共享密钥，回答「这个客户端被允许访问后端吗」（部署级门禁）；
  `X-Session-Token` = 会话令牌，回答「你是哪个用户」（身份）。只有身份能支撑归属判定。
  测试里专门钉了边界：会话令牌塞进 `Authorization` 不生效，只有身份没有共享密钥也进不来。
- **令牌无状态**：`wxs_<openid>.<exp>.<签名>`，签名用 `SESSION_SECRET` 做 HMAC。
  校验 = 重算签名 + 查过期，**不需要 session 表**（多实例部署也不用共享存储）。
  代价是没法单个吊销，只能轮换密钥全量失效 —— 换来零运维，这个量级划算。
  「登出」因此是纯客户端动作（把本地令牌删掉）。
- **归属是「有主 / 无主」两种，不是一刀切**：这是兼容口径的核心。
  接账号体系之前创建的空间没有归属，把它们的写权限一并收紧，会让「群里那几个人一起记的账」
  当场全部改不动。所以：**无主空间保持开放**（知道 id 或码就能写，旧行为不变），
  **有主空间只认 owner / 成员**。
- **旧空间走显式认领**（`POST /api/trips/:id/claim`，需出示分享码），不自动认领 ——
  自动认领会把「谁知道 id」静默升格成「谁拥有它」，那是一次没有征兆的权限变更。
  认领只对真正无主的空间成立，否则它就是个抢行程的后门。
- **`openid` 不外泄**：列表响应里既不返回 `owner_openid`，攻略对象里也不带 `author_openid`
  （需要归属判定的地方走 `db.guideOwnerOf` 单独查）。身份标识一旦进了响应，就会被客户端缓存、
  被日志打到 ——「不放进返回对象」比「放进去再记得删掉」可靠。
- **登录失败的状态码刻意分开**：400（code 形态不对）/ 401（微信拒了这个 code，该重新 `uni.login`）
  / 503（服务端没配 `WX_APPID`/`WX_SECRET`，运维问题）/ 502（连不上微信）。
  都回 401 的话，用户看到「登录失败」而运维永远收不到信号。
- **本地没有 AppID/Secret 时**：`WX_DEV_LOGIN=1` 用 code 推导一个确定性假 openid，仅供本地与测试
  （等于「自己声明自己是谁」，生产必须关，启动时会打警告）。

**实时同步（WebSocket）**

`GET /api/ws`，让「对方一改我就看到」不再需要等下一次同步。实现见 `server/lib/ws.mjs`（协议层）、
`server/lib/hub.mjs`（订阅中心）、`server/lib/realtime.mjs`（网关）与 `src/services/realtime.ts`（客户端）。

**定位先说清楚：实时是加速层，不是可靠层。** 消息丢了、连接断了、通知乱序了，都不影响正确性 ——
订阅响应会带上每个空间当前的 `rev`，客户端拿它和本地的 `sync.revOf` 一比，对不上就补拉那一个空间。
于是「离线补推 + 手动同步」那套机制仍然是唯一的正确性来源，实时只是把等待时间从「下次同步」压到「毫秒级」。
这条取舍决定了下面几乎所有设计：服务端**只推通知不推内容**、断线不需要补消息队列、重连不需要序列号。

- **零依赖手写 RFC 6455**。沙箱装不了 `ws`，Node 内置模块也没有 WebSocket 服务端，所以协议层是自己写的：
  握手（`Sec-WebSocket-Accept = base64(sha1(key + GUID))`）、帧编解码、掩码、三档长度、分片、控制帧约束。
  几十行的量级换来「测试里能逐字节喂帧」这个能力 —— 解析器写成**纯状态机**
  （`createFrameParser` 喂 Buffer 进、吐事件出，不碰 socket），于是「TCP 把帧切在头部中间」
  「一个 chunk 挤三个帧」「长度跨 7/16/64 位边界」这些真机上极难复现的情况，都变成了确定性断言。
- **客户端帧必须掩码**（RFC 6455 第 5.3 节，防代理缓存投毒），不掩码就是协议错误 1002；
  服务端发的帧反而**必须不掩码**，发了就是 bug。RSV 位非 0 直接拒（本实现没协商任何扩展），
  控制帧不可分片、载荷 ≤125 字节，关闭帧只有 1 字节载荷属非法。
- **鉴权分两段，因为浏览器/小程序给不了自定义握手头**。`new WebSocket(url)` 不能带 header，
  令牌塞进 URL query 会进访问日志、Referer、浏览器历史。所以握手阶段只做**同源校验**，
  令牌走建连后第一帧 `{t:'hello', token, key}`；`WS_AUTH_GRACE_MS`（默认 5s）内没收到 hello 就关（4001）。
- **两套凭据正交，和 REST 侧一致**：`key`（共享密钥）= 「这个客户端被允许访问后端吗」，
  `token`（会话令牌）= 「你是哪个用户」。两个都过才建立身份；只有 key 也能连，但 `openid` 为空，
  于是只能订阅无主空间。
- **只推通知，不推内容**。服务端发的是 `{t:'update', id, rev, deleted, updatedBy}` ——
  客户端收到后自己去拉**那一个**空间（`GET /api/trips/:id`）。好处有三：
  合并逻辑只有一份（不会出现「REST 合并」和「WS 合并」两套实现慢慢漂移）；
  大行程改一个字段不会导致整份文档被广播；断线自愈天然可用（rev 对不上就拉）。
- **订阅授权与 REST 写权限共用一份口径**（`server/lib/acl.mjs` 的 `accessVerdict`）。
  复制一份迟早漂移成静默越权，所以 `trips.mjs` 和 `realtime.mjs` 都调它，
  连同「无主空间保持开放」这条兼容口径也一起继承 —— 存量行程不会因为上了实时通道突然收不到更新。
- **授权变更要撤销已有订阅**。`/claim` 把无主变成有主的那一刻，之前「随手订阅过」的匿名连接
  手里还攥着订阅权 → 现在会被 `hub.dropSubscribers` 踢掉，并收到
  `{t:'unsubscribed', reason:'access-revoked'}`（明说是权限没了，而不是断网）。
- **排除发起者用的是「连接」而不是「设备」**。同一台设备开两个标签页时 `deviceId` 是共享的，
  按设备排除会让另一个标签页收不到自己刚提交的改动。所以客户端把自己的连接 id
  （服务端在 `ready` 帧里分配）放进 `X-Conn-Id` 头，push / DELETE 都带。
- **通知按空间合并（coalesce）**：默认 80ms 窗口内同一空间的多次变化合成一条，`rev` 取最大。
  连续输入触发的多次推送不会把连接打满。两次变化分别由 A、B 发起时，`except` 集合取**交集** —— 谁都不能被排除。
- **心跳走应用层 `{t:'ping'}`**，不用协议层 PING 帧：小程序 `SocketTask` 不保证暴露 pong 回调。
  判死的依据是「连续两个心跳周期没收到**任何**帧」，不只是没收到 pong —— 正在持续推数据的连接不该被误杀。
  超时用 1001（可重连）而不是协议错误码。
- **首帧就带订阅集合**：客户端把当前所有空间 id 一次性 `sub` 过去，服务端逐条回
  `subscribed`（含 `{id, rev, deleted}`）或 `unsubscribed`（含 reason）。
  客户端比对 `rev` 就完成了断线补偿，不需要额外的「补漏」接口。
- **`ready` 帧带 `conn`（连接 id）与 `pingMs`**，客户端据此启动空闲看门狗与退避重连
  （指数退避 + ±20% 抖动，避免所有客户端同时重连撞成同步波）。
  `authFailed` 时**停止重连**等人工 `restart()` —— 令牌过期导致的 401 反复重试没有意义，只会刷日志。

发送路径上，`hub.notify(...)` 的唯一调用点在 `server/routes/trips.mjs` 的 push 与 DELETE 之后。
收件人是「已订阅该空间、且不在 `except` 里的连接」，逐条 `conn.send()`；
发送失败不影响本次请求的成功响应 —— 通知发不出去只是对方慢一点，数据早就入库了。

**共享后端**
- 轻量实现：`server/`（Node 内置模块，**零依赖**，数据落 `DATA_DIR/travel.sqlite3`，默认 `server/data/`）
- 启动：`npm run server`（默认 `http://localhost:8787`）
- 模块划分：`lib/`（日志 / 校验 / 存储 / HTTP / 限流 / 鉴权 / 实时）+ `routes/`（guides / trips / auth）
- 接口：
  - 城市攻略：`GET /api/cities`（`?status=` 过滤）、`GET /api/cities/:name`、`POST /api/cities/:name/guides`、`DELETE /api/cities/:name/guides?author=`、`PUT|DELETE /api/guides/:id`
  - 行程同步：`GET /api/trips`（含已删；`?active=1` 只看在用、`?withDoc=1` 带全量文档）、`GET /api/trips/by-code/:code`（只读）、`POST /api/trips/join`（凭码加入并登记成员）、`GET /api/trips/:id`、`POST /api/trips/:id`、`DELETE /api/trips/:id`、`POST /api/trips/:id/code`（换码）、`POST /api/trips/:id/claim`（认领无主空间）
  - 账号：`POST /api/auth/wx`（code 换 openid + 签发会话令牌）、`GET /api/auth/me`、`POST /api/auth/logout`（客户端动作，服务端只回 200）
  - 实时：`GET /api/ws`（**upgrade only**，普通 GET 不被它接管；帧协议见下节「实时同步」）
  - `GET /api/health`（豁免鉴权与限流，供探活；带 `identity` 与 `realtime` 状态段，不回显 appid/secret）
- 客户端：`src/services/backend.ts`（`uni.request` 封装，带超时与幂等重试；会话令牌走 `X-Session-Token`，连接 id 走 `X-Conn-Id`）；开关在 `src/config.ts` 的 `BACKEND_ENABLED` / `BACKEND_TOKEN` / `SYNC_ENABLED` / `REALTIME_*`
- 接自有后端 / 微信云开发时，只改 `backend.ts` 与 `config`，页面与 store 不用动

**后端加固**（环境变量见 `server/index.mjs` 顶部注释）
| 项 | 做法 |
|---|---|
| 鉴权 | `AUTH_TOKEN` 共享密钥，`Authorization: Bearer` 或 `X-Api-Key`；定长摘要比较防时序泄漏。**这是部署级门禁，与用户身份是两码事**（见「账号」） |
| 身份 | `WX_APPID` / `WX_SECRET` 换 openid；`SESSION_SECRET` 签无状态会话令牌（`X-Session-Token`）。`WX_DEV_LOGIN=1` 仅供本地/测试（生产必须关，启动会打警告） |
| 授权 | 有主行程只允许 owner / 成员写入（`space_members` 表）；攻略按 `author_openid` 判归属。无主空间保持开放以兼容存量数据 |
| CORS | `ALLOWED_ORIGINS` 白名单，命中才回 ACAO 并带 `Vary: Origin`；默认仅本机来源 |
| 体积 | `MAX_BODY_BYTES`（默认 2MB），超限 413；请求体解析失败 400 |
| 限流 | `RATE_LIMIT` / `RATE_WINDOW_MS` 按 IP 滑动窗口，超限 429 + `Retry-After` + `X-RateLimit-*` |
| 实时 | 握手阶段校验同源 + 连接数上限（超出在 101 之前回 503）；令牌走首帧 `hello`，`WS_AUTH_GRACE_MS` 内没收到就关；订阅逐条过 `acl`；心跳判死 + 消息速率限制（`msgBurst` / `msgPerSec`） |
| 写入校验 | 全字段白名单归一（类型 / 枚举 / 区间 / 长度截断），丢弃未知字段，超长回 `warnings` |
| 原型污染 | 拒绝 `__proto__` / `constructor` / `prototype` 键，只按白名单取值 |
| 畸形输入 | `decodeURIComponent` 包异常兜底、id 字符集校验、脏 doc 拒绝 |
| 落盘 | SQLite 事务 + WAL：每次推送是一个**空间级**事务，崩溃后自动恢复到一致状态，无需手工备份回退 |
| 响应头 | `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Cache-Control: no-store` |
| 可观测 | JSON 结构化日志 + `X-Request-Id` 回显 + 慢请求告警 + 每次服务的请求/拒绝计数 |
| 生命周期 | 405 带 `Allow`、`clientError` 兜底、`uncaughtException` 优雅退出、SIGINT/SIGTERM 落盘后退出 |
| 容量 | 单空间各类记录条数上限，防灌爆；墓碑按条数封顶 |

**存储（SQLite）**
- 用 Node 22 内置的 `node:sqlite`，依旧零依赖；库文件 `DATA_DIR/travel.sqlite3`，WAL 模式
- 表：`spaces`（空间元信息 + 列表展示用的冗余投影）、`records`（空间内实体，整条记录存 JSON）、`tombstones`、`guides`
- **写入以空间为事务边界**：改一个行程只重写那个空间，其他空间一个字节都不碰
- 列表与计数走 SQL，不带 `withDoc` 时完全不加载文档
- 旧版 `db.json` 在首次启动且库为空时自动导入，原文件归档为 `db.json.migrated`（保留而非删除）
- 记录刻意「整条存 JSON」而不拆成字段列：合并是按**整条记录**做 LWW 的，拆字段反而更容易错；只有真需要按列排序/计数的字段才做冗余投影

**数据**
- 默认以本机为主：行程存 `travel_h5_state_v1`，同步元数据存 `travel_sync_v1`，城市足迹存 `travel_cities_v1`，互不干扰
- 开启云同步后，行程 / 成员 / 安排 / 账单会上传到自建后端并在同行之间共享
- 导出 / 导入 JSON，可跨设备流转（不依赖后端）

## 视觉规范（iOS 风格）

界面按 iOS 系统 App 的语汇来做，不是「浅色 + 圆角」那种表面模仿。要改 UI 时先读这一节。

### 三条底层规则

1. **分层靠底色差，不靠线和影。**
   页面底是 `#F2F2F7`（systemGroupedBackground），卡片是纯白。白卡**没有描边、没有投影** ——
   白色的浮起感来自它坐在灰底上。历史上每张卡都带 `1px` 边框 + 一层彩色阴影，
   结果就是整屏都是线，卡片边界反而看不清。

2. **留白只由一层负责。**
   `.page-body` 提供左右 16px。`.sec-title` / `.list-head` / `.list-foot` **只给纵向内边距**。
   这两者一旦都带横向 padding，内容左边线就会随容器层数逐层内缩。

3. **颜色只用来编码信息，不用来装饰。**
   品牌绿、分类色、状态色都有确切语义。装饰性的渐变、顶部彩条、光晕一律不要。

### 语义色是两套值：填充用基色，文字用 `-deep`

`--brand` / `--accent` / `--warn` 这三个基色是**照着填充设计的** —— 条形、圆点、
整块按钮底，要鲜亮。它们的明度都偏高，直接拿去做浅底上的小字只有 2.85 ~ 3.27:1：

| 角色 | 用哪个 | 实测（压白底） |
|---|---|---|
| 条形 / 圆点 / SVG 图标 | 基色 `--brand` `--accent` `--warn` | 无对比度要求（SVG 图标按 3:1） |
| 浅底上的文字（含 `→` `★` 这类字形） | `-deep` 变体 | 4.88 ~ 6.88:1，无条件过 AA 4.5 |
| 实心控件底 + 白字 | 基色 + 白字 | 3.18:1，见下方「已知取舍」 |
| 压在**色块**上的文字（头像初始字、地图 `callout` / `label`） | `avatarInk(底色)` | 黑白二选一，**与底色无关的下界 4.58:1** |

`-deep` 的值不是挑好看的，是**按最差底色反推**的：文字实际会落在白卡 / `--bg-page`
/ `--bg-subtle`(#E9E9EB) 三种浅底上，取最深的那个当界，要求 `Y ≤ 0.14244`
（= 0.866/4.5 − 0.05）。所以 `-deep` 在任何浅底上都不用再逐一验。

另一条**与底色无关**的保证：压在色块上的文字走 `avatarInk(底色)`（黑白里取对比度更高者）。
它的最差情况出现在黑白相等处 —— `Y + 0.05 = √(1.05 × 0.05) = 0.22913`，此时两者都是
**4.58:1**。所以它对任何未来新增的底色都成立，不必逐色验；`contrast:audit` 的 ⑥ 守着
调用点（必须走 `avatarInk`）和实现（必须真的黑白二选一）。

`--danger` 是唯一的例外：它同时当「白底上的红字」和「白字按钮的底」，
一个值要满足两种角色，所以直接按同一口径把它调深（`#E03B30` → `#B01F16`）。
原来的 `#E03B30` 压白底只有 4.34:1 —— 差 0.16 不到 AA，属于最容易被漏过的。

> **已知取舍（有意保留，`npm run contrast:audit` 会列出来但不算失败）**
> - **实心按钮的白字是 3.18:1**（`.btn-primary` / `.chip.active` / `.key.save` / `.dur.active`）。
>   按 WCAG 1.4.11 的 3:1 线；Apple 自家的 `systemBlue` 按钮也只有 3.6:1。
>   要抬到 4.5 就得把品牌绿压到 `--brand-deep` 那么深，按钮会失去鲜亮度。
> - **`--text-tertiary` 过不了 AA**（压白底 2.73:1）。这不是配错色，是**数学上不可能**：
>   要在白底上过 4.5:1 文字明度得压到 Y ≤ 0.183，而 `--text-secondary` 已经是 0.135，
>   三级灰合格所需的三个明度点排不下。Apple 自己的 `tertiaryLabel` 更浅（≈1.9:1）。
>   它的用法由 `npm run contrast:audit` 全量列出 —— 数量随代码变化，**以脚本输出为准，不写死在这里**
>   （这里原来补了一句「写这份 README 时是 70 处」，很快就不是了；规则和例外不应该在同一个括号里打架）。
> - **底部 tab 的未选中态不要提到 `--text-secondary`**：它的明度 Y = 0.135 会和选中态
>   `--brand-deep` 的 Y = 0.127 撞在一起（实测差 0.0073），选中/未选中就只剩色相可辨，
>   可用性反而下降。这两个值由 `npm run contrast:audit` 第五节末尾**重算**并打印 ——
>   哪天令牌改动把两者拉开了，脚本会提示「反例前提已变，可以重新评估」。
> - **「未选中态」这一族一律留在 tertiary**：底部 tab 的未选中标签、「城市足迹」评分面板里
>   没点亮的 ★、`.dot-sep` 那种夹在字中间的 `·`。它们是**同一类**取舍：
>   信息不靠它们单独承载（星标右边就是「3.0 / 未评」，`·` 两边都是同级灰的字）。
>   唯一的例外是**分隔线**：那是图形不是字，用 `--line-strong`。
>   **`--line-strong` 只准画线，不许当 `color`** —— 这条有闸门（`contrast:audit` ⑦ a），
>   因为它被误用过三次（当按钮底、当正文色、当星标色），每次都是运行时才抓到的。
> - **品牌色图标低于 1.4.11 的 3:1 线**：`<AppIcon color="var(--brand)">` 与 `.nav-icon`
>   压白卡 3.18:1（勉强）、压页面底 **2.85:1**、压 `--brand-soft` **2.82:1**。
>   这是**有意保留**的——把品牌绿压成 `--brand-deep` 会丢掉「绿色 = 可点」这个视觉语言，
>   Apple 自家的 tint 图标也在 3:1 附近。但**别写成「达标」**。
>   实测值由 `contrast:audit` 的 ⑧ 从令牌算出来打印（含每个图标色的使用次数）。
>   同理，tertiary 的箭头图标（`color="var(--text-tertiary)"`，18 处）只有 2.25 ~ 2.73:1。

**禁用态只有一种样子**：`--bg-sunken` 底 + `--text-secondary` 字（`#66666E` on `#E3E3E8`）。
`global.css` 里有一条**同等特异性**的兜底，专门收尾那些「没写 `[disabled]`」的按钮 ——
uni 内置的 `uni-button[disabled]` 是 `#F7F7F7` + `rgba(0,0,0,.3)` = **2.1:1**，
不兜的话整片界面会悄悄退回那个值。具体数字由 `contrast:audit` ⑦ b 算出来打印
（它同时算「想抬到 AA 该换成哪个令牌」），**不写死在这里**。
注意页面自己的 scoped 规则特异性更高（`.key.save[disabled][data-v-x]` = 0,3,0 > 兜底的 0,2,1），
所以**兜底只替没写的那批收尾**；写了的以本文件为准。

### 组件语汇（都在 `src/styles/global.css`）

| 类名 | 用途 |
|---|---|
| `.list` | 分组卡容器：白色圆角 + `overflow: hidden` |
| `.list-row` | 单行（min-height 44px，点击态浅灰） |
| `.list-sep` | 内缩发丝分隔线（左缩进 16px，可用 `.indent-*` 对齐图标列） |
| `.list-head` / `.list-foot` | 卡片外面的分组抬头 / 脚注，13px 次级灰 |
| `.stat3` | 三段式统计条；数值长时加 `.col` 变纵向，避免单位被逐字折行 |
| `.seg` / `.seg-item(.active)` | 分段控件：灰凹槽 + 白色滑块（**不要**改成「换底色」式按钮组） |
| `.tint` | 同色浅底 + 同色文字的标签 |
| `.btn-primary` / `.btn-ghost` / `.btn-tint` | 填充 / 灰底 / 同色浅底三级按钮 |

### 排版

- 大标题 34/700，区块标题 20/700，正文 15/400，次级 13，说明 12。
- 数字一律用 `.num`（`tabular-nums`），金额列才对得齐。
- 主数字 34/700 且**纯色**：`background-clip: text` 的渐变字在大字号下会左右发虚。

### 四个容易踩的实现坑

- **按钮要显式给宽度。** `<button>` 是替换元素，在纵向 flex 容器里不会被 `align-items: stretch`
  拉满，宽度由内容决定。首屏两个 CTA 都写了 `.cta { width: 100% }`，否则会缩成一小条。
- **H5 端 `<button>` 编译成 `<uni-button>`。** 所以 `global.css` 里的按钮重置写法是
  `button, uni-button { … }`，还要清掉 `::after`（默认描边画在伪元素上）。
  只写 `button {}` 的话，H5 上会莫名其妙多出一圈绿框，而小程序端是干净的。
- **`position: fixed` 的元素不占文档流，必须单独留白。** 页面级的 `padding-bottom`
  只避开底部 tabbar，避不开悬浮按钮。记账页的绿色「+」曾经正好压住最后一笔的金额 ——
  修法是在列表容器（`.groups`）上补 `padding-bottom: 54 + 24 = 78px`。
  以后再加固定定位元素，记得照样补一份。
- **H5 端 canvas 的后备存储不是你说了算。** uni 的 `<canvas>` 外壳里挂着
  ResizeSensor，布局一变就按 `canvas.offsetWidth × pixelRatio` **重置**画布尺寸并清空内容，
  同时给上下文打上 `__hidpi__` 标记（之后所有绘制坐标内部乘一次 pixelRatio）。
  也就是说 H5 端要在 **CSS 像素空间**作画，而且不能自己写 `canvas.width/height`。
  `PosterCanvas.vue` 曾经先写 `canvas.width = 750` 又立刻读回 750，算出 scale = 1
  就按 750 画下去，下一帧被改回 313 —— 海报右边约 40% 被**静默**裁掉（不报错，只是图不对）。
  正确姿势：按容器实测宽度定 CSS 比例 → 等两拍 → 按盒子实际尺寸推导缩放再画。
  详细原理见 `src/components/PosterCanvas.vue` 的 `renderH5()` 注释。

### 横向滚动必须用 `<scroll-view scroll-x>`

日期切换、分类筛选这类横滑条，小程序端让普通 `<div>` `overflow-x: auto` 是**无效**的
（手指划不动）。结构固定为：外层 `<scroll-view scroll-x>` + `white-space: nowrap`，
内层 `display: inline-flex`。

### 改完怎么自查

```bash
npm run dev:h5          # 或 npm run build:h5 + node scripts/serve.mjs
npm run typecheck && npm run build:mp-weixin && npm run wxss:lint
npm run check:tokens      # 令牌 ↔ canvas/地图字面值/位图 是否漂移
npm run contrast:audit    # 文字对比度闸门（逐条算，不靠肉眼）
npm run palette:audit     # 色板体检（分类色三条约束，会判失败）
npm run markers           # 改了 --brand / --warn 之后重新生成地图 marker
```

**验证链**（`npm run verify`，按顺序）：

```
vue-tsc → check:tokens → contrast:audit → palette:audit → build:mp-weixin → wxss:lint → lib:parity → cloud:smoke → city:smoke
```

各步各管一段：类型 / 令牌漂移 / 对比度闸门 / 色板体检 / 双端构建之一 / WXSS 编译 /
孪生实现（`server/lib` ↔ `cloudfunctions/_lib`）一致性 / 云函数冒烟 / 接口冒烟。

三个颜色闸门（`check:tokens` / `contrast:audit` / `palette:audit`）都在链里，且都是
「有真实缺陷就返回非 0」。单独跑其中一个只是为了看完整表格。
（`palette:audit` 曾经只打印不判定、也不在链里 —— 一份没人看的报告比没有更糟。）

改颜色前先跑 `npm run palette:audit`（色板体检：分类色 vs 语义色的 ΔE、两两距离、对比度），
要换分类色板就改 `scripts/search-palette.mjs` 里的约束再跑 `npm run palette:search`，
它会在候选色池里穷举出满足约束的组合 —— 比凭手感试色靠谱得多。
**它现在是闸门**：分类色三条约束（两两 ΔE ≥ 20 / vs 语义色 ≥ 22 / 压同色浅底 ≥ 3.0:1）
越界就返回非 0。此前它只打印不判定、也不在 `verify` 链里，等于一份没人看的报告。

**三个颜色闸门共用同一份令牌解析**（`scripts/lib/theme-tokens.mjs`），并且会对**解析覆盖率**硬失败。
原因见下面那两段：同一份 hex 正则原来在三个脚本里各写了一遍，而它只认十六进制。

**位图资源的颜色是「烤进去」的**：地图 marker 是 PNG，改 `--brand` / `--warn` 之后
必须跑 `npm run markers` 重新生成（它自己从 `theme.css` 解析颜色，两个副本目录一起写）。
忘了重新生成会被 `check:tokens` 的 ⑦ 抓到 —— 它直接把 PNG 解开读中心像素，不看脚本源码。

**静态闸门和运行时体检的盲区不一样，两个都要跑。** `contrast:audit` 算的是**源码里的规则**，
它看不见「底色来自祖先」的颜色（① 只算同一条规则里同时有 color + background 的配对），
也看不见「被框架样式盖出来的」颜色（禁用态）。所以改完颜色，除了跑上面的闸门，
还要起 H5 用 `agent-browser` 逐页量一遍 `getComputedStyle`：
向上找真实底色、只看元素自己的文字节点、阈值随字号走。
`--line-strong` 被误用三次、uni 内置禁用态 2.1:1 这两类，**全都是运行时先量出来的**。

**同一个旧色值有「两种拼写」**：`#F8F7F4` 和 `rgba(248, 247, 244, 0)`。
`check:tokens` 的 ④ 现在两种都扫 —— 有三处滚动渐变的**透明端**一直写着旧米色的分量，
十六进制搜索完全看不到（`background: linear-gradient(to top, var(--bg-page) 72%, rgba(248,247,244,0))`）。
渐变的「透明端」也必须写目标底色的 RGB：它虽然 alpha = 0，两端插值时会把它带出来。

**同一个颜色的「第二种拼写」还藏在解析层，而且后果比漏检更糟。**
`#66666E` 和 `rgb(102, 102, 110)` 是同一个颜色，但那个只认十六进制的正则会漏掉后者。
两个实测过的假绿灯：

| 换成 `rgb()` 写法的令牌 | 闸门看到的 | 实际发生的 |
|---|---|---|
| `--cat-food`（色板体检） | `✓ ΔE 38.5` / `✓ 3.31:1`，EXIT **0** | 回退成**纯黑**（`\|\| '#000000'`），黑离谁都远 → 三项数字**全部变好看**，真实越界被盖住 |
| `--text-primary`（对比度闸门） | `✓ 37 条配对全部达标`，EXIT **0** | 那个颜色在 `resolve()` 里返回 `null`，① 里一句 `continue` 把配对**丢掉**：45 条 → 37 条。消失的恰好是正文那批配对 |

而且这是**撞运气**：52 个令牌里只有 6 个被 `TOKENS['--x']` 直接解引用（换写法会抛
`TypeError: Cannot read properties of undefined`，退出码虽然非 0，但堆栈指向 `hex.replace`，
没人看得出该改哪儿），另外 46 个换写法就是干净的假绿灯。

所以现在：**解析不到就硬失败，绝不回退默认值、绝不静默跳过**。判定口径是
「不透明的颜色写法（`rgb(r,g,b)` / `hsl()` / 色名）必须能解析，带 alpha 的放行但记账」——
`--hairline: rgba(60, 60, 67, 0.1)` 表达不了成 hex，alpha 本身是信息，它进覆盖率行但不判失败。
光看覆盖率行也能发现漂移：`theme.css 52 条声明，32 条参检；2 条带 alpha 未参检`。

另外，断言写的是「**已参检的**配对全部达标」，所以「配对数缩水」是唯一能让它悄悄放水的路径 ——
① 现在把没能参检的规则逐条列出来（渐变 / 半透明 / 多重背景是正常原因，但必须看得见）。

**颜色只有「从令牌取」这一个来源。** `poster.ts`（海报，canvas 画的）里连 `'#FFFFFF'`
都不许出现，即便它今天正好等于 `bgCard` —— 一律 `P.xxx`；`check:tokens` 的 ⑥ 会扫。
品牌带上的白字用 `P.textInverse` 而不是 `P.bgCard`：两者今天同为白，但「文字」和「卡片底」
是两个角色，混用会让未来的换皮静默出错（这类角色混用在 CSS 里已经栽过一次：`--line-strong`）。

`scripts/serve.mjs`（静态预览）和 `scripts/seed-ui.mjs`（往 localStorage 注入一份演示行程）
是两个纯开发辅助脚本，产出一份带数据的三日成都行程，方便在没有后端的情况下逐页看版式。
城市页的评分面板还得配一份 `travel_cities_v1`（`city.load()` 读的就是它）。



```
src/
├── pages/               页面（13 个）
│   ├── CityMapPage.vue  城市足迹地图（去过/想去 + 攻略/评价）
│   ├── MapPage.vue      行程单天点位路线地图
│   └── SyncPage.vue     云同步（状态 / 分享码 / 凭码加入）
├── components/          通用组件
│   ├── AppIcon.vue      内联 SVG 图标集（40+ 图标，无外部依赖）
│   ├── AppAvatar.vue    头像色块
│   ├── AppSheet.vue     底部弹层
│   ├── AppNav.vue       导航栏
│   ├── AppTabBar.vue    底部标签
│   ├── AppEmpty.vue     空状态
│   └── PosterCanvas.vue 结算海报 Canvas
├── stores/
│   ├── trip.ts          行程 + AA 记账 store（含云端同步：字段级 LWW / 墓碑 / 离线补推 / HLC 盖章 / 实时订阅）
│   └── city.ts          城市足迹 store（独立 storage key）
├── repository/storage.ts  存储适配层（业务数据 / 同步元数据分开存）
├── services/
│   ├── amap.ts          高德 Web Service（POI / 地理编码 / 路线）
│   ├── hlc.ts           混合逻辑时钟（与服务端同格式，含 observe 封顶）
│   ├── lww.ts           字段级合并（server/lib/lww.mjs 的孪生实现）
│   ├── identity.ts      微信登录（uni.login → 后端换 openid → 会话令牌）
│   ├── realtime.ts      实时通道控制器（连接 / 订阅 / 退避重连 / 空闲看门狗）
│   └── backend.ts       共享后端客户端（uni.request + 超时 + 幂等重试）
├── utils/
│   ├── settlement.ts    分摊与结算算法 ★
│   ├── itinerary.ts     行程生成引擎 ★
│   ├── poster.ts        结算海报绘制
│   ├── nav.ts           自定义路由（替代 vue-router）
│   ├── format.ts        格式化与常量
│   └── id.ts            短 ID
├── data/
│   ├── poi.ts           城市点位库
│   └── citiesGeo.ts     城市中心坐标表（足迹地图用）
├── assets/              marker 图标等（构建会发出到 dist）
├── types/index.ts       数据模型（含同步类型）
├── config.ts            高德 Key / 后端地址与开关
└── styles/              主题变量与全局样式

server/                  共享后端（零依赖 Node）
├── index.mjs            入口：请求管线（限流 → 鉴权 → 路由）+ 优雅关闭
├── lib/
│   ├── log.mjs          结构化日志
│   ├── util.mjs         白名单校验 / 截断 / 安全 id
│   ├── db.mjs           SQLite 存储（WAL + 空间级事务 + 旧 JSON 迁移）
│   ├── hlc.mjs          混合逻辑时钟（编码 / 比较 / 封顶 / recordHlc）
│   ├── lww.mjs          字段级合并（逐字段 LWW + 字段戳补全）
│   ├── identity.mjs     微信 openid + 无状态会话令牌（签名 / 校验 / code 换 openid）
│   ├── ws.mjs           RFC 6455 协议层（握手 / 帧编解码 / 纯状态机解析器）
│   ├── hub.mjs          订阅中心（连接 → 空间订阅、通知合并、授权撤销）
│   ├── realtime.mjs     实时网关（upgrade 处理 / 首帧鉴权 / 订阅授权 / 心跳）
│   ├── acl.mjs          空间权限口径的唯一定义处（REST 与 WS 共用）
│   ├── http.mjs         CORS / 安全响应头 / 体积受限的请求体
│   ├── ratelimit.mjs    按 IP 滑动窗口限流
│   └── auth.mjs         共享密钥鉴权
├── routes/
│   ├── auth.mjs         登录（/api/auth/*）
│   ├── guides.mjs       城市攻略 / 评价
│   └── trips.mjs        行程空间同步（字段级 LWW 合并 + 墓碑 + 归属授权 + 变更广播）
├── smoke.mjs            后端冒烟测试（三个隔离实例：功能 + 加固 + 实时）
└── data/travel.sqlite3  运行期数据（已 gitignore）

scripts/
├── lib/theme-tokens.mjs 三个颜色闸门共用的令牌解析 + 解析覆盖率断言（换写法就硬失败）
├── check-token-sync.mjs ① 令牌漂移闸门：CSS ↔ canvas 表 / 地图字面值 / 位图 PNG / pages.json
├── check-contrast.mjs   ② 对比度闸门：① ~ ④、⑥、⑦ 判失败；⑤ 只报告
├── check-palette.mjs    ③ 色板体检：分类色三条约束（ΔE / 对比度）越界即返回非 0
├── search-palette.mjs   在候选色池里穷举满足约束的分类色板（改色板时先用它试算）
├── gen-markers.mjs      生成地图 marker PNG
├── open-devtools.mjs    导进微信开发者工具（含服务端口 / 游客 AppID 两个前置检查）
├── set-appid.mjs        切换小程序 AppID（只改 src/manifest.json 这个源头）
├── lint-wxss.mjs        用工具自带的官方编译器校验产物样式（抓 WXSS 的 `*` 这类非 CSS 限制）
├── uni-mock.ts          在 Node 里模拟 uni 运行时
├── client-sync-entry.ts 客户端同步流程断言（三台设备 + 真实 WebSocket 通道）
└── client-sync-test.mjs 打包并运行上面的断言
```

前三个（`check-token-sync` / `check-contrast` / `check-palette`）都在 `npm run verify` 链里。

## 两个核心算法

### 1. 分摊与结算（`utils/settlement.ts`）

金额一律转成「分」再运算，规避浮点误差。均分时把余数逐个 +1 分发给前几个人，保证份额之和精确等于总额。

结算分两步：

```
净额[b] = Σ(该人支付的金额) − Σ(该人应分摊的份额)
```

然后贪心配对：每轮让「最大债主」收「最大欠债人」的钱，抵消较小的一方。4 个人最多 3 笔转账即完全平账，已用独立脚本验证（净额总和为 0、执行方案后所有余额归零、方向恒为「应付 → 应收」）。

### 2. 行程生成（`utils/itinerary.ts`）

```
候选 POI 打分（偏好标签加权）
  → 拆出远郊点，按天数比例分配（不超过 1/3，倒数第 2 天起往前放）
  → 市内点按地理近邻聚类分天（每天以第一个点为锚，取最近的下一个）
  → 按地理最近原则补餐饮
  → 按 morning/afternoon/evening/night 顺序排时间轴
```

偏好标签（自然/历史/美食/夜生活/艺术/购物/亲子/躺平）直接改变打分权重，无需重新训练。

## 关于技术栈的一个说明

本项目已从纯 H5 迁移为 **uni-app（Vue3 + Vite + TypeScript）→ 微信小程序（mp-weixin）**，`@dcloudio/*` 锁定版本 `3.0.0-5020420260813003`：

- 视图层已映射：`div` → `view`、`localStorage` → `uni.storage`、`window.open` → `uni.openLocation`
- 路由用自定义 `utils/nav.ts`（`nav.to/replace/reLaunch/back`）替代 vue-router，页面参数在 `onLoad(options)` 里取
- 地图用微信原生 `<map>` 组件（gcj-02 坐标，与高德一致），marker 图标从 `src/assets/` 引入（vite 才会发出到 dist）
- 高德 Web Service 经 `uni.request` 调用 `https://restapi.amap.com`
- 仍保留 H5 兼容入口（`npm run dev`），但主交付形态是小程序

H5 与小程序双端的差异已集中在适配层，业务算法（`utils/settlement.ts`、`utils/itinerary.ts`）保持平台无关。

## 已知边界

**同步语义**
- 行程生成是规则引擎，不是大模型。未收录的城市会退回模板演示并在摘要里说明
- 合并是**按字段的 last-write-wins**：两人各改同一条记录的不同字段已能两边都保住；但**同一毫秒改同一个字段**时仍只保一份
- 时钟已换成 **HLC**，不再直接信任设备 `Date.now()`：偏差大的设备被「封顶」限制在 1 分钟量级，且「看到别人改动后再改」的一定排在后面。但「手机时钟快 3 小时」的设备在封顶前仍可能抢赢一次（之后正常时钟会追回来）
- 字段级合并依赖**完整的字段戳映射**（`fhlc`）。没有映射的老记录仍按记录级整条胜负，这是刻意的兼容口径，不是 bug
- 墓碑按条数封顶（3000/空间）。极端量级下最旧的墓碑会被丢弃，理论上存在「久离线设备复活已删记录」的窗口
- **实时只负责「快」，正确性仍由拉取保证**：实时通道断了、通知丢了、重连时错过一批变更，都靠 rev 比对后的补拉兜住。
  所以不要在这条通道上做任何「必须送达」的假设（通知不重发、不乱序补偿、无离线消息队列）
- 冲突时服务端只回 `staleBase: true` 提示「别人改过」，不会阻断或让你二选一

**实时同步**
- **实时订阅不是机密性边界**：订阅时按 `acl` 判定（匿名收不到有主空间的通知），但 `GET /api/trips/:id`
  按 id 读取本来就是开放的 —— 所以「登出后收不到实时通知」不代表读不到内容，主动同步仍能拉回来。
  真要保密得先收紧读取侧，那是另一个决定
- 通知**不保证送达、也不保证顺序**（合并窗口内取最大 rev）。丢了就等下次 rev 比对补拉，属预期行为
- 服务端**只在单进程内扇出**。多副本部署时，A 连实例 1、B 连实例 2，A 的改动不会推到 B ——
  要跨实例得引入 Redis pub/sub 之类的转播层
- 长连接**占 fd**：单实例上限 `WS_MAX_CONNS`（默认 500），超出的连接在握手前收到 503。
  这个数字要按部署机器调，不是「越大越好」
- 反向代理必须放行 `Upgrade` / `Connection` 且读超时 > `WS_PING_MS`，否则连接会被中间层静默掐断
  （现象是「一直重连、状态在 online/offline 之间跳」）
- 小程序端 `SocketTask` 不保证暴露协议层 pong，所以心跳走的是应用层 `{t:'ping'}` 消息而非 PING 帧；
  第三方客户端接入需按应用层心跳实现
- 客户端连接 id（`X-Conn-Id`）只用于「排除发起者」这一个目的，**不是身份凭据** ——
  伪造它最多让自己的另一个标签页收到自己刚提交的改动，没有权限影响

**身份与安全**
- **账号体系已接入，但必须显式配置才生效**：服务端没配 `WX_APPID` / `WX_SECRET` 时 `/api/auth/wx` 回 503，整套回到「昵称 + 分享码」的旧模型。**这时归属判定完全不启用** —— 别以为部署了代码就等于有了权限隔离
- **无主空间仍然是开放的**：接账号体系之前创建的行程没有归属，知道 id 或分享码就能写（这是刻意的兼容口径，不是漏洞）。要用账号体系保护它们，得让用户显式认领（`/claim`，需出示分享码）
- 服务端**不校验「这个人有没有资格改这个行程」**只在**无主空间**上成立；有主空间只认 owner / 成员（`space_members` 表）
- 后端鉴权是**单个共享密钥**（`AUTH_TOKEN`），密钥写在客户端代码里是可被反编译取出的——它只能挡住「扫到端口就写」这类最低成本的风险。它挡不住「拿到密钥的人冒充某个 openid 吗」这个问题 —— 挡得住，因为身份靠 `SESSION_SECRET` 签的令牌，共享密钥只是门禁
- **会话令牌无法单独吊销**：无状态方案的固有代价。丢了令牌只能等过期（默认 30 天）或轮换 `SESSION_SECRET`（会让所有人重新登录）
- **未配置 `SESSION_SECRET` 时**服务端会随机生成一个，进程重启后所有已登录用户需要重新登录 —— 本地开发可以接受，上线必须配
- 分享码 6 位、够用但不抗暴力枚举；正式上线建议配合鉴权与限流（已内置限流）
- 后端是 SQLite + 单进程：并发写在进程内串行化，多副本部署需要换 Postgres 或引入锁服务

**平台**
- 小程序**真机**连不上 `localhost`：真机调试需把 `BACKEND_BASE_URL` 改为电脑局域网 IP，正式版必须 HTTPS 并加入小程序后台「request 合法域名」（`https://restapi.amap.com` 同理）
- 地图用微信原生 `<map>`，marker 数量为城市数（量级小，无性能问题）；路线规划依赖高德 Web Service
- 导航跳转用 `uni.openLocation` 唤起系统/微信地图，不走高德网页版，避免微信内被拦截
- 海报绘制用 Canvas 2D（type="2d" 节点），小程序端已对齐，无需再换 `createCanvasContext`

## 后续可做

| 方向 | 说明 |
|---|---|
| ~~账号体系~~ | ✅ 已完成：微信 openid + 无状态会话令牌 + 空间成员授权（`server/lib/identity.mjs` + `src/services/identity.ts`），见上文「账号（微信 openid）」 |
| ~~实时同步~~ | ✅ 已完成：零依赖手写 RFC 6455 + 订阅中心 + 变更广播（`server/lib/ws.mjs` / `hub.mjs` / `realtime.mjs` + `src/services/realtime.ts`），见上文「实时同步」 |
| ~~逻辑时钟~~ | ✅ 已完成：HLC（`server/lib/hlc.mjs` + `src/services/hlc.ts`），见上文「时钟（HLC）」 |
| ~~字段级合并~~ | ✅ 已完成：逐字段 LWW（`server/lib/lww.mjs` + `src/services/lww.ts`），见上文「字段级合并」 |
| 多副本部署 | 目前 SQLite 单进程；要多实例要用 Postgres / 云数据库，并把 rev 分配做成集中式。实时扇出也需要转播层（Redis pub/sub），否则跨实例收不到别人的改动 |
| 接真实 LLM | 在 `itinerary.ts` 同一入口加 provider，返回结构化 JSON 落到同一套数据结构 |
| 扩城市库 | 往 `data/poi.ts` 加 `CitySeed`；往 `data/citiesGeo.ts` 加城市坐标（足迹地图覆盖更多城市） |
| 多端 | 已迁 uni-app，可平滑加 H5 / App 端（按需放开 `pages.json` 的编译条件） |
