/**
 * 消防与应急域的纯规则：不读写存储，全部是可直接单测的函数。
 * 页面与 service 都只信这里的口径，保证"两处读到的是同一份"。
 */
import type {
  DrillPlan,
  FireEquipment,
  Hazard,
  HazardLevel,
  RuleVersion,
} from './fire-types'

export const today = (): string => new Date().toISOString().slice(0, 10)

export function daysBetween(fromInclusive: string, toExclusive: string): number {
  const a = new Date(`${fromInclusive}T00:00:00Z`).getTime()
  const b = new Date(`${toExclusive}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 逾期天数：今天 - 有效期（未到期为负数） */
export function overdueDays(dueDate: string, ref = today()): number {
  return daysBetween(dueDate, ref)
}

/** 季度键，如 2026-Q4 */
export function quarterKey(date = today()): string {
  const [y, m] = date.split('-').map(Number)
  return `${y}-Q${Math.ceil(m / 3)}`
}

/**
 * 隐患等级口径（换版重算用的就是这套）。
 * v1（旧版）：逾期 30 天内一般，31~60 较大，60 天以上重大。
 * v2（换版后，安全从严）：逾期 14 天内一般，15~44 较大，45 天以上重大。
 */
export function gradeByOverdue(overdue: number, version: RuleVersion): HazardLevel {
  if (version === 'v2') {
    if (overdue > 44) return '重大'
    if (overdue > 14) return '较大'
    return '一般'
  }
  if (overdue > 60) return '重大'
  if (overdue > 30) return '较大'
  return '一般'
}

/**
 * 缺出厂日期的批次回填口径：同采购批次中已知出厂日期的最早值。
 * 理由：消防器材按出厂日算报废年限，缺日期时从严取最早，宁可提前判到期，不漏检。
 */
export function batchEarliestManufacture(
  batchNo: string,
  pool: FireEquipment[],
): string {
  const dates = pool
    .filter((e) => e.batchNo === batchNo && e.manufactureDate)
    .map((e) => e.manufactureDate)
    .sort()
  return dates[0] ?? ''
}

/** 干粉灭火器 10 年强制报废口径（GB 95 系，出厂满 10 年）。 */
export function isExpiredByAge(e: FireEquipment, ref = today()): boolean {
  if (e.kind !== '灭火器' || !e.manufactureDate) return false
  return daysBetween(e.manufactureDate, ref) >= 365 * 10
}

export interface AreaRefillState {
  area: string
  /** 停在"待充装"（还没送走）的器材：存在即禁止排演练 */
  pendingEquipments: FireEquipment[]
  /** 充装中器材 */
  inTransitEquipments: FireEquipment[]
  /** 在途充装单最晚预计回库日：演练只能排到这一天之后 */
  latestBackDate: string | null
  /** 是否完全禁止排期 */
  blocked: boolean
  /** 允许排期的最早演练日期（YYYY-MM-DD，次日） */
  earliestDrillDate: string | null
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 区域器材/充装约束：演练排期页、待办页都调这一个函数，
 * 不存在各算各的第二份口径。
 */
export function areaRefillState(
  area: string,
  equipments: FireEquipment[],
  activeBackDates: { area: string; expectedBackDate: string }[],
): AreaRefillState {
  const inArea = equipments.filter((e) => e.area === area && e.status !== '已报废')
  const pendingEquipments = inArea.filter((e) => e.status === '待充装')
  const inTransitEquipments = inArea.filter((e) => e.status === '充装中')
  const dates = activeBackDates
    .filter((o) => o.area === area && o.expectedBackDate)
    .map((o) => o.expectedBackDate)
    .sort()
  const latestBackDate = dates.length ? dates[dates.length - 1] : null
  const blocked = pendingEquipments.length > 0
  return {
    area,
    pendingEquipments,
    inTransitEquipments,
    latestBackDate: blocked ? null : latestBackDate,
    blocked,
    earliestDrillDate: blocked || !latestBackDate ? null : nextDay(latestBackDate),
  }
}

/** 同一区域、计划中的时段重叠判定；已取消/已完成的不占位。 */
export function slotConflict(
  area: string,
  startAt: string,
  endAt: string,
  drills: DrillPlan[],
  ignoreId?: string,
): DrillPlan | null {
  return (
    drills.find(
      (d) =>
        d.id !== ignoreId &&
        d.status === '计划中' &&
        d.area === area &&
        startAt < d.endAt &&
        endAt > d.startAt,
    ) ?? null
  )
}

/** 换版重算单条未整改隐患的新等级；无关联器材或非灭火器沿用原等级。 */
export function recomputeHazard(
  hazard: Hazard,
  equipments: FireEquipment[],
  version: RuleVersion,
): { level: HazardLevel; reason: string } {
  const equip = hazard.equipId
    ? equipments.find((e) => e.id === hazard.equipId)
    : undefined
  if (!equip) {
    return { level: hazard.level, reason: '无关联器材，沿用原等级' }
  }
  if (equip.kind !== '灭火器' || !equip.dueDate) {
    return { level: hazard.level, reason: '关联器材非灭火器，沿用原等级' }
  }
  const overdue = overdueDays(equip.dueDate)
  if (overdue <= 0) {
    return { level: '一般', reason: '器材未逾期，按一般跟踪' }
  }
  return { level: gradeByOverdue(overdue, version), reason: `按逾期 ${overdue} 天重算` }
}

/** 通用 CSV 拼装，导出条数与传入行数严格一致。 */
export function toCsv(headers: string[], rows: (string | number | undefined)[][]): string {
  const esc = (v: string | number | undefined) => {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
}
