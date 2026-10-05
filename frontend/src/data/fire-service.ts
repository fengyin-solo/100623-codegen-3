/**
 * 消防与应急域业务服务：所有写操作都走 fire-store.commit，
 * 台账 / 充装单 / 隐患结论在同一次提交里一起改、一次落库。
 */
import { commit, getState } from './fire-store'
import {
  areaRefillState,
  batchEarliestManufacture,
  isExpiredByAge,
  overdueDays,
  quarterKey,
  recomputeHazard,
  slotConflict,
  today,
} from './fire-rules'
import type {
  DrillPlan,
  FireEquipment,
  FireState,
  Hazard,
  HazardConclusion,
  HazardLevel,
  LegacyRecord,
  OrderItemResult,
  RefillOrder,
  RuleVersion,
} from './fire-types'

export interface SubmitOrderInput {
  orderNo: string
  kind: '充装' | '报废'
  area: string
  team: string
  equipIds: string[]
  expectedBackDate?: string
  createdAt?: string
}

export interface SubmitOrderOutcome {
  accepted: boolean
  message: string
  /** 整笔被拒（重复单号等）时为 true：一条都不写 */
  rejectedWhole: boolean
  itemResults?: OrderItemResult[]
  order?: RefillOrder
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16)
}

function openHazardFor(equipId: string, hazards: Hazard[]): Hazard | undefined {
  return hazards.find((h) => h.equipId === equipId && h.status === '未整改')
}

function pushHazardConclusion(
  hazard: Hazard,
  c: Omit<HazardConclusion, 'at' | 'ruleVersion' | 'status'> & { status?: Hazard['status'] },
  version: RuleVersion,
): void {
  hazard.conclusions.push({
    at: stamp(),
    ruleVersion: version,
    status: c.status ?? hazard.status,
    source: c.source,
    level: c.level,
    text: c.text,
  })
  hazard.level = c.level
  if (c.status) hazard.status = c.status
}

/**
 * 提交充装/报废单。
 * - 同单号重复提交：先落库那版算数，后到的整套退回（零写入、零副作用）。
 * - 受理后逐台判定：送成 / 未送成（写明原因）。
 */
