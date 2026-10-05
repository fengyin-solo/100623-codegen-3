/**
 * 规则引擎：到期、报废、隐患等级、出厂日期补齐、区域可演练判定全部集中在这里。
 * 器材台账与演练计划两处读取同一份函数（drillBlockers / areaReadiness），不会各算各的。
 */
import type {
  Conclusion,
  DataSource,
  Extinguisher,
  ExtinguisherType,
  HazardGrade,
  ManufactureSource,
  PurchaseBatch,
  RuleVersion,
} from './types'

export const RULE_LABEL: Record<RuleVersion, string> = {
  // 旧版：各班自管时代的粗放口径，统一按5年报废、每年充装、无提前预警、无分级隐患
  v1: '旧版（班组自管口径：5年报废·每年充装·无提前预警）',
  // 新版：2026 年起统一按 GB 50444 口径重算
  v2: '新版（GB 50444：干粉/CO2 10年·水基6年报废，充装间隔分类，提前30天预警，隐患四级分级）',
}

interface ExtRuleSet {
  scrapYears: number
  firstRefillYears: number
  refillIntervalMonths: number
  warningDays: number
}

const RULES: Record<RuleVersion, Record<ExtinguisherType, ExtRuleSet>> = {
  v1: {
    干粉: { scrapYears: 5, firstRefillYears: 1, refillIntervalMonths: 12, warningDays: 0 },
    二氧化碳: { scrapYears: 5, firstRefillYears: 1, refillIntervalMonths: 12, warningDays: 0 },
    水基: { scrapYears: 5, firstRefillYears: 1, refillIntervalMonths: 12, warningDays: 0 },
  },
  v2: {
    干粉: { scrapYears: 10, firstRefillYears: 5, refillIntervalMonths: 24, warningDays: 30 },
    二氧化碳: { scrapYears: 10, firstRefillYears: 5, refillIntervalMonths: 24, warningDays: 30 },
    水基: { scrapYears: 6, firstRefillYears: 3, refillIntervalMonths: 12, warningDays: 30 },
  },
}

export const DAY = 24 * 60 * 60 * 1000

/** 业务锚定的“今天”，保证演示与测试结果稳定 */
export const TODAY = '2026-10-05'

export function today(): string {
  return TODAY
}

export function nowStamp(): string {
  return `${TODAY} 09:00`
}

export function parseDate(value: string): number {
  const [y, m, d] = value.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addYears(value: string, years: number): string {
  const [y, m, d] = value.split('-').map(Number)
  return formatDate(new Date(Date.UTC(y + years, m - 1, d)).getTime())
}

export function addMonths(value: string, months: number): string {
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1 + months, d))
  return formatDate(date.getTime())
}

export function formatDate(t: number): string {
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY)
}

/**
 * 缺出厂日期的存量器材，按采购批次回填，口径由本函数统一决定：
 * 1. 同批有已知出厂日的，取该批【最早】出厂日补齐 —— 同批器材安全余量从严，宁可早到期；
 * 2. 整批都缺出厂日的，按【批次采购验收日倒推 90 天】补齐 —— 取收货前约一个生产周期，保守从严；
 * 两种都在器材上标 ManufactureSource，台账里看得见是补的、按哪条补的。
 */
export function backfillManufactureDate(
  equip: { purchaseDate: string; manufactureDate?: string },
  batch: PurchaseBatch | undefined,
): { manufactureDate: string; source: ManufactureSource } {
  if (equip.manufactureDate) {
    return { manufactureDate: equip.manufactureDate, source: '原始' }
  }
  if (batch && batch.knownManufactureDates.length > 0) {
    const earliest = [...batch.knownManufactureDates].sort()[0]
    return { manufactureDate: earliest, source: '批次最早出厂日补齐' }
  }
  const purchase = batch?.purchaseDate ?? equip.purchaseDate
  return { manufactureDate: formatDate(parseDate(purchase) - 90 * DAY), source: '批次验收日倒推90天补齐' }
}

