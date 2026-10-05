/**
 * 消防与演练领域状态仓库（纯前端持久化 + 串行事务提交）。
 *
 * 并发/重复控制都在 submitTx 这一层：
 * 1) 幂等键：同一张充装单重复提交，只有先落库的一版算数，后到的整套退回；
 * 2) 实体级 CAS：勾选时记录 baseRev，提交时被先到一笔改过 -> 后到整笔拒绝写入；
 * 3) 单事务：台账器材与业务单据、隐患、时段占用一起改，任一失败整笔回滚；
 * 4) 串行队列：多笔并发（含“并发演练”）按到达顺序提交，保证只有第一笔生效。
 */
import { computed, reactive, ref } from 'vue'

import {
  LEGACY_BATCHES,
  LEGACY_CARRIED_ORDER,
  LEGACY_CREW,
  LEGACY_DRILLS,
  LEGACY_LEDGER,
  type LegacyCrewRow,
  type LegacyLedgerRow,
} from './legacy-data'
import {
  RULE_LABEL,
  arbitrate,
  areaReadiness,
  backfillManufactureDate,
  csvCell,
  drillBlockers,
  evaluate,
  fingerprint,
  nowStamp,
  quarterOf,
  today,
} from './rules'
import type {
  BatchInput,
  BatchResponse,
  BusinessOrder,
  CommitLogEntry,
  Conclusion,
  ConflictRecord,
  DataSource,
  DrillPlan,
  EquipmentStatus,
  Extinguisher,
  ExtinguisherType,
  FireState,
  Hazard,
  HazardGrade,
  HistoryEvent,
  MigrationReport,
  OrderItemResult,
  QuarterlyArchive,
  RuleVersion,
  Slot,
} from './types'

const STORAGE_KEY = 'hydropower-fire:state:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normStatus(raw: string): EquipmentStatus {
  const text = raw.trim()
  if (text.includes('送') || text.includes('充') || text.includes('修')) {
    return '待充装'
  }
  if (text.includes('废') || text.includes('坏')) {
    return '已报废'
  }
  return '在值'
}

function asType(value: string): ExtinguisherType {
  if (value.includes('二氧化碳') || value === 'CO2') {
    return '二氧化碳'
  }
  if (value.includes('水基')) {
    return '水基'
  }
  return '干粉'
}

/** 老表里的日期不规范（如 2018-06 只有年月）：年月补 01，其余原样，便于两边比对 */
function normalizeDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const text = value.trim()
  if (/^\d{4}-\d{2}$/.test(text)) {
    return `${text}-01`
  }
  return text
}

type DraftEquip = Omit<Extinguisher, 'conclusion' | 'history' | 'rev'> & {
  conclusion?: Conclusion
  history?: HistoryEvent[]
  rev?: number
}

function attachConclusion(e: DraftEquip, version: RuleVersion): Extinguisher {
  const equip = e as Extinguisher
  equip.conclusion = evaluate(equip, version)
  equip.history = equip.history ?? []
  equip.rev = equip.rev ?? 1
  return equip
}

