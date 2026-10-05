/**
 * 迁移前的老数据：散在班组自己表里的自报值，与资产台账并列。
 * 两份对不上的字段就是“两边取值冲突”，迁移时按 rules.arbitrate 的口径仲裁。
 */

export interface LegacyCrewRow {
  code: string
  area: string
  crew: string
  type: string
  model?: string
  manufactureDate?: string
  pressure?: string
  seal?: string
  location?: string
  corrosion?: boolean
  /** 班组自报的业务状态：已送充 / 正常 / 坏了 等口语值 */
  statusText?: string
  note?: string
}

export interface LegacyLedgerRow {
  code: string
  area: string
  crew: string
  type: string
  model: string
  batchId: string
  purchaseDate: string
  manufactureDate?: string
  pressure?: string
  seal?: string
  location?: string
  corrosion?: boolean
  statusText?: string
}

/** 采购批次（迁移前已存在） */
export const LEGACY_BATCHES = [
  { id: 'CG-2015-09', type: '干粉', model: 'MFZ/ABC4', purchaseDate: '2015-12-20', knownManufactureDates: ['2015-08-10'], supplier: '江西安康消防器材厂' },
  { id: 'CG-2019-03', type: '干粉', model: 'MFZ/ABC4', purchaseDate: '2019-06-18', knownManufactureDates: ['2019-02-02', '2019-03-11'], supplier: '南昌消防装备公司' },
  { id: 'CG-2021-11', type: '二氧化碳', model: 'MT/3', purchaseDate: '2021-09-05', knownManufactureDates: [], supplier: '浙安消防设备厂' },
  { id: 'CG-2024-02', type: '水基', model: 'MSWZ/6', purchaseDate: '2024-08-10', knownManufactureDates: ['2024-05-06'], supplier: '江西安康消防器材厂' },
  { id: 'CG-2025-05', type: '干粉', model: 'MFZ/ABC4', purchaseDate: '2025-11-20', knownManufactureDates: ['2025-08-01', '2025-08-20'], supplier: '南昌消防装备公司' },
] as const