function gradeFromFactors(
  version: RuleVersion,
  factors: { daysToScrap: number; daysToRefill: number; defective: number },
): { grade: HazardGrade; reasons: string[] } {
  const reasons: string[] = []
  let grade: HazardGrade = '正常'
  const bump = (next: HazardGrade, reason: string) => {
    reasons.push(reason)
    const order: HazardGrade[] = ['正常', '一般隐患', '严重隐患', '重大隐患']
    if (order.indexOf(next) > order.indexOf(grade)) {
      grade = next
    }
  }
  const { daysToScrap, daysToRefill, defective } = factors
  if (daysToScrap <= 0) {
    bump('重大隐患', version === 'v2' ? '已达报废年限，按 GB 50444 必须报废' : '已达报废年限')
  } else if (version === 'v2' && daysToScrap <= 365) {
    bump('严重隐患', `距报废不足1年（剩${daysToScrap}天）`)
  }
  if (daysToRefill <= 0) {
    bump('重大隐患', '超过充装期限，必须送充')
  } else if (version === 'v2' && daysToRefill <= 30) {
    bump('严重隐患', `距充装期限不足30天（剩${daysToRefill}天）`)
  } else if (version === 'v2' && daysToRefill <= 90) {
    bump('一般隐患', `临近充装期（剩${daysToRefill}天）`)
  }
  if (defective >= 2) {
    bump('重大隐患', '现场检查项异常≥2项（压力/铅封/在位/锈蚀）')
  } else if (defective === 1) {
    bump(version === 'v2' ? '严重隐患' : '一般隐患', '现场检查项异常1项')
  }
  return { grade, reasons }
}

/** 按指定规则版本，为一台器材算出当前结论（到期、报废、隐患等级、原因） */
export function evaluate(e: Extinguisher, version: RuleVersion, asOf = TODAY): Conclusion {
  const rule = RULES[version][e.type]
  const scrapDue = addYears(e.manufactureDate, rule.scrapYears)
  const firstDue = addYears(e.manufactureDate, rule.firstRefillYears)
  const refillBase = e.lastRefillDate ?? e.manufactureDate
  const refillDue =
    e.lastRefillDate && daysBetween(e.manufactureDate, e.lastRefillDate) > rule.firstRefillYears * 365 - 5
      ? addMonths(refillBase, rule.refillIntervalMonths)
      : firstDue
  const daysToScrap = daysBetween(asOf, scrapDue)
  const daysToRefill = daysBetween(asOf, refillDue)
  const defective =
    (e.pressure !== '正常' && e.pressure !== '未检' ? 1 : 0) +
    (e.seal === '破损' ? 1 : 0) +
    (e.location === '缺失' ? 1 : 0) +
    (e.corrosion ? 1 : 0)

  const reasons: string[] = []
  let grade: HazardGrade = '正常'
  let needsRefill = false
  let needsScrap = false
  let warning = false

  if (e.status === '已报废') {
    reasons.push('已报废离位')
  } else {
    if (daysToScrap <= 0) {
      needsScrap = true
    }
    if (e.status === '待充装') {
      needsRefill = true
      reasons.push('器材已送充未回厂，本区域执勤缺位')
      const g: HazardGrade = '重大隐患'
      grade = g
    } else {
      if (daysToRefill <= 0) {
        needsRefill = true
      }
      const factors = gradeFromFactors(version, { daysToScrap, daysToRefill, defective })
      grade = factors.grade
      reasons.push(...factors.reasons)
      warning =
        version === 'v2' &&
        ((daysToRefill > 30 && daysToRefill <= 90) || (daysToScrap > 365 && daysToScrap <= 2 * 365))
    }
    if (!reasons.length) {
      reasons.push('在值且各项合规')
    }
  }

  return {
    ruleVersion: version,
    scrapDue,
    refillDue,
    needsRefill,
    needsScrap,
    warning,
    grade,
    reasons,
    calculatedAt: `${asOf} 09:00`,
  }
}

export function isPendingRefill(e: Extinguisher): boolean {
  return e.status === '待充装'
}

