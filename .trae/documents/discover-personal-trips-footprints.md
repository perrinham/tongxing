# 个人行程/足迹 + 发现广场 实施计划

## Context
用户需求：登录小程序后，**每人编辑属于自己的行程与足迹，所有登录用户都能看到**。已与用户对齐：
① 行程个人所有（每人创建/编辑自己的，别人只读），保留分享码共编模式；
② 「所有人可见」= 所有登录用户，新增「发现/广场」入口，列表 + 只读详情。

现状核查结论：
- 行程：`GET /api/trips` 带身份已只返回「我参与的 ∪ 无主」（[trips.mjs](file:///Users/a1111/WorkBuddy/2026-09-16-11-50-05/server/routes/trips.mjs#L733-L742)），写路径 `accessVerdict` 已护住（[acl.mjs](file:///Users/a1111/WorkBuddy/2026-09-16-11-50-05/server/lib/acl.mjs#L48-L63)）——「每人编辑自己的」服务端已成立，缺的只是广场列表 + 只读详情。`GET /api/trips/:id` 本就开放读，详情可直接复用。
- 足迹：服务端 guides 表已是「per (城市,作者+openid) 归属 + 所有人可读」模型（[guides.mjs](file:///Users/a1111/WorkBuddy/2026-09-16-11-50-05/server/routes/guides.mjs)），但客户端 markCity/setStatus/saveGuide 只写本地不推后端，且登录后无法按 openid 拉回自己的足迹（无 `/api/my/guides`，db 也无 listGuidesByOpenid）。

## 服务端改动

### 1. db.mjs
- 新增 `listGuidesByOpenid(openid)`：`SELECT * FROM guides WHERE author_openid=? ORDER BY updated_at DESC`（走现成 `idx_guides_openid`），复用 `assembleGuide`（自动剥 authorOpenid）。
- 新增 `listSpacesBriefForDiscover(viewerOpenid)`：全部未删除空间 brief + `mine` 标记（owner===viewer 或是成员）。不复用 listSpaces（过滤语义不同）。

### 2. guides.mjs — `GET /api/my/guides`
- 需登录（`req.identity?.openid` 为空 → 401）。返回 `{ guides: [...] }`（无 authorOpenid）。

### 3. trips.mjs — `GET /api/trips/discover`
- 需登录（401）。返回全部未删除空间 brief + `mine` 布尔。
- ⚠️ 路由匹配插在 `by-code` 分支附近、`/^\/api\/trips\/([^/]+)$/` 之前（否则 "discover" 被当 spaceId）。
- ⚠️ **`mine===false` 的条目必须删掉 `code` 字段**（泄漏分享码 = 别人 join 后拿到写权，绕过只读）。服务端裁剪，不靠客户端忽略。

## 客户端改动

### 4. types + backend.ts
- `src/types` 加 `DiscoverTrip`（brief + `mine: boolean`，`code?: string`）。
- `BackendClient` 加 `getMyGuides()`、`listDiscoverTrips()`（均 retry:1）。`getSpace` 已有。

### 5. city.ts — 自动发布 + 回拉
- `markCity`/`setStatus`/`saveGuide` 末尾 fire-and-forget 发布（per-city in-flight Promise 去重，防连点风暴；失败仅本地，不打扰 UI）。
- 发布昵称兜底：昵称为默认「我」时，用 `storage.readSync().identity.openid` 后 4 位派生「旅人xxxx」，避免多人默认昵称撞 (城市,作者) 唯一键 → 403 静默失败。
- `removeCity` 内联 retractMyGuide；CityMapPage.vue 删掉页面层重复调用（L170）。
- 新增 `syncMine()`：`getMyGuides()` 按 cityName 合并进 passports（updatedAt LWW，只合并不删除）；`load()` 末尾触发（已登录时）。

### 6. 页面注册与导航
- [pages.json](file:///Users/a1111/WorkBuddy/2026-09-16-11-50-05/src/pages.json) 加 `pages/DiscoverPage`、`pages/TripViewPage`（navigationStyle custom）。
- `utils/nav.ts` ROUTES 加 `discover`、`trip-view`。
- [AppTabBar.vue](file:///Users/a1111/WorkBuddy/2026-09-16-11-50-05/src/components/AppTabBar.vue) tabs 加 `{ key:'discover', label:'发现', icon:'sparkle' }`（6 个 tab）。

### 7. DiscoverPage.vue（广场）
- 骨架照现有 tab 页（AppNav + AppTabBar current="discover"）。
- 区块一「大家的行程」：discover 列表，`mine` 加「我的」徽标；点击 → 我的跳 itinerary，他人的跳 trip-view。
- 区块二「大家的足迹」：`getAllCities()` 聚合 城市 → 作者昵称 + visited/wish 徽标。

### 8. TripViewPage.vue（只读行程详情）
- `onLoad(options.id)` → `getSpace(id)` 渲染：标题/目的地/日期 → 按天条目 → 花销汇总。纯展示，**不写入 trip store**（避免污染本地 LWW）。
- 有 code（=我的行程）时显示「进入编辑」跳 itinerary；他人行程不显示。

### 9. ItineraryPage 微调
- 标题/空态文案改「我的行程」语义（现状列表已是"我的"）。

## 测试（照现有模式）
- `server/smoke.mjs`：① 登录 A 建 2 空间、B 建 1 → B discover 见 3 条、仅 B 的 `mine:true`、非 mine 条目无 `code`；匿名 401；删除后不出现。② `/api/my/guides`：A upsert 2 城 → A 得 2、B 得 0、匿名 401。
- `scripts/city-smoke-entry.ts`（已覆盖 publish 契约，最顺）：markCity 后 `/api/my/guides` 可查到；他人 upsert 后 syncMine 只合自己的。

## 验证与交付
1. `npm run typecheck`（0 错）
2. `npm run server:smoke`、`client:smoke`、`city:smoke`（全绿，不跑 amap:smoke——未动 itinerary/cityPoi 路径）
3. `npm run devtools:build` 同步微信开发者工具
4. 重启后端（`WX_DEV_LOGIN=1 SESSION_SECRET='local-dev-secret-please-change' node server/index.mjs`，:8787）
5. 日志追加 `.workbuddy/memory/2026-09-18.md`
6. 汇报用户在开发者工具里怎么看：发现 tab → 广场列表；两个微信号分别登录验证「各自编辑、互相可见」。

## 风险备忘
- discover 泄 `code` → 已设计服务端裁剪。
- publishMyGuide 并发 → per-city in-flight 去重。
- 昵称撞车 403 → openid 派生兜底昵称。
- 换昵称后 my/guides 同城多条 → syncMine 按 updatedAt 取最新。
