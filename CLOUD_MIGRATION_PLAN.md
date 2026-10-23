# 微信云开发迁移清单（路 B）

> 目标：把现有自建后端 `server/`（Node + SQLite）迁移到微信云开发（云函数 + 云数据库），
> 让"只发体验版、不上线"的小程序能真用登录 + 云同步，且 0 元。
> 适用范围：纯前端数据访问层重构，**不动 UI / 业务层（stores 的 LWW 合并、HLC、组件）**。
> 探查依据：`server/index.mjs`、`server/routes/*`、`server/lib/db.mjs`、`src/services/backend.ts`、
> `src/services/realtime.ts`、`src/services/backendBase.ts`、`src/config.ts`。

---

## 〇、费用结论（先说，避免误判）

- 微信云开发 **FREE 免费体验版 ¥0/月**（3000 资源点/月，每账号 1 个免费环境）。
- "免费云环境活动"（截止 2026-12-31）：小程序**未发布上线**阶段免费；**正式发布上线后自动转 19.9元/月**。
- 本项目"只发体验版、不上线" → **0 元**。免服务器、免域名备案、免 HTTPS、免 request 合法域名（mp 端 callFunction 走微信内网）。
- 免费档不支持按量付费：额度用尽即停用、**不会自动扣费**（对体验项目安全）。配额：调用 20万次/月、2GB、QPS 500，几个人玩够用。
- ⚠️ 一旦哪天正式发布，才转 19.9元/月——与"只体验"无关。

---

## 一、云环境准备

1. 微信公众平台 → 开通云开发 → 新建环境，拿到 **env id**。
2. 前端入口（`src/main.ts` 或 `App.onLaunch`）调用 `wx.cloud.init({ env: ENV_ID })`。
   - env id 非敏感，可从 `import.meta.env.VITE_CLOUD_ENV_ID` 注入（照 `config.ts` 现有 `VITE_AMAP_WEB_KEY` 范式）。
3. 控制台确认免费环境配额；记录"上线后会转付费"提醒（贴给未来的自己）。

---

## 二、数据库迁移（SQLite → 云数据库·文档型）

4. 建集合（对应现有表 `server/lib/db.mjs`）：
   - `spaces`：文档，含冗余投影 `title/destination/start_date/end_date/owner_openid/code/rev/digest/retired_codes`。
   - `records`：每条记录一个文档，`_id` 建议 `spaceId:kind:id`；字段 `space_id/kind/id/updated_at/hlc/data(JSON)`（沿用"整条记录存 JSON"的黑盒策略）。
   - `tombstones`：`(space_id,kind,id)` 唯一。
   - `guides`：`city_name/author/author_openid/status/data`（status 提列，其余进 data JSON）。
   - `space_members`：写权限判定用（现有逻辑按成员集合判"谁可写"）。
5. 建索引：`code`、`owner_openid`、`updated_at(DESC)`、`city_name`、`author_openid`。
6. **LWW 合并逻辑改造**（关键）：云数据库是文档型，没有"按复合主键 upsert + 比较 hlc"那么直接。改为：
   - 先查目标记录当前 `hlc` → 应用层比较（沿用 `server/lib/hlc.mjs` 的 `hlcAfter`）→ `db.collection('records').doc(id).set()`（带 `_id` 幂等）。
   - 保持合并**幂等**（重复投递无副作用），与现有 POST `/api/trips/:id` 的幂等语义一致。
   - 注意单文档写并发：依赖 hlc 比较 + set 的天然覆盖，必要时用 `db.command` 做条件更新。
7. **数据迁移脚本**（一次性）：读 `server/data/travel.sqlite3` → 用 CloudBase Node SDK 批量写入上述集合。
8. **安全规则**：推荐"所有用户可读、仅云函数可写"，身份判定全收在云函数里（避免前端直连越权）；`space_members`/`guides` 的归属判定用 `cloud.getWXContext().OPENID`。

---

## 三、REST 端点 → 云函数

> 现有端点（`server/routes/*`）：auth(`/api/auth/wx|me|logout`)、trips(`/api/trips*`)、guides(`/api/cities*` `/api/guides*` `/api/my/guides`)、weather(`/api/weather`)、health。

