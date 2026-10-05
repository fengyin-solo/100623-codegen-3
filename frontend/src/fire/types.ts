/**
 * 消防器材与应急演练一体化清单 —— 领域类型。
 * 纯前端数据层：所有台账与业务单据在同一个本地状态里提交，换回后端时只换 store 的持久化实现。
 */

export type RuleVersion = 'v1' | 'v2'

export type ExtinguisherType = '干粉' | '二氧化碳' | '水基'

/** 器材业务状态：在值可执勤；待充装＝已送修未回厂（区域执勤缺位）；已报废＝离位消账 */
export type EquipmentStatus = '在值' | '待充装' | '已报废'

export type HazardGrade = '正常' | '一般隐患' | '严重隐患' | '重大隐患'

/** 出厂日期补齐口径（缺出厂日期的存量器材，按采购批次回填） */
export type ManufactureSource = '原始' | '批次最早出厂日补齐' | '批次验收日倒推90天补齐'

/** 数据来源：两边取值冲突时按数据治理口径仲裁后的采信来源 */
export type DataSource = '资产台账' | '班组自报' | '两源一致' | '冲突仲裁' | '先落库单据'

/** 按当前规则版本实时算出的结论；换版即整体重算 */
export interface Conclusion {
  ruleVersion: RuleVersion
  scrapDue: string
  refillDue: string
  needsRefill: boolean
  needsScrap: boolean
  warning: boolean
  grade: HazardGrade
  reasons: string[]
  calculatedAt: string
}

export interface HistoryEvent {
  at: string
  text: string
  ruleVersion: RuleVersion
}

export interface Extinguisher {
  /** 器材编号：老数据迁移沿用原有编号，不重新发号 */
  id: string
  type: ExtinguisherType
  model: string
  area: string
  crew: string
  batchId: string
  purchaseDate: string
  manufactureDate: string
  manufactureSource: ManufactureSource
  pressure: '正常' | '欠压' | '过压' | '未检'
  seal: '完好' | '破损' | '未检'
  location: '在位' | '缺失' | '未检'
  corrosion: boolean
  status: EquipmentStatus
  sentAt?: string
  returnedAt?: string
  lastRefillDate?: string
  dataSource: DataSource
  conflictNote?: string
  conclusion: Conclusion
  history: HistoryEvent[]
  /** 实体级版本号：并发提交时的比对依据，谁先落库谁占用 */
  rev: number
}

export interface PurchaseBatch {
  id: string
  type: ExtinguisherType
  model: string
  /** 采购验收日期：整批缺出厂日时，按它倒推90天补齐 */
  purchaseDate: string
  /** 批次内已知的最早出厂日期：部分缺失时按此补齐 */
  knownManufactureDates: string[]
  supplier: string
}

export interface OrderItemResult {
  id: string
  ok: boolean
  reason: string
  before: string
  after: string
}

/** 充装单 / 报废单：按区域多选多台器材，一次提交，逐台结果 */
export interface BusinessOrder {
  id: string
  kind: '充装' | '报废'
  idempotencyKey: string
  areas: string[]
  operator: string
  items: string[]
  results: OrderItemResult[]
  /** 充装单：已送充 -> 已回厂；报废单：已报废 */
  status: '已送充' | '已回厂' | '已报废'
  submittedAt: string
  returnedAt?: string
  /** 同一张单重复提交的后到记录：后到的整套退回，只留痕 */
  repeatAttempts: { at: string; operator: string; message: string }[]
  rev: number
}

export type Slot = '上午' | '下午' | '夜间'

export interface DrillPlan {
  id: string
  idempotencyKey: string
  area: string
  crew: string
  date: string
  slot: Slot
  scenario: string
  /** 已排期即占用 区域+日期+时段；已取消立即释放，不拦后续班组 */
  status: '已排期' | '已完成' | '已取消'
  createdAt: string
  cancelledAt?: string
  finishedAt?: string
  rev: number
}

export type HazardStatus = '未整改' | '整改中' | '已闭环'

export interface Hazard {
  id: string
  source: '现场巡视' | '充装处理回写' | '报废处理回写' | '迁移结论回写'
  refOrder?: string
  equipId: string
  area: string
  description: string
  /** 结论形成时的等级：换版后旧结论保留当时等级，只在旁边注明版本与新版建议 */
  grade: HazardGrade
  ruleVersion: RuleVersion
  status: HazardStatus
  concludedAt: string
  closedAt?: string
  note?: string
}

export interface ArchiveCount {
  pageCount: number
  archivedCount: number
  match: boolean
}

/** 每季度按区域整组另存：演练 + 器材（含灭火器台账）快照 */
export interface QuarterlyArchive {
  id: string
  year: number
  quarter: 1 | 2 | 3 | 4
  area: string
  createdAt: string
  ruleVersion: RuleVersion
  equipmentSnapshot: Extinguisher[]
  drillSnapshot: DrillPlan[]
  equipmentCount: ArchiveCount
  drillCount: ArchiveCount
  fingerprint: string
}

export interface ConflictRecord {
  equipId: string
  field: string
  ledgerValue: string
  crewValue: string
  resolvedValue: string
  winner: DataSource
  basis: string
}

export interface BackfillRecord {
  equipId: string
  field: string
  value: string
  rule: string
}

export interface MigrationReport {
  at: string
  total: number
  keptCodes: string[]
  backfilled: BackfillRecord[]
  conflicts: ConflictRecord[]
  normalized: { equipId: string; raw: string; normalized: string }[]
  carriedOrders: string[]
}

export interface CommitLogEntry {
  at: string
  revision: number
  type: string
  operator: string
  summary: string
  scopes: string[]
}

export interface IdemRecord {
  at: string
  operator: string
  kind: string
  refId: string
  summary: string
}

export interface FireState {
  revision: number
  migrated: boolean
  ruleVersion: RuleVersion
  seq: number
  areas: string[]
  batches: PurchaseBatch[]
  equipment: Extinguisher[]
  orders: BusinessOrder[]
  drills: DrillPlan[]
  hazards: Hazard[]
  archives: QuarterlyArchive[]
  /** 已落库单据去重表：同一张充装单只有第一笔算数 */
  idempotency: Record<string, IdemRecord>
  commitLog: CommitLogEntry[]
  migrationReport: MigrationReport | null
}

export interface BatchInput {
  kind: '充装' | '报废'
  ids: string[]
  operator: string
  /** 前端预占的单号；重复提交时它就是幂等键 */
  key?: string
  /** 勾选时读到的实体版本：并发下被先到一笔改过，后到整笔拒绝 */
  baseRevs: Record<string, number>
}

export interface BatchResponse {
  /** false 表示整笔被拒（单号重复 / 并发冲突 / 写入失败回滚），没有任何落库 */
  accepted: boolean
  rejected: boolean
  duplicate?: boolean
  conflict?: boolean
  rolledBack?: boolean
  reason?: string
  order?: BusinessOrder
  okItems: OrderItemResult[]
  failedItems: OrderItemResult[]
  revision: number
  at: string
}