export function highestGrade(items: Conclusion[]): HazardGrade {
  const order: HazardGrade[] = ['正常', '一般隐患', '严重隐患', '重大隐患']
  return items.reduce<HazardGrade>(
    (acc, c) => (order.indexOf(c.grade) > order.indexOf(acc) ? c.grade : acc),
    '正常',
  )
}

export interface AreaBlocker {
  area: string
  total: number
  onDuty: number
  pendingRefill: Extinguisher[]
  scrapDue: Extinguisher[]
  ready: boolean
  worstGrade: HazardGrade
  fingerprint: string
}

/**
 * 区域可演练判定（器材页与演练页共用这唯一一份）：
 * 本区域还有器材停在“待充装”时，该区域只能排到充装完成（回厂）之后。
 * fingerprint 给两处页面做同值校验展示。
 */
export function areaReadiness(equipment: Extinguisher[], area: string, version: RuleVersion): AreaBlocker {
  const list = equipment.filter((e) => e.area === area)
  const pending = list.filter(isPendingRefill)
  const scrapDue = list.filter((e) => evaluate(e, version).needsScrap && e.status !== '已报废')
  const conclusions = list.filter((e) => e.status !== '已报废').map((e) => evaluate(e, version))
  const worst = highestGrade(conclusions)
  return {
    area,
    total: list.length,
    onDuty: list.filter((e) => e.status === '在值').length,
    pendingRefill: pending,
    scrapDue,
    ready: pending.length === 0,
    worstGrade: worst,
    fingerprint: fingerprint({ area, pending: pending.map((e) => e.id), total: list.length }),
  }
}

/** 演练计划排期校验：返回阻塞原因；无阻塞返回 null */
export function drillBlockers(equipment: Extinguisher[], area: string, version: RuleVersion): string | null {
  const state = areaReadiness(equipment, area, version)
  if (!state.ready) {
    const ids = state.pendingRefill.map((e) => e.id).join('、')
    return `本区域尚有 ${state.pendingRefill.length} 台器材停在待充装（${ids}），只能排到充装完成回厂之后`
  }
  return null
}

/** 简单稳定指纹：证明器材台账页与演练排期页读到的是同一份区域状态 */
export function fingerprint(payload: unknown): string {
  const json = JSON.stringify(payload)
  let hash = 0
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash << 5) - hash + json.charCodeAt(i)
    hash |= 0
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function quarterOf(date: string): { year: number; quarter: 1 | 2 | 3 | 4 } {
  const month = Number(date.split('-')[1])
  return { year: Number(date.split('-')[0]), quarter: (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4 }
}

export function quarterLabel(year: number, quarter: number): string {
  return `${year}年第${quarter}季度`
}

/**
 * 两边取值冲突时的仲裁口径（迁移时统一执行，写进迁移报告）：
 * - 资产属性（型号、出厂日期、采购批次）以【资产台账】为准：它是采购验收留下的受控记录；
 * - 现场状态（压力、铅封、在位、锈蚀）以【现场巡视】为准：它时间最新、反映当下；
 * - 业务状态（待充装/在值）以【先落库单据】为准：先提交先占用；
 * - 位置/班组以【资产台账】为准，避免班组自报搬运后不回写。
 */
export function arbitrate(field: string): { winner: DataSource; basis: string } {
  if (['model', 'manufactureDate', 'batchId', 'type', 'purchaseDate'].includes(field)) {
    return { winner: '资产台账', basis: '资产属性属采购验收受控记录，以资产台账为准' }
  }
  if (['pressure', 'seal', 'location', 'corrosion'].includes(field)) {
    return { winner: '班组自报', basis: '现场状态以时间最新的现场巡视/班组自报为准' }
  }
  if (['status', 'lastRefillDate'].includes(field)) {
    return { winner: '先落库单据', basis: '业务状态以先落库的充装单为准，先到先占' }
  }
  return { winner: '资产台账', basis: '默认以受控的资产台账为准' }
}

/** CSV 单元格转义：保证含逗号/引号的内容导出后行数与页面一致 */
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}