/** 资产台账：受控的采购验收记录 */
export const LEGACY_LEDGER: LegacyLedgerRow[] = [
  { code: 'XF-1001', area: '主厂房', crew: '运行一班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2015-09', purchaseDate: '2015-12-20', manufactureDate: '2015-08-10', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1002', area: '主厂房', crew: '运行一班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2019-03', purchaseDate: '2019-06-18', manufactureDate: '2019-02-02', pressure: '欠压', seal: '完好', location: '在位', statusText: '已送充' },
  { code: 'XF-1003', area: '升压站', crew: '运行二班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2019-03', purchaseDate: '2019-06-18', manufactureDate: '2019-03-11', pressure: '正常', seal: '破损', location: '在位', statusText: '在用' },
  { code: 'XF-1004', area: '升压站', crew: '运行二班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2019-03', purchaseDate: '2019-06-18', manufactureDate: '2019-03-11', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1005', area: '办公区', crew: '综合班', type: '二氧化碳', model: 'MT/3', batchId: 'CG-2021-11', purchaseDate: '2021-09-05', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1006', area: '办公区', crew: '综合班', type: '二氧化碳', model: 'MT/3', batchId: 'CG-2021-11', purchaseDate: '2021-09-05', pressure: '正常', seal: '破损', location: '在位', statusText: '在用' },
  { code: 'XF-1007', area: '仓储库房', crew: '后勤班', type: '水基', model: 'MSWZ/6', batchId: 'CG-2024-02', purchaseDate: '2024-08-10', manufactureDate: '2024-05-06', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1008', area: '仓储库房', crew: '后勤班', type: '水基', model: 'MSWZ/6', batchId: 'CG-2024-02', purchaseDate: '2024-08-10', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1009', area: '主厂房', crew: '运行一班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2025-05', purchaseDate: '2025-11-20', manufactureDate: '2025-08-01', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1010', area: '主厂房', crew: '运行二班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2025-05', purchaseDate: '2025-11-20', manufactureDate: '2025-08-20', pressure: '欠压', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1011', area: '办公区', crew: '综合班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2025-05', purchaseDate: '2025-11-20', manufactureDate: '2025-08-20', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1012', area: '启闭机室', crew: '运行一班', type: '二氧化碳', model: 'MT/3', batchId: 'CG-2021-11', purchaseDate: '2021-09-05', pressure: '过压', seal: '完好', location: '在位', statusText: '在用' },
  { code: 'XF-1013', area: '升压站', crew: '运行二班', type: '干粉', model: 'MFZ/ABC4', batchId: 'CG-2025-05', purchaseDate: '2025-11-20', pressure: '正常', seal: '完好', location: '在位', statusText: '在用' },
]

/** 班组自报表：口语化、有缺项、有与台账冲突的取值 */
export const LEGACY_CREW: LegacyCrewRow[] = [
  { code: 'XF-1001', area: '主厂房', crew: '运行一班', type: '干粉', manufactureDate: '2015-08-10', pressure: '正常', seal: '完好', location: '在位', corrosion: true, statusText: '还能用' },
  { code: 'XF-1002', area: '主厂房', crew: '运行一班', type: '干粉', pressure: '欠压', seal: '完好', location: '在位', statusText: '上个月送充装了', note: '充装单位：市消防服务中心' },
  { code: 'XF-1003', area: '升压站', crew: '运行二班', type: '干粉', pressure: '欠压', seal: '完好', location: '在位', corrosion: false, statusText: '正常' },
  // 出厂日期两边冲突：台账 2019-03-11 vs 班组 2018-06，资产属性以台账为准
  { code: 'XF-1004', area: '升压站', crew: '运行二班', type: '干粉', manufactureDate: '2018-06', pressure: '正常', seal: '破损', location: '缺失', statusText: '正常', note: '铅封破了，但还在原位' },
  { code: 'XF-1005', area: '办公区', crew: '综合班', type: '二氧化碳', statusText: '正常' },
  { code: 'XF-1006', area: '办公区', crew: '综合班', type: '二氧化碳', statusText: '正常' },
  { code: 'XF-1007', area: '仓储库房', crew: '后勤班', type: '水基', pressure: '正常', seal: '完好', location: '在位', statusText: '正常' },
  // 班组漏填出厂日期：同批已知 2024-05-06，按批次最早出厂日补齐
  { code: 'XF-1008', area: '仓储库房', crew: '后勤班', type: '水基', pressure: '正常', seal: '完好', location: '在位', statusText: '正常' },
  { code: 'XF-1009', area: '主厂房', crew: '运行一班', type: '干粉', pressure: '正常', seal: '完好', location: '在位', statusText: '正常' },
  { code: 'XF-1010', area: '主厂房', crew: '运行二班', type: '干粉', pressure: '欠压', seal: '完好', location: '在位', statusText: '压力不够了，先记着' },
  { code: 'XF-1011', area: '办公区', crew: '综合班', type: '干粉', pressure: '正常', seal: '完好', location: '在位', statusText: '正常' },
  { code: 'XF-1012', area: '启闭机室', crew: '运行一班', type: '二氧化碳', statusText: '压力好像偏大' },
  // 班组台账里多出一台、缺一堆项：缺项一并补进来
  { code: 'XF-1014', area: '启闭机室', crew: '运行一班', type: '干粉', statusText: '好的' },
]

/** 迁移前各班自己记的“已送充”单据：业务状态冲突时，以先落库的单据为准 */
export const LEGACY_CARRIED_ORDER = {
  id: 'CZ-2026-0001',
  idempotencyKey: 'legacy-cz-XF-1002',
  equipId: 'XF-1002',
  area: '主厂房',
  crew: '运行一班',
  operator: '运行一班-老刘',
  submittedAt: '2026-09-28 14:20',
  refillUnit: '市消防服务中心',
  note: '老充装单：季度演练前临时送修，尚未回厂',
}

/** 迁移前已经排好、占用时段的演练，用来演示“下一个班组不能重复占用同一时段” */
export const LEGACY_DRILLS = [
  {
    id: 'YL-2026-001',
    area: '办公区',
    crew: '综合班',
    date: '2026-10-20',
    slot: '上午' as const,
    scenario: '办公区疏散与灭火器实操',
    createdAt: '2026-09-25 10:00',
  },
  {
    id: 'YL-2026-002',
    area: '升压站',
    crew: '运行二班',
    date: '2026-09-20',
    slot: '下午' as const,
    scenario: '升压站电气火灾演练（已取消，时段应已释放）',
    createdAt: '2026-09-10 10:00',
    cancelledAt: '2026-09-18 16:00',
  },
]