9. 按模块拆云函数（每个路由文件 → 一个云函数，或聚合为 `auth`/`trips`/`guides`/`weather` 四个）：
   - `auth`：**用 `cloud.getWXContext().OPENID` 直接拿 openid，不需要 AppSecret / 自己 code2session**——云开发最大安全红利。authMe / logout 简化。
   - `trips`：list / join / discover / by-code / get / push(LWW 合并) / claim / delete。
   - `guides`：cities / my-guides / upsert / update / delete / retract。
   - `weather`：代理 Open-Meteo。**云函数可出网，且不受小程序 request 合法域名限制**（mp 端 callFunction 走微信内网）。
   - `health`：可省，或保留为返回环境状态的云函数（SyncPage 展示可达性）。
10. **鉴权改造**：去掉 `AUTH_TOKEN` 共享密钥门禁（云开发环境本身受微信鉴权保护）；身份统一 `cloud.getWXContext().OPENID`。`X-Session-Token` 可保留（前端缓存 openid 自用）或简化为直接传 openid。
11. **限流/审计**：现有 `ratelimit.mjs` 的 IP 限流在云函数里语义变化（无稳定客户端 IP）；可改按 openid 简单频控，或先去掉——免费额度本身就是天然上限。

---

## 四、实时同步改造（最大变化点）

> 现状：`realtime.ts` 原生 WebSocket `/api/ws`（订阅空间 + 服务端推 `{t:'update',id,rev}` 通知，客户端补拉）。云开发**没有原生长连 WebSocket 让你自建**，这套逻辑搬不过去。

12. 二选一：
    - **方案 A（推荐先上，零成本）**：**删除实时同步层**，退化回现有"拉模型"——冷启动拉、回前台拉、定时拉。
      理由：`realtime.ts` 本就是"加速层非可靠层"，断了靠补拉保证最终一致；删 WS 不影响一致性，改动最小。
      代价：同屏协作不是毫秒级（同行改账单要等下次拉取才看到）。
    - **方案 B（要同屏协作再上）**：用云数据库 **`watch`**（`collection.watch` / `doc.watch`）监听空间变更 → 收到事件后拉该空间。
      注意：watch 有**并发连接数限制**（需按需订阅/退订）；**先确认免费环境是否支持 watch**（部分高级能力免费档受限）。
13. 前端 `realtime.ts`：方案 A 下整个文件可删（或 `RealtimeStatus` 恒 `'disabled'`）；方案 B 下重写为基于 `db.collection('spaces').watch()` 的订阅。

---

## 五、前端数据访问层改造（`src/services` + `src/config`）

14. `backend.ts`：把 `uni.request(http)` 换成**云函数调用**。抽象 `invoke(name, action, data)` 适配层：
    - mp 端：`wx.cloud.callFunction`（走微信内网，免 request 域名配置）。
    - H5 端：云开发 **Web SDK**（`@cloudbase/js-sdk` 的 `callFunction`）+ 需开"允许 Web 端" + 配"网页授权域名" + 用户走微信网页登录拿 openid。
    - 现有 `BackendClient` 接口（health/wxLogin/getCityGuides/listSpaces/pushSpace…）**签名不变**，只换实现，store 层无需动。
15. `backendBase.ts`：删除"设备级覆盖后端地址"逻辑（云开发无自定义地址）；或改为"云环境 env id"配置。
16. `config.ts`：删除 `BACKEND_BASE_URL` / `REALTIME_PATH` 的 http 语义；新增 `CLOUD_ENV_ID`（从 `VITE_CLOUD_ENV_ID` 注入）。
17. **登录流程**：`wxLogin` 不再 POST code 给自建后端；mp 端 `callFunction('auth',{action:'wxLogin'})`（context 里直接有 OPENID，连 code 都不用传）；H5 端需公众号 OAuth 拿 code → callFunction 传 code。
18. **天气**：`getWeather` → `callFunction('weather',{place,start,end})`，云函数内代理 Open-Meteo。

---

## 六、双端差异（重要坑）

