/**
 * 消防器材与应急演练一体化清单的领域类型。
 * 纯前端版：数据落 localStorage；换回后端时这些结构与 DTO 一一对应，页面不用改。
 */

/** 器材状态：在岗 / 待充装（送检前） / 充装中（已送外单位，未回库） / 已报废 */
export type EquipStatus = '在岗' | '待充装' | '充装中' | '已报废'

/** 器材类别（灭火器才有出厂到期、报废年限口径） */
export type EquipKind = '灭火器' | '消防栓' | '水带' | '应急灯' | '疏散标识'

export interface FireEquipment {
  /** 全站唯一编号，老数据迁移时沿用原班组编号 */
  id: string
  /** 业务编号（台账展示用，可能与 id 相同） */
  code: string
  name: string
  kind: EquipKind
  /** 区域，如 主厂房、升压站 */
  area: string
  /** 采购批次号 */
  batchNo: string
  /** 出厂日期 YYYY-MM-DD，老数据可能为空，迁移时按批次口径补齐 */
  manufactureDate: string
  /** 是否为迁移时按批次口径补的出厂日期 */
  manufactureDateFilled: boolean
  /** 充装/检修有效期至 YYYY-MM-DD */
  dueDate: string
  location: string
  team: string
  status: EquipStatus
  /** 最近一次充装单号 */
  lastOrderNo?: string
  /** 备注 */
  remark?: string
}

export type ItemResultStatus = '成功' | '未送成' | '未受理'

/** 充装单逐台结果 */
export interface OrderItemResult {
  equipId: string
  code: string
  result: ItemResultStatus
  /** 成功后的状态 / 未送成时的原因 */
  reason: string
}

/** 充装单 / 报废单 */
export interface RefillOrder {
  orderNo: string
  kind: '充装' | '报废'
  area: string
  team: string
  createdAt: string
  /** 预计回库日期（逐台取最晚，排期约束用） */
  expectedBackDate: string
  status: '已受理' | '已完成回库'
  itemResults: OrderItemResult[]
}

export type DrillStatus = '计划中' | '已取消' | '已完成'

export interface DrillPlan {
  id: string
  area: string
  team: string
  /** 开始时间 yyyy-MM-ddTHH:mm */
  startAt: string
  /** 结束时间 yyyy-MM-ddTHH:mm */
  endAt: string
  drillName: string
  status: DrillStatus
  createdAt: string
  /** 排期时引用的最晚充装完成日，留痕用 */
  basedOnRefillDate?: string
  /** 若曾被器材状态约束而推迟，记录原始期望日 */
  postponedFrom?: string
}

/** 隐患等级口径版本：v1 旧版，v2 换版后的新口径 */
export type RuleVersion = 'v1' | 'v2'

export type HazardLevel = '一般' | '较大' | '重大'
export type HazardStatus = '未整改' | '已整改'

/** 处理结论流水：器材处置会回写，换版会追加重算结论 */
export interface HazardConclusion {
  at: string
  source: string
  /** 得出该结论时使用的规则版本 */
  ruleVersion: RuleVersion
  level: HazardLevel
  text: string
  status: HazardStatus
}

export interface Hazard {
  id: string
  source: string
  area: string
  /** 关联器材编号，可空（巡视发现的其他问题） */
  equipId?: string
  description: string
  foundAt: string
  /** 当前等级（始终是最新一条结论的等级） */
  level: HazardLevel
  status: HazardStatus
  conclusions: HazardConclusion[]
}

/** 班组散表老记录：迁移前的样子 */
export interface LegacyRecord {
  code: string
  team: string
  area: string
  name: string
  kind: EquipKind
  batchNo: string
  manufactureDate: string
  dueDate: string
  /** 与台账冲突时的取值（散表侧），没有冲突留空 */
  conflictField?: keyof Pick<FireEquipment, 'dueDate' | 'area' | 'status'>
  conflictValue?: string
  migrated: boolean
}

/** 季度归档：按区域整组另存 */
export interface QuarterlySnapshot {
  id: string
  quarterKey: string
  area: string
  createdAt: string
  equipmentCount: number
  drillCount: number
  equipments: FireEquipment[]
  drills: DrillPlan[]
  note?: string
}

export interface FireState {
  equipments: FireEquipment[]
  orders: RefillOrder[]
  drills: DrillPlan[]
  hazards: Hazard[]
  legacy: LegacyRecord[]
  snapshots: QuarterlySnapshot[]
  ruleVersion: RuleVersion
  seq: number
}