/** 一次性迁移：老数据按原有编号合并，缺项补齐，冲突仲裁，结论回写隐患 */
function migrate(state: FireState): void {
  const report: MigrationReport = {
    at: nowStamp(),
    total: 0,
    keptCodes: [],
    backfilled: [],
    conflicts: [],
    normalized: [],
    carriedOrders: [],
  }
  const crewByCode = new Map<string, LegacyCrewRow>(LEGACY_CREW.map((r) => [r.code, r]))
  const allCodes = Array.from(new Set([...LEGACY_LEDGER.map((r) => r.code), ...LEGACY_CREW.map((r) => r.code)]))

  const carriedHazards: Hazard[] = []
  let hazardSeq = 1
  const addHazard = (h: Omit<Hazard, 'id'>) => {
    carriedHazards.push({ id: `YH-${String(hazardSeq).padStart(4, '0')}`, ...h })
    hazardSeq += 1
  }

  for (const code of allCodes) {
    const ledger = LEGACY_LEDGER.find((r) => r.code === code)
    const crew = crewByCode.get(code)
    report.keptCodes.push(code)

    // 基础字段：台账缺失而班组有的，先取班组，再补缺
    const type = asType(ledger?.type ?? crew?.type ?? '干粉')
    const purchaseHint = ledger?.purchaseDate ?? ''
    const batchId =
      ledger?.batchId ??
      state.batches.find((b) => b.purchaseDate === purchaseHint && b.type === type)?.id
    const batch = state.batches.find((b) => b.id === batchId)
    const purchaseDate = ledger?.purchaseDate ?? batch?.purchaseDate ?? '2025-01-01'
    const area = ledger?.area ?? crew?.area ?? '未分配区域'
    const crewName = ledger?.crew ?? crew?.crew ?? '未分配班组'

    // —— 逐字段冲突仲裁 ——
    const conflicts: ConflictRecord[] = []
    const pick = <T>(field: string, ledgerValue: T | undefined, crewValue: T | undefined) => {
      const l = ledgerValue as string | undefined
      const c = crewValue as string | undefined
      if (l !== undefined && c !== undefined && String(l) !== String(c)) {
        const { winner, basis } = arbitrate(field)
        // 按仲裁来源取值：资产属性取台账，现场状态取班组（巡视为准），业务状态取单据（外部已定）
        const resolved = winner === '班组自报' ? c : l
        conflicts.push({
          equipId: code,
          field,
          ledgerValue: String(l),
          crewValue: String(c),
          resolvedValue: String(resolved),
          winner,
          basis,
        })
        return resolved
      }
      return (l ?? c) as T
    }

    const model = pick('model', ledger?.model, crew?.model) ?? batch?.model ?? 'MFZ/ABC4'
    const manufactureRaw = normalizeDate(
      pick('manufactureDate', ledger?.manufactureDate, crew?.manufactureDate) as string | undefined,
    )
    const pressure = (pick('pressure', ledger?.pressure, crew?.pressure) as string) ?? '未检'
    const seal = (pick('seal', ledger?.seal, crew?.seal) as string) ?? '未检'
    const location = (pick('location', ledger?.location, crew?.location) as string) ?? '未检'
    const corrosion = Boolean(pick('corrosion', ledger?.corrosion, crew?.corrosion))

    // 业务状态：老充装单先落库，XF-1002 以单据“待充装”为准
    let status: EquipmentStatus = '在值'
    if (code === LEGACY_CARRIED_ORDER.equipId) {
      status = '待充装'
    } else {
      const statusText = ledger?.statusText ?? crew?.statusText
      if (statusText && statusText !== '在用' && statusText !== '正常' && statusText !== '还能用' && statusText !== '好的') {
        const normalized = normStatus(statusText)
        report.normalized.push({ equipId: code, raw: statusText, normalized })
        status = normalized
      } else if (statusText) {
        report.normalized.push({ equipId: code, raw: statusText, normalized: '在值' })
      }
    }

    // —— 缺出厂日期：按采购批次补齐 ——
    const backfill = backfillManufactureDate({ purchaseDate, manufactureDate: manufactureRaw }, batch)
    if (backfill.source !== '原始') {
      report.backfilled.push({
        equipId: code,
        field: '出厂日期',
        value: backfill.manufactureDate,
        rule: backfill.source,
      })
    }

    const dataSource: DataSource = conflicts.length
      ? '冲突仲裁'
      : ledger && crew
        ? '两源一致'
        : ledger
          ? '资产台账'
          : '班组自报'

    const missingFields: string[] = []
    if (!crew) {
      missingFields.push('班组自报表缺记录，现场项按台账/未检补入')
    }
    if (!ledger) {
      missingFields.push('资产台账缺记录，资产项按批次口径补入')
    }
    if (pressure === '未检') {
      missingFields.push('压力未检')
    }
    if (seal === '未检') {
      missingFields.push('铅封未检')
    }
    if (location === '未检') {
      missingFields.push('在位未检')
    }

    let draft: DraftEquip = {
      id: code,
      type,
      model: String(model),
      area,
      crew: crewName,
      batchId: batchId ?? 'CG-UNKNOWN',      purchaseDate,
      manufactureDate: backfill.manufactureDate,
      manufactureSource: backfill.source,
      pressure: pressure as Extinguisher['pressure'],
      seal: seal as Extinguisher['seal'],
      location: location as Extinguisher['location'],
      corrosion,
      status,
      sentAt: status === '待充装' ? LEGACY_CARRIED_ORDER.submittedAt.slice(0, 10) : undefined,
      lastRefillDate: undefined,
      dataSource,
      conflictNote: conflicts.length
        ? `${conflicts.length} 项取值冲突已仲裁：${conflicts.map((c) => `${c.field}→${c.winner}`).join('；')}`
        : missingFields.length
          ? missingFields.join('；')
          : undefined,
      rev: 1,
    }
    draft = attachConclusion(draft, state.ruleVersion)
    const attached = draft as Extinguisher
    draft.history = [
      {
        at: report.at,
        text: `老数据迁移：沿用原编号 ${code}；${dataSource}${attached.conflictNote ? `；${attached.conflictNote}` : ''}`,
        ruleVersion: state.ruleVersion,
      },
    ]
    state.equipment.push(attached)
    report.conflicts.push(...conflicts)

    // 迁移结论回写现场巡视隐患清单（未整改项）
    // 待充装器材的隐患挂到结转的老充装单上：回厂登记即随复检闭环
    const carriedRef = code === LEGACY_CARRIED_ORDER.equipId ? LEGACY_CARRIED_ORDER.id : undefined
    const c = attached.conclusion
    if (c.grade !== '正常') {
      addHazard({
        source: '迁移结论回写',
        refOrder: carriedRef,
        equipId: code,
        area,
        description: `迁移时按${RULE_LABEL[state.ruleVersion].split('（')[0]}判定：${c.reasons.join('；')}`,
        grade: c.grade,
        ruleVersion: state.ruleVersion,
        status: carriedRef ? '整改中' : '未整改',
        concludedAt: report.at,
        note: carriedRef ? '老数据迁移存量隐患，已随老充装单送修，回厂复检闭环' : '老数据迁移形成的存量隐患',
      })
    }
  }

  // 结转老充装单（业务单据随台账一起迁入）
  const carried: BusinessOrder = {
    id: LEGACY_CARRIED_ORDER.id,
    kind: '充装',
    idempotencyKey: LEGACY_CARRIED_ORDER.idempotencyKey,
    areas: [LEGACY_CARRIED_ORDER.area],
    operator: LEGACY_CARRIED_ORDER.operator,
    items: [LEGACY_CARRIED_ORDER.equipId],
    results: [
      {
        id: LEGACY_CARRIED_ORDER.equipId,
        ok: true,
        reason: '老充装单结转：已送充，等待回厂',
        before: '在值',
        after: '待充装',
      },
    ],
    status: '已送充',
    submittedAt: LEGACY_CARRIED_ORDER.submittedAt,
    repeatAttempts: [],
    rev: 1,
  }
  state.orders.push(carried)
  state.idempotency[carried.idempotencyKey] = {
    at: carried.submittedAt,
    operator: carried.operator,
    kind: '充装',
    refId: carried.id,
    summary: '迁移结转的老充装单',
  }
  report.carriedOrders.push(carried.id)

  // 结转演练（含一笔已取消，用来演示时段释放）
  for (const d of LEGACY_DRILLS) {
    const plan: DrillPlan = {
      id: d.id,
      idempotencyKey: `legacy-${d.id}`,
      area: d.area,
      crew: d.crew,
      date: d.date,
      slot: d.slot,
      scenario: d.scenario,
      status: d.cancelledAt ? '已取消' : '已排期',
      createdAt: d.createdAt,
      cancelledAt: d.cancelledAt,
      rev: 1,
    }
    state.drills.push(plan)
    if (plan.status === '已排期') {
      state.idempotency[plan.idempotencyKey] = {
        at: plan.createdAt,
        operator: plan.crew,
        kind: '演练',
        refId: plan.id,
        summary: '迁移结转的演练计划',
      }
    }
  }

  state.hazards.push(...carriedHazards)
  report.total = state.equipment.length
  state.migrationReport = report
  state.migrated = true
}