19. **mp-weixin 端**：`wx.cloud.callFunction` 走微信内网，**无需 request 合法域名、无需 HTTPS 域名备案**——云开发相对自托管最省心，开箱即用。
20. **H5 端**：云开发 Web SDK 需（a）云环境开"允许 Web 端"（b）配置网页授权域名（c）H5 用户身份走公众号 OAuth 或匿名/自定义登录。复杂度明显高于 mp。
    - 若 H5 只是你自己的预览/走查用，可**暂不接**（或仅 mp 体验），mp 跑通再补 H5。

---

## 七、验证链 / 测试改造（项目纪律）

21. 现有 `verify` 链里的 `city-smoke` / `client-sync` 等 Node 测试**直接调 `server/` 的 HTTP 接口**。迁移后：
    - 推荐改为用 **CloudBase Node SDK 直连云数据库**断言（LWW、越权拒绝、批量认领等断言逻辑原样保留）。
    - 或保留 `server/` 为"自托管备选"双轨测试（不推荐，维护两份）。
22. mp 端走查脚本 `scripts/mp-walk.mjs`：确认 callFunction 路径通、无 `[app-err]` 运行时异常。
23. 双端 `build:h5` + `build:mp-weixin` 仍须 DONE（H5 若暂未接云开发，需保证其构建不崩、给出"云同步不可用"的优雅降级）。

---

## 八、不动的部分

24. `server/` 目录：云开发路线下不再被前端使用，可整体保留为"自托管备选"或删除；原 `server/backup.mjs`（HF 容器备份）等只在自托管路线有意义。
25. 前端业务层（stores 的 LWW 合并、HLC、UI 组件）基本不变，只换数据访问层（`src/services/*`）。

---

## 九、部署 / 运维

26. 云函数上传：微信开发者工具右键"上传并部署"云函数，或 CloudBase CLI。
27. 免费额度监控：控制台看资源点消耗，避免超额停用（免费档超额即不可用、不扣费）。
28. 上线提醒：正式发布才转 19.9元/月——与"只体验"无关。

---

## 推荐执行顺序（最小风险）

1. 开环境 + `wx.cloud.init` + 建集合 + 写迁移脚本导数据（二、一）。
2. 先搬 `auth` + `guides`（逻辑简单、无实时同步）→ 改 `backend.ts` 适配层 → mp 端验证登录 + 攻略同步。
3. 再搬 `trips`（含 LWW 合并）→ 验证行程空间同步。
4. `weather` 云函数（简单代理）。
5. 实时同步：先方案 A（删 WS，纯拉），跑通体验；要同屏协作再上方案 B（watch）。
6. 改造 `verify` 链测试 → 双端构建 → mp 走查。

---

## 十、执行结果（代码已完成，部署需手动）

### 已完成（本仓库内可验证）

- 云函数 4 + 1：`cloudfunctions/{auth,trips,guides,weather,migrate}`，各带独立 `_lib` 副本（生成物）。
  共享源只有 `cloudfunctions/_lib/`，`npm run cloud:sync-lib` 分发；`wx-server-sdk@^4.0.2`。
- 前端双轨适配：`src/services/cloud.ts`（`hasCloud`/`initCloud`/`callCloud`）、`src/services/backend.ts` 逐方法分流
  （`hasCloud()` 为假走原 HTTP）、`src/services/backendError.ts`（`BackendError` 迁出以破循环依赖）。
- `src/config.ts` 增 `CLOUD_ENV_ID`/`CLOUD_ENABLED`（读 `VITE_CLOUD_ENV_ID`）；`src/App.vue` onLaunch 调 `initCloud()`。
- `src/services/realtime.ts`：`hasCloud()` 为真时返回 `status:'disabled'` 的 no-op 控制器（**方案 A**），`trip.ts` 零改动。
- 构建链：`scripts/cloud-lib-sync.mjs`、`scripts/patch-mp-cloud.mjs`（拷 `cloudfunctions/` 进产物 + 写
  `cloudfunctionRoot:"cloudfunctions/"`）、`scripts/cloud-smoke-test.mjs`（内存版 `wx-server-sdk` 驱动真实云函数）。