export function submitOrder(input: SubmitOrderInput): SubmitOrderOutcome {
  // 单号唯一检查在读外面做，但 commit 内还会再查一次：纯前端单线程下两者等价，
  // 换回后端时把整段挪进唯一索引事务即可，页面调用方式不变。
  if (!input.orderNo.trim()) {
    return { accepted: false, rejectedWhole: true, message: '充装单编号不能为空' }
  }
  if (input.equipIds.length === 0) {
    return { accepted: false, rejectedWhole: true, message: '至少勾选一台器材再提交' }
  }
  if (getState().orders.some((o) => o.orderNo === input.orderNo.trim())) {
    return {
      accepted: false,
      rejectedWhole: true,
      message: `充装单 ${input.orderNo} 已落库过：同一单号只认先提交的一版，本笔整套退回，未写入任何记录`,
    }
  }

  let outcome: SubmitOrderOutcome = {
    accepted: true,
    rejectedWhole: false,
    message: '',
  }

  commit((draft) => {
    // 事务内二次查重，防止绕过前置检查的并发提交。
    if (draft.orders.some((o) => o.orderNo === input.orderNo.trim())) {
      throw new DuplicateOrderError(input.orderNo)
    }

    const results: OrderItemResult[] = []
    const acceptedEquips: FireEquipment[] = []

    for (const equipId of input.equipIds) {
      const equip = draft.equipments.find((e) => e.id === equipId)
      if (!equip) {
        results.push({ equipId, code: equipId, result: '未送成', reason: '台账中找不到该器材' })
        continue
      }
      if (equip.area !== input.area) {
        results.push({
          equipId,
          code: equip.code,
          result: '未送成',
          reason: `器材属 ${equip.area}，与单据区域 ${input.area} 不一致，按区域多选时不跨区受理`,
        })
        continue
      }

      if (input.kind === '充装') {
        if (equip.status === '已报废') {
          results.push({ equipId, code: equip.code, result: '未送成', reason: '器材已报废，不再送检充装' })
          continue
        }
        if (equip.status === '充装中') {
          results.push({ equipId, code: equip.code, result: '未送成', reason: '已在充装途中，不能重复送出' })
          continue
        }
        // 在岗 / 待充装 都可送出；在岗但临期一并受理
        const equipBeforeStatus = equip.status
        equip.status = '充装中'
        equip.lastOrderNo = input.orderNo.trim()
        acceptedEquips.push(equip)
        results.push({
          equipId,
          code: equip.code,
          result: '成功',
          reason: `已送出（原状态：${equipBeforeStatus}），等待回库`,
        })
        const hz = openHazardFor(equip.id, draft.hazards)
        if (hz) {
          pushHazardConclusion(
            hz,
            {
              source: '充装处置',
              level: hz.level,
              text: `随充装单 ${input.orderNo} 送检，隐患随器材整改跟踪中`,
            },
            draft.ruleVersion,
          )
        }
      } else {
        if (equip.status === '已报废') {
          results.push({ equipId, code: equip.code, result: '未送成', reason: '器材已是报废状态' })
          continue
        }
        equip.status = '已报废'
        equip.lastOrderNo = input.orderNo.trim()
        acceptedEquips.push(equip)
        results.push({ equipId, code: equip.code, result: '成功', reason: '已报废处置' })
        const hz = openHazardFor(equip.id, draft.hazards)
        if (hz) {
          pushHazardConclusion(
            hz,
            {
              source: '报废处置',
              level: hz.level,
              text: `随报废单 ${input.orderNo} 报废退出，隐患随报废关闭`,
              status: '已整改',
            },
            draft.ruleVersion,
          )
        }
      }
    }

    const defaultBack = new Date()
    defaultBack.setDate(defaultBack.getDate() + 7)
    const order: RefillOrder = {
      orderNo: input.orderNo.trim(),
      kind: input.kind,
      area: input.area,
      team: input.team,
      createdAt: input.createdAt ?? stamp(),
      expectedBackDate: input.expectedBackDate ?? defaultBack.toISOString().slice(0, 10),
      status: '已受理',
      itemResults: results,
    }
    draft.orders.push(order)

    const okCount = results.filter((r) => r.result === '成功').length
    const failCount = results.length - okCount
    outcome = {
      accepted: true,
      rejectedWhole: false,
      order,
      itemResults: results,
      message:
        `单据 ${order.orderNo} 已落库：受理 ${okCount} 台` +
        (failCount ? `，未送成 ${failCount} 台（见下方逐条原因）` : '，全部送出'),
    }
  })

  return outcome
}

class DuplicateOrderError extends Error {
  constructor(orderNo: string) {
    super(
      `充装单 ${orderNo} 已落库过：同一单号只认先提交的一版，后到的整套退回。`,
    )
    this.name = 'DuplicateOrderError'
  }
}

/** 充装完成回库：逐台给结果，回库器材的未整改隐患按当前规则版本回写整改结论。 */
export function completeRefill(orderNo: string, nextDueDate: string): {
  ok: boolean
  message: string
  results?: OrderItemResult[]
} {
  const state = getState()
  const order = state.orders.find((o) => o.orderNo === orderNo)
  if (!order) return { ok: false, message: `没有找到充装单 ${orderNo}` }
  if (order.kind !== '充装') return { ok: false, message: '报废单不需要回库' }
  if (order.status === '已完成回库') return { ok: false, message: '该单已完成回库' }

  let results: OrderItemResult[] = []
  commit((draft) => {
    const target = draft.orders.find((o) => o.orderNo === orderNo)!
    results = []
    for (const item of target.itemResults) {
      if (item.result !== '成功') {
        results.push({ ...item, reason: `回库跳过：${item.reason}` })
        continue
      }
      const equip = draft.equipments.find((e) => e.id === item.equipId)
      if (!equip) {
        results.push({ ...item, result: '未送成', reason: '台账中找不到该器材' })
        continue
      }
      equip.status = '在岗'
      equip.dueDate = nextDueDate
      results.push({ ...item, result: '成功', reason: `已回库，有效期续至 ${nextDueDate}` })
      const hz = openHazardFor(equip.id, draft.hazards)
      if (hz) {
        pushHazardConclusion(
          hz,
          {
            source: '充装回库',
            level: '一般',
            text: `充装完成回库，有效期续至 ${nextDueDate}，隐患整改闭环`,
            status: '已整改',
          },
          draft.ruleVersion,
        )
      }
    }
    target.status = '已完成回库'
  })
  return { ok: true, message: `充装单 ${orderNo} 已完成回库`, results }
}