function freshState(): FireState {
  const state: FireState = {
    revision: 0,
    migrated: false,
    ruleVersion: 'v1',
    seq: 1,
    areas: ['主厂房', '升压站', '办公区', '仓储库房', '启闭机室'],
    batches: LEGACY_BATCHES.map((b) => ({ ...b, knownManufactureDates: [...b.knownManufactureDates] })),
    equipment: [],
    orders: [],
    drills: [],
    hazards: [],
    archives: [],
    idempotency: {},
    commitLog: [],
    migrationReport: null,
  }
  return state
}

function loadState(): FireState {
  const base = freshState()
  if (typeof window === 'undefined' || !window.localStorage) {
    migrate(base)
    recomputeAll(base, base.ruleVersion)
    return base
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    migrate(base)
    recomputeAll(base, base.ruleVersion)
    persist(base)
    return base
  }
  try {
    const parsed = JSON.parse(raw) as FireState
    const restored: FireState = { ...base, ...parsed }
    if (!restored.migrated) {
      migrate(restored)
    }
    recomputeAll(restored, restored.ruleVersion)
    return restored
  } catch {
    migrate(base)
    recomputeAll(base, base.ruleVersion)
    persist(base)
    return base
  }
}

function persist(state: FireState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

/** 换版或加载后整体重算：已有记录按当前版本重算结论（隐患表旧结论另存，不覆盖） */
function recomputeAll(state: FireState, version: RuleVersion): void {
  state.equipment = state.equipment.map((e) => attachConclusion(clone(e), version))
}

// —————————————————————— 响应式单例 ——————————————————————

const state = reactive<FireState>(loadState()) as FireState
const stateVersion = ref(0)
const bump = () => {
  stateVersion.value += 1
}

// 提交队列：把并发调用串起来，按到达顺序逐笔落库
type QueuedTx = () => void
const queue: QueuedTx[] = []
let draining = false
function enqueue(job: QueuedTx): void {
  queue.push(job)
  if (!draining) {
    draining = true
    const run = () => {
      const next = queue.shift()
      if (!next) {
        draining = false
        return
      }
      next()
      window.setTimeout(run, 0)
    }
    window.setTimeout(run, 0)
  }
}

function nextId(prefix: string): string {
  const year = today().slice(0, 4)
  const seq = String(state.seq).padStart(4, '0')
  state.seq += 1
  if (prefix === 'CZ' || prefix === 'BF') {
    return `${prefix}-${year}-${seq}`
  }
  return `${prefix}-${year}-${seq}`
}

interface CommitContext {
  draft: FireState
  log: (type: string, summary: string, scopes: string[]) => void
  makeId: (prefix: string) => string
}

type CommitResult =
  | { ok: true; revision: number; reason?: undefined; duplicate?: false; conflict?: false }
  | { ok: false; reason: string; duplicate: boolean; conflict: boolean; revision?: undefined }

/**
 * 单事务提交：基于快照试算，通过后一次性覆盖落库；任何异常都不会污染当前状态。
 * lockRevs 声明本笔依赖哪些实体的哪个版本，落库前与现行版本比对（CAS）。
 */
function commit(
  operator: string,
  lockRevs: Record<string, number>,
  lockIdemKey: string | undefined,
  fn: (ctx: CommitContext) => void,
): CommitResult {
  // 幂等：同一张单只有第一笔算数
  if (lockIdemKey && state.idempotency[lockIdemKey]) {
    const first = state.idempotency[lockIdemKey]
    return {
      ok: false,
      reason: `单号 ${lockIdemKey} 已于 ${first.at} 由 ${first.operator} 落库（${first.summary}）。同一张单重复提交，后到的整套退回。`,
      duplicate: true,
      conflict: false,
    }
  }
  // CAS：本笔勾选后被先到一笔改过的实体，不允许再写
  const touched = Object.entries(lockRevs)
  for (const [id, rev] of touched) {
    const current =
      state.equipment.find((e) => e.id === id) ??
      state.orders.find((o) => o.id === id) ??
      state.drills.find((d) => d.id === id)
    if (current && current.rev !== rev) {
      return {
        ok: false,
        reason: `器材/单据 ${id} 在你勾选后已被先到的一笔提交改动（版本 ${rev} → ${current.rev}），并发提交只让第一笔生效，本笔整笔拒绝写入。`,
        duplicate: false,
        conflict: true,
      }
    }
  }

  const draft = clone(state)
  let entry: CommitLogEntry | null = null
  try {
    const ctx: CommitContext = {
      draft,
      makeId: (prefix) => {
        const seq = String(draft.seq).padStart(4, '0')
        draft.seq += 1
        const year = today().slice(0, 4)
        return `${prefix}-${year}-${seq}`
      },
      log: (type, summary, scopes) => {
        entry = { at: nowStamp(), revision: draft.revision + 1, type, operator, summary, scopes }
      },
    }
    fn(ctx)
  } catch (error) {
    return {
      ok: false,
      reason: `事务校验失败，台账与业务清单均未变更，整笔回滚：${error instanceof Error ? error.message : String(error)}`,
      duplicate: false,
      conflict: false,
    }
  }

  // 快照整体替换：台账、单据、隐患、时段在同一笔里落库（同生共死）
  draft.revision += 1
  if (entry) {
    draft.commitLog.unshift(entry)
  }
  persist(draft)
  Object.assign(state, draft)
  bump()
  return { ok: true, revision: draft.revision }
}

function lockFor(ids: string[]): Record<string, number> {
  const locks: Record<string, number> = {}
  for (const id of ids) {
    const equip = state.equipment.find((e) => e.id === id)
    if (equip) {
      locks[id] = equip.rev
    }
  }
  return locks
}

// —————————————————————— 业务：批量充装 / 报废 ——————————————————————

function evaluateBatch(input: BatchInput): Promise<BatchResponse> {
  return new Promise((resolve) => {
    enqueue(() => {
      const at = nowStamp()
      const rejected = (extra: Partial<BatchResponse> & { reason: string }): BatchResponse => ({
        accepted: false,
        rejected: true,
        okItems: [],
        failedItems: [],
        revision: state.revision,
        at,
        ...extra,
      })

      if (!input.ids.length) {
        resolve(rejected({ reason: '未勾选任何器材，批量提交需要先按区域多选器材' }))
        return
      }
      const key = input.key ?? `${input.kind}-${[...input.ids].sort().join('|')}`

      // 重复提交：登记一次“后到退回”的留痕到首单上
      if (state.idempotency[key]) {
        const first = state.idempotency[key]
        const firstOrder = state.orders.find((o) => o.id === first.refId)
        if (firstOrder) {
          firstOrder.repeatAttempts.push({ at, operator: input.operator, message: first.summary })
          const logged = clone(state)
          logged.revision += 1
          logged.commitLog.unshift({
            at,
            revision: logged.revision,
            type: `重复${input.kind}单退回`,
            operator: input.operator,
            summary: `单号 ${key} 重复提交被整套退回，以 ${first.at} 落库的一版为准`,
            scopes: ['orders'],
          })
          persist(logged)
          Object.assign(state, logged)
          bump()
        }
        resolve(
          rejected({
            duplicate: true,
            reason: `充装/处理单 ${key} 重复提交：只有 ${first.at} 先落库的一版算数，本笔（后到）整套退回，未写入任何器材台账。`,
          }),
        )
        return
      }

      const locks = { ...lockFor(input.ids), ...input.baseRevs }
      const result = commit(input.operator, locks, key, (ctx) => {
        const d = ctx.draft
        const okItems: OrderItemResult[] = []
        const failedItems: OrderItemResult[] = []
        const areas = new Set<string>()

        for (const id of input.ids) {
          const equip = d.equipment.find((e) => e.id === id)
          if (!equip) {
            failedItems.push({ id, ok: false, reason: '器材不存在（可能已被其他单据处理）', before: '—', after: '—' })
            continue
          }
          areas.add(equip.area)
          const before = equip.status
          if (input.kind === '充装') {
            if (equip.status === '已报废') {
              failedItems.push({ id, ok: false, reason: '已报废器材不能送充，请改走报废', before, after: before })
              continue
            }
            if (equip.status === '待充装') {
              failedItems.push({ id, ok: false, reason: '已在待充装途中，未回厂前不能重复送充', before, after: before })
              continue
            }
            equip.status = '待充装'
            equip.sentAt = today()
            equip.rev += 1
            equip.history.push({ at, text: `批量送充：${input.operator} 提交充装单`, ruleVersion: d.ruleVersion })
            equip.conclusion = evaluate(equip, d.ruleVersion)
            okItems.push({ id, ok: true, reason: '已送出充装，状态置为待充装', before, after: '待充装' })
          } else {
            if (equip.status === '已报废') {
              failedItems.push({ id, ok: false, reason: '器材已报废，无需重复报废', before, after: before })
              continue
            }
            equip.status = '已报废'
            equip.rev += 1
            equip.history.push({ at, text: `批量报废：${input.operator} 提交报废单`, ruleVersion: d.ruleVersion })
            equip.conclusion = evaluate(equip, d.ruleVersion)
            okItems.push({ id, ok: true, reason: '已报废离位，台账销账', before, after: '已报废' })
          }
        }

        // 同一笔内逐台失败 -> 业务约定：失败台保持原状，成功台照常落单，但整单仍记明细
        const order: BusinessOrder = {
          id: ctx.makeId(input.kind === '充装' ? 'CZ' : 'BF'),
          kind: input.kind,
          idempotencyKey: key,
          areas: [...areas],
          operator: input.operator,
          items: input.ids,
          results: [...okItems, ...failedItems],
          status: input.kind === '充装' ? '已送充' : '已报废',
          submittedAt: at,
          repeatAttempts: [],
          rev: 1,
        }
        d.orders.unshift(order)
        d.idempotency[key] = {
          at,
          operator: input.operator,
          kind: input.kind,
          refId: order.id,
          summary: `${input.kind}单 ${order.id}，成功 ${okItems.length} 台，未送出 ${failedItems.length} 台`,
        }

        // 处理结论回写现场巡视隐患清单（随同一事务落库）
        let seq = d.hazards.length + 1
        for (const item of okItems) {
          const equip = d.equipment.find((e) => e.id === item.id)!
          d.hazards.unshift({
            id: `YH-${String(seq).padStart(4, '0')}`,
            source: input.kind === '充装' ? '充装处理回写' : '报废处理回写',
            refOrder: order.id,
            equipId: item.id,
            area: equip.area,
            description:
              input.kind === '充装'
                ? `充装单 ${order.id} 已送充，器材离位待回厂，列入现场巡视跟踪`
                : `报废单 ${order.id} 已报废离位，现场隐患随资产销账闭环`,
            grade: input.kind === '充装' ? '严重隐患' : '一般隐患',
            ruleVersion: d.ruleVersion,
            status: input.kind === '报废' ? '已闭环' : '整改中',
            concludedAt: at,
            closedAt: input.kind === '报废' ? at : undefined,
          })
          seq += 1
        }

        ctx.log(
          `批量${input.kind}`,
          `${input.kind}单 ${order.id}：勾选 ${input.ids.length} 台，成功 ${okItems.length}，未送出/未处理 ${failedItems.length}`,
          ['equipment', 'orders', 'hazards'],
        )

        // 把明细挂到提交结果上（通过闭包外变量）
        pendingResult = { order: clone(order), okItems, failedItems }
      })

      if (!result.ok) {
        resolve(
          rejected({
            duplicate: result.duplicate,
            conflict: result.conflict,
            rolledBack: !result.duplicate && !result.conflict,
            reason: result.reason,
          }),
        )
        return
      }

      const pr = pendingResult!
      pendingResult = null
      resolve({
        accepted: true,
        rejected: false,
        order: pr.order,
        okItems: pr.okItems,
        failedItems: pr.failedItems,
        revision: result.revision,
        at,
      })
    })
  })
}

let pendingResult: { order: BusinessOrder; okItems: OrderItemResult[]; failedItems: OrderItemResult[] } | null = null

// —————————————————————— 业务：充装回厂 ——————————————————————

interface SimpleResult {
  ok: boolean
  message: string
  revision: number
  duplicate?: boolean
  conflict?: boolean
}

function returnRefill(orderId: string, operator: string, returnedIds: string[]): Promise<SimpleResult> {
  return new Promise((resolve) => {
    enqueue(() => {
      const at = nowStamp()
      const order = state.orders.find((o) => o.id === orderId)
      if (!order) {
        resolve({ ok: false, message: '充装单不存在', revision: state.revision })
        return
      }
      const locks: Record<string, number> = { [orderId]: order.rev, ...lockFor(returnedIds) }
      const result = commit(operator, locks, undefined, (ctx) => {
        const d = ctx.draft
        const target = d.orders.find((o) => o.id === orderId)!
        let done = 0
        for (const id of returnedIds) {
          const equip = d.equipment.find((e) => e.id === id)
          if (!equip || equip.status !== '待充装') {
            continue
          }
          equip.status = '在值'
          equip.returnedAt = today()
          equip.lastRefillDate = today()
          equip.rev += 1
          equip.history.push({ at, text: `充装回厂：${operator} 确认回厂复检合格`, ruleVersion: d.ruleVersion })
          equip.conclusion = evaluate(equip, d.ruleVersion)
          target.results = target.results.map((r) =>
            r.id === id ? { ...r, ok: true, reason: '已回厂复检合格，恢复在值', after: '在值' } : r,
          )
          // 回写隐患闭环
          const open = d.hazards.find((h) => h.equipId === id && h.refOrder === orderId && h.status !== '已闭环')
          if (open) {
            open.status = '已闭环'
            open.closedAt = at
            open.note = `${open.note ?? ''} 充装回厂，随复检闭环`.trim()
          }
          done += 1
        }
        const stillOut = target.items.filter((id) =>
          d.equipment.some((e) => e.id === id && e.status === '待充装'),
        )
        target.status = stillOut.length ? '已送充' : '已回厂'
        target.returnedAt = today()
        target.rev += 1
        if (done === 0) {
          throw new Error('所选器材均不在待充装状态，无一台可回厂')
        }
        ctx.log('充装回厂', `充装单 ${orderId} 回厂 ${done} 台，区域可演练状态随之更新`, ['equipment', 'orders', 'hazards'])
      })
      resolve(
        result.ok
          ? { ok: true, message: `已登记回厂，相关区域的演练待办已自动刷新`, revision: result.revision }
          : { ok: false, message: result.reason, revision: state.revision, duplicate: result.duplicate, conflict: result.conflict },
      )
    })
  })
}

// —————————————————————— 业务：演练排期 / 取消 ——————————————————————

interface DrillInput {
  area: string
  crew: string
  date: string
  slot: Slot
  scenario: string
  operator: string
}

interface DrillResult extends SimpleResult {
  plan?: DrillPlan
}

function scheduleDrill(input: DrillInput): Promise<DrillResult> {
  return new Promise((resolve) => {
    enqueue(() => {
      const at = nowStamp()
      // 区域还有待充装 -> 只能排到充装完成之后（两处页面共用 drillBlockers）
      const blocker = drillBlockers(state.equipment, input.area, state.ruleVersion)
      if (blocker) {
        resolve({ ok: false, message: blocker, revision: state.revision })
        return
      }
      // 时段占用：同区域 日期+时段 已被已排期/已完成的计划占用 -> 拒绝并指出占用班组
      const occupant = state.drills.find(
        (d) => d.area === input.area && d.date === input.date && d.slot === input.slot && d.status !== '已取消',
      )
      if (occupant) {
        resolve({
          ok: false,
          message: `${input.area} ${input.date} ${input.slot} 已被 ${occupant.crew} 的演练 ${occupant.id} 占用，请换时段`,
          revision: state.revision,
        })
        return
      }

      const key = `YL-${input.area}-${input.date}-${input.slot}`
      const result = commit(input.operator, {}, key, (ctx) => {
        const d = ctx.draft
        const plan: DrillPlan = {
          id: ctx.makeId('YL'),
          idempotencyKey: key,
          area: input.area,
          crew: input.crew,
          date: input.date,
          slot: input.slot,
          scenario: input.scenario,
          status: '已排期',
          createdAt: at,
          rev: 1,
        }
        d.drills.unshift(plan)
        d.idempotency[key] = { at, operator: input.operator, kind: '演练', refId: plan.id, summary: plan.scenario }
        ctx.log('演练排期', `${plan.crew} 排定 ${input.area} ${input.date} ${input.slot} 演练`, ['drills'])
        pendingPlan = clone(plan)
      })
      if (result.ok && pendingPlan) {
        resolve({ ok: true, message: '演练已排期，时段已占用', plan: pendingPlan, revision: result.revision })
      } else if (result.ok) {
        resolve({ ok: false, message: '排期结果缺失，请重试', revision: state.revision })
      } else {
        resolve({ ok: false, message: result.reason, revision: state.revision, duplicate: result.duplicate, conflict: result.conflict })
      }
      pendingPlan = null
    })
  })
}

let pendingPlan: DrillPlan | null = null

function cancelDrill(planId: string, operator: string): Promise<SimpleResult> {
  return new Promise((resolve) => {
    enqueue(() => {
      const at = nowStamp()
      const plan = state.drills.find((d) => d.id === planId)
      if (!plan) {
        resolve({ ok: false, message: '演练计划不存在', revision: state.revision })
        return
      }
      if (plan.status === '已取消') {
        resolve({ ok: false, message: '该演练已取消，时段早已释放', revision: state.revision })
        return
      }
      const result = commit(operator, { [planId]: plan.rev }, undefined, (ctx) => {
        const d = ctx.draft
        const target = d.drills.find((x) => x.id === planId)!
        target.status = '已取消'
        target.cancelledAt = at
        target.rev += 1
        // 关键：取消后把占用时段放回去（删除幂等占用），后续班组可重新占用
        delete d.idempotency[target.idempotencyKey]
        ctx.log('演练取消', `${plan.crew} 取消 ${target.area} ${target.date} ${target.slot} 演练，时段已释放`, ['drills'])
      })
      resolve(
        result.ok
          ? { ok: true, message: '演练已取消，占用时段已放回，可被其他班组重新占用', revision: result.revision }
          : { ok: false, message: result.reason, revision: state.revision, conflict: result.conflict },
      )
    })
  })
}

function finishDrill(planId: string, operator: string): Promise<SimpleResult> {
  return new Promise((resolve) => {
    enqueue(() => {
      const at = nowStamp()
      const plan = state.drills.find((d) => d.id === planId)
      if (!plan || plan.status !== '已排期') {
        resolve({ ok: false, message: '只有已排期演练可以登记完成', revision: state.revision })
        return
      }
      const result = commit(operator, { [planId]: plan.rev }, undefined, (ctx) => {
        const d = ctx.draft
        const target = d.drills.find((x) => x.id === planId)!
        target.status = '已完成'
        target.finishedAt = at
        target.rev += 1
        ctx.log('演练完成', `${plan.crew} 完成 ${target.area} 演练`, ['drills'])
      })
      resolve(result.ok ? { ok: true, message: '演练已登记完成', revision: result.revision } : { ok: false, message: result.reason, revision: state.revision })
    })
  })
}

// —————————————————————— 业务：季度整组另存 ——————————————————————

function archiveQuarter(area: string, operator: string, date = today()): SimpleResult {
  const at = nowStamp()
  const { year, quarter } = quarterOf(date)
  // 同季度同区域只存一份（重复另算重复提交）
  const existed = state.archives.find((a) => a.year === year && a.quarter === quarter && a.area === area)
  if (existed) {
    return {
      ok: false,
      message: `${year}年第${quarter}季度 ${area} 的整组清单已于 ${existed.createdAt} 另存，同一季度同一区域不重复另存`,
      revision: state.revision,
      duplicate: true,
    }
  }
  const locks = lockFor(state.equipment.filter((e) => e.area === area).map((e) => e.id))
  const result = commit(operator, locks, `AR-${year}Q${quarter}-${area}`, (ctx) => {
    const d = ctx.draft
    const equipmentSnapshot = d.equipment.filter((e) => e.area === area).map(clone)
    const drillSnapshot = d.drills.filter(
      (x) =>
        x.area === area &&
        quarterOf(x.date).year === year &&
        quarterOf(x.date).quarter === quarter,
    ).map(clone)
    // 页面条数与另存条数必须对得上（台账与演练都校验）
    const pageEquipCount = d.equipment.filter((e) => e.area === area).length
    const pageDrillCount = d.drills.filter(
      (x) => x.area === area && quarterOf(x.date).year === year && quarterOf(x.date).quarter === quarter,
    ).length
    if (equipmentSnapshot.length !== pageEquipCount || drillSnapshot.length !== pageDrillCount) {
      throw new Error('另存条数与页面条数不一致，拒绝另存')
    }
    const archive: QuarterlyArchive = {
      id: ctx.makeId('DA'),
      year,
      quarter,
      area,
      createdAt: at,
      ruleVersion: d.ruleVersion,
      equipmentSnapshot,
      drillSnapshot,
      equipmentCount: { pageCount: pageEquipCount, archivedCount: equipmentSnapshot.length, match: equipmentSnapshot.length === pageEquipCount },
      drillCount: { pageCount: pageDrillCount, archivedCount: drillSnapshot.length, match: drillSnapshot.length === pageDrillCount },
      fingerprint: fingerprint({ year, quarter, area, equip: equipmentSnapshot.length, drill: drillSnapshot.length }),
    }
    d.archives.unshift(archive)
    ctx.log('季度另存', `${year}Q${quarter} ${area} 整组另存：灭火器台账 ${equipmentSnapshot.length} 条、演练 ${drillSnapshot.length} 条`, ['archives'])
  })
  return result.ok
    ? { ok: true, message: `${year}年第${quarter}季度 ${area} 已整组另存（演练与灭火器台账条数与页面一致）`, revision: result.revision }
    : { ok: false, message: result.reason, revision: state.revision, duplicate: result.duplicate }
}

// —————————————————————— 业务：规则换版重算 ——————————————————————

function switchVersion(version: RuleVersion, operator: string): SimpleResult {
  if (state.ruleVersion === version) {
    return { ok: true, message: `当前已经是${RULE_LABEL[version]}`, revision: state.revision }
  }
  const at = nowStamp()
  const locks = lockFor(state.equipment.map((e) => e.id))
  const result = commit(operator, locks, undefined, (ctx) => {
    const d = ctx.draft
    const oldVersion = d.ruleVersion
    for (const equip of d.equipment) {
      const before = evaluate(equip, oldVersion)
      equip.conclusion = evaluate(equip, version)
      equip.rev += 1
      // 旧结论保留当时等级并注明版本：只追加历史，不改隐患表里的旧记录
      equip.history.push({
        at,
        text: `规则换版 ${oldVersion} → ${version}：隐患等级 ${before.grade} → ${equip.conclusion.grade}；充装期/报废年限按新版重算（旧结论保留 ${before.grade}@${oldVersion}）`,
        ruleVersion: version,
      })
    }
    d.ruleVersion = version
    // 未闭环隐患旧结论保留等级，补一条“新版建议”注记，不覆盖原等级
    for (const h of d.hazards) {
      if (h.status !== '已闭环' && h.ruleVersion !== version) {
        const equip = d.equipment.find((e) => e.id === h.equipId)
        const nowGrade = equip ? equip.conclusion.grade : h.grade
        h.note = `${h.note ?? ''} 换版重算建议：${nowGrade}@${version}（原等级 ${h.grade}@${h.ruleVersion} 保留）`.trim()
      }
    }
    ctx.log('规则换版', `口径从 ${oldVersion} 切换为 ${version}，已有记录按新版重算，旧结论保留原等级并注明版本`, ['equipment', 'hazards'])
  })
  return result.ok
    ? { ok: true, message: `已切换到${RULE_LABEL[version]}，已有记录已按新版重算`, revision: result.revision }
    : { ok: false, message: result.reason, revision: state.revision }
}

// —————————————————————— 隐患整改 ——————————————————————

function closeHazard(hazardId: string, operator: string): SimpleResult {
  const hazard = state.hazards.find((h) => h.id === hazardId)
  if (!hazard) {
    return { ok: false, message: '隐患不存在', revision: state.revision }
  }
  if (hazard.status === '已闭环') {
    return { ok: false, message: '隐患已闭环', revision: state.revision }
  }
  const result = commit(operator, {}, undefined, (ctx) => {
    const d = ctx.draft
    const target = d.hazards.find((h) => h.id === hazardId)!
    target.status = '已闭环'
    target.closedAt = nowStamp()
    target.note = `${target.note ?? ''} 现场巡视确认整改`.trim()
    ctx.log('隐患闭环', `${hazardId} 经现场巡视确认闭环`, ['hazards'])
  })
  return result.ok ? { ok: true, message: '隐患已闭环', revision: result.revision } : { ok: false, message: result.reason, revision: state.revision }
}

// —————————————————————— 导出（条数与页面一致） ——————————————————————

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): number {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))]
  const content = `﻿${lines.join('\n')}`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return rows.length
}