- 迁移：`scripts/migrate-export.mjs`（`node:sqlite` 读库导出快照）+ `migrate` 云函数（幂等导入）。
- 验证：`typecheck` / `server:smoke` / `client:smoke` / `city:smoke` / `cloud:smoke` 全绿；`build:mp-weixin` 成功。

### 已部署到真实云环境（env `cloud1-d9gujmuaxb69ab976`）

用 DevTools CLI（`cli cloud functions deploy`）把 `auth`/`trips`/`guides`/`weather` 传上去了
（Node 16.13 运行时，`--remote-npm-install`），集合也建好了。真机侧走查与体检：

- `scripts/cloud-setup.mjs`（npm `cloud:setup` / `cloud:verify`）：从**小程序运行时**里调真实云函数
  （开发者工具自动化端口 `cli auto --auto-port 9420`，协议同 `mp-walk.mjs`，手写 JSON-RPC 避开
  `miniprogram-automator` 的未监听 error 事件崩溃）。`cloud:verify` 覆盖：建集合、`auth` 登录（拿到真 openid）、
  `trips list`、`guides listCities`、`weather` 冷/热调用、以及**写路径往返**（push → get → delete → list）。
- `scripts/mp-walk.mjs` 走查 4 个页面：0 异常。同步页显示后端「可达」时本机 8787 并没有服务在跑 ——
  即这一次健康检查是经**云函数**完成的（`hasCloud()` 为真、env id 已打进产物 `config.js`）。
- 真机部署暴露并修掉了 2 个 mock 覆盖不到的坑：
  1. **`ensureCollection` 只判 `errCode` 失灵**：真实「集合已存在」有时只给 `errMsg`。第二次 `setup` 直接 500。
     现改为 errCode 与文案双判；`cloud:smoke` 的假 `createCollection` 也改成两种形态各造一次，避免再次漏测。
  2. **`weather` 默认超时 3 秒不够冷启动**：首次调用 `FUNCTIONS_TIME_LIMIT_EXCEEDED`，热调用仅 ~0.5 秒。
     需在控制台把该函数超时调到 20 秒（唯一需要出网的函数）。`cloudfunctions/*/config.json` 的 `timeout` 字段
     对 IDE 部署**无效**（实测仍是 3 秒），别指望它。
- 说明：`migrate` 云函数**没有**上传（历史数据迁移按需再做）；索引也**没建**（控制台才能建，数据量小时不影响跑通）。

### 深查发现（第一轮体检之后补做，均已修）

1. **云数据库单次查询只返回 1000 条 → 会把大空间静默截断（最严重）**。
   自托管侧 SQLite 没有这个限制，`KIND_LIMITS`/`MAX_TOTAL_RECORDS`（单空间最多 20000 条）是
   照搬过来的，于是云侧 `whereGet` 的「一次 `limit(1000)` 读完」在空间超过 1000 条记录时截断。
   后果不只是「少读几条」：`push` 的 `saveSpace` 是「先按 `space_id` 清空 `records` 再按读到的写回」，
   被截断的部分会**永久消失**，并随下一次 pull 扩散到所有设备。
   已修：`whereGet` 按 `_id` 排序 + `skip` 翻页读全；`whereRemove` 循环删到删不满一页为止
   （单次批量删除同样有 1000 量级上限，两种语义下都收敛）。
   ⚠️ 触发线是**单空间 1000 条**（当前真实数据最多 42 条，尚未触发）。
2. **假 `wx-server-sdk` 比真云数据库宽松，让上面这类 bug 在本地永远测不出来**。
   内存版 `.limit()` 原本是空操作、`get()` 直接返回整表。现已按真实语义实现
   （不写 limit 默认 100 条、上限 1000 条、支持 `skip`/`orderBy`、批量删除单次封顶 1000），
   并加了 1200 条记录的用例：`push` 往返、`get`、`list withDoc`、二次 `push` 全覆盖。