export interface ScheduleDrillInput {
  area: string
  team: string
  drillName: string
  startAt: string
  endAt: string
}

export interface ScheduleDrillOutcome {
  ok: boolean
  message: string
  drill?: DrillPlan
  constraint?: { blocked: boolean; earliestDate: string | null; pending: string[] }
}

/**
 * 排演练计划：
 * - 区域有"待充装"器材 → 禁止排期，先送检；
 * - 有"充装中"（在途充装单）→ 开始日必须晚于最晚预计回库日；
 * - 同区域时段冲突 → 拒绝（取消后时段释放，可再被其他班组占用）。
 */
export function scheduleDrill(input: ScheduleDrillInput): ScheduleDrillOutcome {
  const state = getState()
  const activeOrders = state.orders
    .filter((o) => o.kind === '充装' && o.status === '已受理')
    .map((o) => ({ area: o.area, expectedBackDate: o.expectedBackDate }))
  const constraint = areaRefillState(input.area, state.equipments, activeOrders)

  if (constraint.blocked) {
    return {
      ok: false,
      message:
        `${input.area} 还有 ${constraint.pendingEquipments.length} 台器材停在待充装：` +
        `${constraint.pendingEquipments.map((e) => e.code).join('、')}。` +
        `演练只能排到充装完成之后，请先提交充装单送走。`,
      constraint: {
        blocked: true,
        earliestDate: null,
        pending: constraint.pendingEquipments.map((e) => e.code),
      },
    }
  }
  const startDay = input.startAt.slice(0, 10)
  if (constraint.earliestDrillDate && startDay < constraint.earliestDrillDate) {
    return {
      ok: false,
      message:
        `${input.area} 有在途充装单，最晚预计回库日 ${constraint.latestBackDate}，` +
        `演练开始日只能选 ${constraint.earliestDrillDate} 或之后。`,
      constraint: { blocked: false, earliestDate: constraint.earliestDrillDate, pending: [] },
    }
  }
  if (input.endAt <= input.startAt) {
    return { ok: false, message: '结束时间必须晚于开始时间' }
  }
  const conflict = slotConflict(input.area, input.startAt, input.endAt, state.drills)
  if (conflict) {
    return {
      ok: false,
      message:
        `${input.area} 该时段已被 ${conflict.team} 的「${conflict.drillName}」占用 ` +
        `(${conflict.startAt.replace('T', ' ')} ~ ${conflict.endAt.replace('T', ' ')})，请换时段`,
    }
  }

  let drill: DrillPlan
  commit((draft) => {
    draft.seq += 1
    drill = {
      id: `DR-${String(draft.seq).padStart(4, '0')}`,
      area: input.area,
      team: input.team,
      drillName: input.drillName || `${input.area}应急演练`,
      startAt: input.startAt,
      endAt: input.endAt,
      status: '计划中',
      createdAt: stamp(),
      basedOnRefillDate: constraint.latestBackDate ?? undefined,
    }
    draft.drills.push(drill)
  })
  return {
    ok: true,
    message: constraint.latestBackDate
      ? `已排期（器材在途，按最晚回库日 ${constraint.latestBackDate} 之后安排）`
      : '演练计划已建立，时段已占用',
    drill: drill!,
  }
}