// —————————————————————— 演示：重置与故障回滚 ——————————————————————

function resetDemo(): void {
  const fresh = freshState()
  migrate(fresh)
  recomputeAll(fresh, fresh.ruleVersion)
  persist(fresh)
  Object.assign(state, fresh)
  bump()
}

/** 演示用：故意制造事务失败，证明台账与业务清单都不会变（整笔回滚） */
function simulateFailingTx(operator: string): Promise<SimpleResult> {
  return new Promise((resolve) => {
    enqueue(() => {
      const before = state.revision
      const result = commit(operator, {}, undefined, () => {
        throw new Error('模拟写入失败：例如隐患回写不可写')
      })
      resolve(
        result.ok
          ? { ok: true, message: '不应成功', revision: state.revision }
          : { ok: false, message: `${result.reason}；修订号保持 ${before}（未变）`, revision: state.revision },
      )
    })
  })
}

// —————————————————————— 只读视图 ——————————————————————

function useFireStore() {
  const readiness = (area: string) => areaReadiness(state.equipment, area, state.ruleVersion)
  const allReadiness = computed(() => state.areas.map((a) => areaReadiness(state.equipment, a, state.ruleVersion)))
  const equipmentList = computed(() => state.equipment.map((e) => ({ ...e, conclusion: evaluate(e, state.ruleVersion) })))
  const drillsList = computed(() => [...state.drills])
  const hazardsList = computed(() => [...state.hazards])
  const ordersList = computed(() => [...state.orders])
  const archivesList = computed(() => [...state.archives])
  const logList = computed(() => [...state.commitLog])

  return {
    state,
    stateVersion,
    ruleLabel: computed(() => RULE_LABEL[state.ruleVersion]),
    equipmentList,
    drillsList,
    hazardsList,
    ordersList,
    archivesList,
    logList,
    allReadiness,
    readiness,
    evaluateBatch,
    returnRefill,
    scheduleDrill,
    cancelDrill,
    finishDrill,
    archiveQuarter,
    switchVersion,
    closeHazard,
    downloadCsv,
    resetDemo,
    simulateFailingTx,
  }
}

export { useFireStore }
export type { HazardGrade }
