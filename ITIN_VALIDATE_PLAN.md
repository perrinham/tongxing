# AI 行程校验器 · 实现计划

> 方向：AI 生成行程后跑一轮机械校验，问题打「待核实」角标；生成人人会做，核验是差异化。
> 状态：待确认，确认后进入开发

---

## 0. 结论先行

| 项 | 决策 |
|---|---|
| 定位 | 生成完成 → 自动校验 → 冲突高亮 + 一键修复入口。**不重新生成，只标注** |
| 实现 | 纯前端函数 `src/utils/itinCheck.ts`，输入 `Day[] + ItineraryItem[]`，输出问题列表。无状态、可单测 |
| 落地分两级 | ① 机器校验：**运行时计算、不落盘不进同步**（幂等重算）；② 人工核销：`ItineraryItem.verifiedAt` 一个字段，进fhlc 参与同步 |
| 依赖 | 复用 `src/services/amap.ts` 的 walking/drivingRoute；同一天 pair 结果做内存缓存，避免限流（历史上有过限流教训） |
| UI | TripViewPage 顶部摘要条 + 行程项角标（⚠ 待核实 / ✓ 已核实）+ 逐条问题详情 |
| 工期 | ≈ 2.5 天：校验器 1d + amap 集成与缓存 0.5d + UI 0.5d + 测试 0.5d |

---

## 1. 校验规则清单（机械可测，按优先级）

| # | 规则 | 级别 | 判定 |
|---|---|---|---|
| R1 | 时间倒挂/重叠 | error | 同日相邻两项（time 非空）：a.time + a.duration > b.time；或 order 顺序与 time 顺序矛盾 |
| R2 | 日程超载 | warn | 当日 duration 总和 > 11h（醒着上限），提醒过于紧凑 |
| R3 | 移动时间缺口 | warn | 相邻两 POI 直线距离 > 3km 且之间无 transport 项；或 amap 路线耗时 > 两项间隔 − 停留时间 |
| R4 | 缺交通项（短途裁定） | warn | 距离 < 30km 未插入 transport → 建议「步行/打车」文案；> 30km 属跨城另走 R5 |
| R5 | 跨城/坐标异常 | error | 同日两项直线距离 > 200km（除 transport 大项外）；lat/lng == 0 或缺失 |
| R6 | 字段质量 | warn | title/address 为空、cost < 0、duration <= 0、time 非法格式 |
| R7 | 同 POI 重复 | warn | 同日两项直线距离 < 50m 且标题相似 |

规则跳过条件：`time` 为空的项不参与 R1/R3 的时间侧；用户手动新增/修改过的项不重跑 R4 的「建议」。计费调用只发生在 R3/R5 的路线查询，其余纯几何/字段检查零成本。

## 2. 数据结构与触发点

```ts
// src/utils/itinCheck.ts
export interface CheckIssue {
  rule: 'R1'|'R2'|...|'R7'
  level: 'error' | 'warn'
  itemId?: string          // 关联行程项；R2 挂 day
  dayId?: string
  title: string            // 给用户的一句话
  hint?: string            // 建议/一键修复动作说明
}
export async function checkItinerary(days: Day[], items: ItineraryItem[]): Promise<CheckIssue[]>
```

**触发点**：
1. `TripGeneratePage` 生成完成、入库后跑一次
2. 打开 `TripViewPage` 时物料汇总后跑（amap 结果走缓存，二次打开近零成本）
3. 用户编辑保存后仅重算受影响 day（纯几何部分全量重算也无妨，成本为 0）

**同步边界**：CheckIssue 本身**不持久化、不进 LWW**（每次可从现有数据重算，避免碰 fhlc 完整性要求）。唯一新增的持久化字段是人工核销：

```ts
// ItineraryItem 增加一个字段；必须在 lww 合并字段清单里补齐（fhlc 必须完整）
verifiedAt?: number   // 用户确认过「这条信息属实」的时间戳，0 = 未核实
```

## 3. amap 集成与限流保护

- 只对**同日相邻 pair** 调 route（一天 N 项最多 N−1 次，通常 4–7 次/日）
- pair 缓存：`Map<tripId_day_idx, RouteResult>`，进程内生命周期即可
- 沿用项目既有限流治理（`src/config.ts` / amap 服务已有重试与错误路径），校验器侧对任何 amap 失败**静默降级**：不阻塞行程展示，该规则只标「待核实（未能核验）」不标 error
- 小程序端 amap 域名白名单已配置（现有地图/POI 功能在用），不新增域名

## 4. UI（沿用现有浅色卡片风）

1. **TripViewPage 摘要条**：`⚠ 3 条待核实 · 1 处时间冲突`，点击滚到第一个问题项。全绿时显示 `✓ 已通过校园校验`（复用现有 AppEmpty/组件风格）
2. **item 卡角标**：未核实的 AI 生成项显示 `待核实`；点击后展示该条问题 + 「已在现场确认」按钮写 `verifiedAt`
3. **问题详情浮层**：列出规则、两地点、amap 实测耗时 vs 预留时间、建议文案；R3 场景提供「插入交通项」一键修复（复用现有 ItemEditPage 流程，transport 预填距离/耗时）

## 5. 测试与验收

- 新增 `scripts/itin-check-test.mjs`：固定用例覆盖 R1–R7（重叠、倒挂、超载、3km 缺交通、200km 跨城、脏字段、重复项、全绿用例）+ amap 失败降级路径（mock service）
- 参照 `npm run city:smoke` 的脚本形态，单测优先纯几何规则，R3/R5 的 amap 分支用注入 fake route 服务测逻辑
- 验收口径：改行程触发重算、换设备打开不依赖同步字段就能看到「待核实」角标；`verifiedAt` 在双端同步后保持一致（补进 lib:parity 的孪生实现）

## 6. 风险与不做的事

- **不做**「AI 自动重排」：标注定位，重排是另一个项目
- **不做**营业时间/门票价格核对：用「待核实」角标引导用户点击确认，而不是伪造确切性
- 出境行程（海外坐标）amap 路线查不到是常态，R5 的跨城规则改为距离判定，全部静默降级为「待核实」