/** 取消演练：时段立即释放，其他班组可占用同一时段。 */
export function cancelDrill(id: string): { ok: boolean; message: string } {
  const drill = getState().drills.find((d) => d.id === id)
  if (!drill) return { ok: false, message: '没有找到该演练计划' }
  if (drill.status === '已取消') return { ok: false, message: '演练已取消，时段早已释放' }
  commit((draft) => {
    const target = draft.drills.find((d) => d.id === id)!
    target.status = '已取消'
  })
  return { ok: true, message: `已取消「${drill.drillName}」，${drill.area} ${drill.startAt.replace('T', ' ')} 时段已释放` }
}

/** 每季度按区域整组另存：器材台账 + 演练计划一起进快照；重复另存覆盖该区域该季度。 */
export function saveQuarterlySnapshot(
  area: string,
  quarter = quarterKey(),
  note?: string,
): { ok: boolean; message: string; equipmentCount: number; drillCount: number } {
  const state = getState()
  const equipCount = state.equipments.filter((e) => e.area === area).length
  const drillCount = state.drills.filter((d) => d.area === area).length
  commit((draft) => {
    const id = `${quarter}-${area}`
    const snapshot = {
      id,
      quarterKey: quarter,
      area,
      createdAt: stamp(),
      equipmentCount: draft.equipments.filter((e) => e.area === area).length,
      drillCount: draft.drills.filter((d) => d.area === area).length,
      equipments: draft.equipments.filter((e) => e.area === area),
      drills: draft.drills.filter((d) => d.area === area),
      note,
    }
    const idx = draft.snapshots.findIndex((s) => s.id === id)
    if (idx >= 0) draft.snapshots[idx] = snapshot
    else draft.snapshots.push(snapshot)
  })
  return {
    ok: true,
    message: `${quarter} ${area} 整组已另存：灭火器等器材 ${equipCount} 台、演练 ${drillCount} 条`,
    equipmentCount: equipCount,
    drillCount,
  }
}

export interface MigrationResult {
  migratedNew: number
  conflictResolved: number
  dateFilled: number
  details: string[]
}

/**
 * 老数据迁移：沿用原编号；
 * - 台账缺项：按原编号补进（出厂日期按批次最早口径补）；
 * - 取值冲突：以消防器材台账为准，冲突留在散表行里注明依据；
 * - 缺出厂日期（台账 + 散表）：按同采购批次最早出厂日补齐。
 */
export function migrateLegacy(): MigrationResult {
  const result: MigrationResult = { migratedNew: 0, conflictResolved: 0, dateFilled: 0, details: [] }
  commit((draft) => {
    // 迁移与回填都基于"台账 + 已确定要补进的新器材"这同一份池子
    const pool = [...draft.equipments]
    for (const rec of draft.legacy.filter((r) => !r.migrated)) {
      const existing = pool.find((e) => e.code === rec.code)
      if (!existing) {
        const mfd =
          rec.manufactureDate || batchEarliestManufacture(rec.batchNo, pool)
        const filled = !rec.manufactureDate && !!mfd
        const added: FireEquipment = {
          id: rec.code,
          code: rec.code,
          name: rec.name,
          kind: rec.kind,
          area: rec.area,
          batchNo: rec.batchNo,
          manufactureDate: mfd,
          manufactureDateFilled: filled,
          dueDate: rec.dueDate,
          location: '老数据迁移补录',
          team: rec.team,
          status: '在岗',
          remark: '由班组散表按原编号补入',
        }
        draft.equipments.push(added)
        pool.push(added)
        result.migratedNew += 1
        if (filled) result.dateFilled += 1
        result.details.push(
          `${rec.code}：台账缺项，按原编号补入${filled ? `，出厂日期按 ${rec.batchNo} 批次最早值 ${mfd} 补齐` : ''}`,
        )
      } else {
        if (!existing.manufactureDate) {
          const mfd = batchEarliestManufacture(existing.batchNo, pool)
          if (mfd) {
            existing.manufactureDate = mfd
            existing.manufactureDateFilled = true
            result.dateFilled += 1
            result.details.push(
              `${rec.code}：出厂日期缺失，按 ${existing.batchNo} 批次最早值 ${mfd} 补齐（安全从严口径）`,
            )
          }
        }
        if (rec.conflictField) {
          result.conflictResolved += 1
          result.details.push(
            `${rec.code}：${rec.conflictField} 冲突（散表=${rec.conflictValue}，台账=${existing[rec.conflictField]}），` +
              `按台账为准——台账是设备主数据，散表仅为班组自记`,
          )
        }
      }
      rec.migrated = true
    }
  })
  return result
}