3. **两张实现是否会漂移，此前只靠注释约定**。`hlc` / `lww` / `acl` 在 `server/lib/*.mjs`（自托管）
   与 `cloudfunctions/_lib/*.js`（云函数）各有一份，文件头写着「语义必须严格一致」，但没有测试守着。
   新增 `npm run lib:parity`（已接入 `test` 与 `verify`）：同一进程里两边各 import/require 一份，
   喂同一批语料（缺 hlc、陈旧 fhlc、时钟超前、t/c 上限、非法节点字符、60 字段表……）逐项深比较，
   当前 **738 项全部一致**。
   注：脚本 require 的是**分发副本**（`cloudfunctions/<fn>/_lib/`）而不是唯一源 —— 源目录最近的
   `package.json` 是仓库根的 `"type": "module"`，Node 会把源文件当 ESM 加载并报 `require is not defined`。
4. **`amap:smoke` 里一条陈旧断言**（与本迁移无关，顺手修）：用例「完全断网回退本地模板」是迁移前的
   旧语义 —— `generateItineraryAsync` 早已改成「陌生城市抓不到就明确抛错」，且 `cityPoi` 有会话级
   `seedCache`，用刚在线抓过的城市测断网会命中缓存、**什么都没测到却全绿**。
   现改为：断网 + 全新陌生城市（洛阳）→ 断言抛错且文案含城市名；断网 + 内置城市（成都）→ 断言照常出计划。

### 遗留观察（未改，供决策）

- **`MAX_TOTAL_RECORDS = 20000` 在云路径上不可达**：这是 SQLite 时代的上限，而云侧每次 `push` 都要
  「清空 + 全量重写」，按 `writeDocs` 每批 20 条、每批一个往返估算，几千条已逼近 20 秒函数超时，
  两万条必然超时。要么把云侧上限下调（但要考虑存量空间会被 413 挡住、无法同步），要么改成只写变更记录。
- **`changed === false` 时仍全量重写**：客户端每个同步周期都会 `push` 一次，多数时候内容没变，
  但 `saveSpace` 照旧删除 + 重写全部 `records`。云数据库按写次数计费，大空间下这是纯浪费
  （自托管侧是逐条 upsert，没有这个问题）。最小改法是 `changed === false` 且无需登记成员时直接返回。

### 与计划的口径差异（有意为之）

- **§2.6 LWW**：未做「按复合主键条件更新」，改为**整空间 load→merge→save**（`saveSpace` 先按 `space_id`
  清空 `records`/`tombstones` 再全量重写）。同空间并发写的丢失由客户端 pull+push 的 LWW 自愈——已有评估，可接受。
- **§2.7 迁移**：不用本地 CloudBase Node SDK + 密钥，改「导出 JSON → 云内 `migrate` 函数导入」，
  因为 `wx-server-sdk` 本地直连需另配 secretId/secretKey 且难在本机验证；云端导入天然幂等、可重跑。
- **§4.12 实时**：取方案 A（no-op 控制器），未删 `realtime.ts`，保留方案 B（`watch`）的接入口。
- **§5.14 H5**：未接云开发（H5 无 `wx.cloud`，自动走原 HTTP）；云通道**仅 mp-weixin**。
- **§6.19**：`cloudfunctionRoot` 是产物内相对路径 `cloudfunctions/`（计划草稿里的 `"../cloudfunctions/"` 不成立）。
- **§7.21 测试**：未改成 CloudBase 直连断言，而是用内存版 `wx-server-sdk` 驱动真实云函数（离线、无凭证）；
  `server/` 与 `client:smoke` 双轨保留。真实环境的验证由 `cloud:verify`（需 IDE）承担，不进 `verify` 链。

### 待手动（本机做不了）

1. **建索引**（控制台，SDK 建不了）：见 README 清单。
2. **`weather` 超时改 20 秒**（控制台 → 云函数 → weather → 配置）。
3. **迁移历史数据**（可选）：`npm run migrate:export` → 传 `migrate` → `{"action":"plan"}` → `{"action":"run"}` → 删掉 `migrate`。
4. **真机（手机）预览**：模拟器已走查通过，但 `uni.login` 的真 code、真机网络环境只能在手机上验
   （体验版二维码扫码）。注意模拟器里可能残留 HTTP 时代的旧 dev 身份（`wxs_…`，`dev:true`），
   真机是全新存储，不会受影响。
5. 控制台盯资源点用量；正式发布才转 19.9元/月。