/** 换版：未整改隐患按新版重算并追加结论，旧结论保留当时等级与版本号。 */
export function upgradeRules(nextVersion: RuleVersion): { ok: boolean; message: string } {
  const state = getState()
  if (state.ruleVersion === nextVersion) {
    return { ok: false, message: `当前已经是 ${nextVersion} 口径` }
  }
  commit((draft) => {
    for (const hz of draft.hazards.filter((h) => h.status === '未整改')) {
      const { level, reason } = recomputeHazard(hz, draft.equipments, nextVersion)
      const oldLevel = hz.level
      pushHazardConclusion(
        hz,
        {
          source: `规则换版 ${draft.ruleVersion}→${nextVersion}`,
          level,
          text: `按新版重算：${reason}，等级 ${oldLevel}→${level}；旧结论保留原等级与版本号`,
        },
        nextVersion,
      )
    }
    draft.ruleVersion = nextVersion
  })
  return { ok: true, message: `隐患口径已换版到 ${nextVersion}，未整改隐患均按新版重算，历史结论原样保留` }
}

/** 到期巡检：把已过有效期且仍在岗的灭火器批量置为"待充装"，同步登记/更新巡视隐患。 */
export function scanDueEquipments(): { changed: number; details: OrderItemResult[] } {
  const details: OrderItemResult[] = []
  commit((draft) => {
    for (const equip of draft.equipments) {
      if (equip.status !== '在岗' || equip.kind !== '灭火器') continue
      const overdue = overdueDays(equip.dueDate)
      if (isExpiredByAge(equip)) {
        details.push({ equipId: equip.id, code: equip.code, result: '未受理', reason: '出厂满 10 年，应走报废而非充装' })
        continue
      }
      if (overdue > 0) {
        equip.status = '待充装'
        details.push({ equipId: equip.id, code: equip.code, result: '成功', reason: `已过有效期 ${overdue} 天，转待充装` })
        if (!openHazardFor(equip.id, draft.hazards)) {
          const level: HazardLevel =
            overdue > (draft.ruleVersion === 'v2' ? 44 : 60)
              ? '重大'
              : overdue > (draft.ruleVersion === 'v2' ? 14 : 30)
                ? '较大'
                : '一般'
          const hz: Hazard = {
            id: `HD-${String(1000 + draft.seq + draft.hazards.length)}`,
            source: '到期巡检',
            area: equip.area,
            equipId: equip.id,
            description: `${equip.code} 已过充装有效期 ${overdue} 天，待送检`,
            foundAt: today(),
            level,
            status: '未整改',
            conclusions: [
              {
                at: stamp(),
                source: '到期巡检',
                ruleVersion: draft.ruleVersion,
                level,
                text: `巡检发现逾期 ${overdue} 天（${draft.ruleVersion} 口径：${level}），转待充装`,
                status: '未整改',
              },
            ],
          }
          draft.hazards.push(hz)
        }
      }
    }
  })
  return { changed: details.filter((d) => d.result === '成功').length, details }
}

export type { FireState }
export { getState }
export type { LegacyRecord }
