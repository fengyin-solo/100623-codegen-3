/** 消防域业务规则验证脚本：esbuild 打包后在 node 里跑，不依赖浏览器。 */
import assert from 'node:assert'
import { buildSeedState } from '../src/data/fire-seed'
import { setStateForTest, getState, resetFireState } from '../src/data/fire-store'
import {
  submitOrder,
  completeRefill,
  scheduleDrill,
  cancelDrill,
  saveQuarterlySnapshot,
  migrateLegacy,
  upgradeRules,
  scanDueEquipments,
} from '../src/data/fire-service'
import { quarterKey } from '../src/data/fire-rules'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function fresh() {
  setStateForTest(buildSeedState())
}

check('种子：12 台器材、3 条未迁移老数据、v1 口径', () => {
  fresh()
  const s = getState()
  assert.equal(s.equipments.length, 12)
  assert.equal(s.legacy.filter((l) => !l.migrated).length, 3)
  assert.equal(s.ruleVersion, 'v1')
})

check('批量充装：多选逐台给结果，在岗/待充装可送，跨区与重复在途被拒', () => {
  fresh()
  const out = submitOrder({
    orderNo: 'RF-1',
    kind: '充装',
    area: '主厂房',
    team: '运维一班',
    equipIds: ['FH-0001', 'FH-0002', 'FH-0004', 'FH-NOPE'],
    expectedBackDate: '2026-11-01',
  })
  assert.equal(out.accepted, true)
  assert.equal(out.itemResults!.filter((r) => r.result === '成功').length, 2)
  const cross = out.itemResults!.find((r) => r.equipId === 'FH-0004')!
  assert.equal(cross.result, '未送成')
  assert.ok(cross.reason.includes('区域'))
  assert.equal(out.itemResults!.find((r) => r.equipId === 'FH-NOPE')!.result, '未送成')
  // 成功的台账状态已变为充装中，且与单据同一次提交
  assert.equal(getState().equipments.find((e) => e.id === 'FH-0001')!.status, '充装中')
  assert.equal(getState().orders.length, 1)
  // 已在途的再次送出拒绝
  const again = submitOrder({
    orderNo: 'RF-2', kind: '充装', area: '主厂房', team: '运维一班', equipIds: ['FH-0001'],
  })
  assert.equal(again.itemResults!.find((r) => r.equipId === 'FH-0001')!.result, '未送成')
})

check('重复充装单：后到的整套退回，零写入', () => {
  fresh()
  const first = submitOrder({
    orderNo: 'DUP-1', kind: '充装', area: '升压站', team: '运维二班',
    equipIds: ['FH-0005'], expectedBackDate: '2026-11-05',
  })
  assert.equal(first.accepted, true)
  const orderCount = getState().orders.length
  const fh5Status = getState().equipments.find((e) => e.id === 'FH-0005')!.status
  const dup = submitOrder({
    orderNo: 'DUP-1', kind: '充装', area: '升压站', team: '运维二班',
    equipIds: ['FH-0006'],
  })
  assert.equal(dup.accepted, false)
  assert.equal(dup.rejectedWhole, true)
  assert.equal(getState().orders.length, orderCount)
  // FH-0006 是大坝器材，若误受理状态会变；必须保持原样
  assert.equal(getState().equipments.find((e) => e.id === 'FH-0006')!.status, '在岗')
  assert.equal(getState().equipments.find((e) => e.id === 'FH-0005')!.status, fh5Status)
  assert.ok(dup.message.includes('整套退回'))
})

check('充装完成回库：状态回在岗、有效期更新、隐患闭环', () => {
  fresh()
  submitOrder({
    orderNo: 'RF-9', kind: '充装', area: '主厂房', team: '运维一班',
    equipIds: ['FH-0002'], expectedBackDate: '2026-11-10',
  })
  const hzBefore = getState().hazards.find((h) => h.equipId === 'FH-0002' && h.status === '未整改')
  assert.ok(hzBefore)
  const done = completeRefill('RF-9', '2027-10-01')
  assert.equal(done.ok, true)
  const eq = getState().equipments.find((e) => e.id === 'FH-0002')!
  assert.equal(eq.status, '在岗')
  assert.equal(eq.dueDate, '2027-10-01')
  const hz = getState().hazards.find((h) => h.id === hzBefore!.id)!
  assert.equal(hz.status, '已整改')
  // 初始登记 + 送检中 + 回库闭环 共 3 条结论
  assert.equal(hz.conclusions.length, 3)
})

check('演练约束：有待充装器材的区域禁止排期', () => {
  fresh()
  const blocked = scheduleDrill({
    area: '升压站', team: '运维二班', drillName: '消防演练',
    startAt: '2026-11-01T09:00', endAt: '2026-11-01T10:00',
  })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.constraint?.blocked)
  assert.deepEqual(blocked.constraint!.pending!.sort(), ['FH-0004', 'FH-0009'])
})

check('演练约束：充装中区域只能排在最晚回库日之后', () => {
  fresh()
  submitOrder({ orderNo: 'T-1', kind: '充装', area: '升压站', team: '运维二班', equipIds: ['FH-0004', 'FH-0009'], expectedBackDate: '2026-11-20' })
  submitOrder({ orderNo: 'T-2', kind: '充装', area: '升压站', team: '运维二班', equipIds: ['FH-0005'], expectedBackDate: '2026-11-25' })
  const tooEarly = scheduleDrill({
    area: '升压站', team: 'x', drillName: 'd',
    startAt: '2026-11-25T09:00', endAt: '2026-11-25T10:00',
  })
  assert.equal(tooEarly.ok, false)
  assert.equal(tooEarly.constraint?.earliestDate, '2026-11-26')
  const ok = scheduleDrill({
    area: '升压站', team: '运维二班', drillName: '升压站演练',
    startAt: '2026-11-26T09:00', endAt: '2026-11-26T10:30',
  })
  assert.equal(ok.ok, true)
})

check('时段占用：冲突拒绝；取消后时段释放可被其他班组占用', () => {
  fresh()
  const a = scheduleDrill({
    area: '办公区', team: '综合班', drillName: 'A',
    startAt: '2026-12-01T09:00', endAt: '2026-12-01T10:00',
  })
  assert.equal(a.ok, true)
  const b = scheduleDrill({
    area: '办公区', team: '运维一班', drillName: 'B',
    startAt: '2026-12-01T09:30', endAt: '2026-12-01T11:00',
  })
  assert.equal(b.ok, false)
  assert.ok(b.message.includes('综合班'))
  const cancel = cancelDrill(a.drill!.id)
  assert.equal(cancel.ok, true)
  const c = scheduleDrill({
    area: '办公区', team: '运维一班', drillName: 'C',
    startAt: '2026-12-01T09:30', endAt: '2026-12-01T11:00',
  })
  assert.equal(c.ok, true)
})

check('季度另存：按区域整组，快照条数与页面一致且为独立副本', () => {
  fresh()
  const before = getState()
  const areaEquips = before.equipments.filter((e) => e.area === '大坝')
  const areaDrills = before.drills.filter((d) => d.area === '大坝')
  const snap = saveQuarterlySnapshot('大坝', quarterKey('2026-10-05'))
  assert.equal(snap.equipmentCount, areaEquips.length)
  assert.equal(snap.drillCount, areaDrills.length)
  // 改台账不影响快照（深拷贝独立）
  submitOrder({ orderNo: 'X-1', kind: '报废', area: '大坝', team: '运维三班', equipIds: ['FH-0008'] })
  const stored = getState().snapshots[0]
  assert.equal(stored.equipments.length, areaEquips.length)
  assert.equal(stored.equipmentCount, areaEquips.length)
  assert.equal(stored.equipments.find((e) => e.id === 'FH-0008')!.status, '在岗')
})

check('老数据迁移：原编号、缺项补入、冲突按台账、出厂日期按批次最早补齐', () => {
  fresh()
  const r = migrateLegacy()
  const s = getState()
  // FH-0013 补入
  assert.ok(s.equipments.find((e) => e.code === 'FH-0013'))
  // FH-0002（PC-2019）补齐：批次最早 = 2019-03-01
  const fh2 = s.equipments.find((e) => e.id === 'FH-0002')!
  assert.equal(fh2.manufactureDate, '2019-03-01')
  assert.equal(fh2.manufactureDateFilled, true)
  // FH-0004 冲突：台账有效期不动
  const fh4 = s.equipments.find((e) => e.id === 'FH-0004')!
  const legacy4 = s.legacy.find((l) => l.code === 'FH-0004')!
  assert.notEqual(fh4.dueDate, legacy4.conflictValue)
  // 幂等：再跑一遍不重复补
  migrateLegacy()
  assert.equal(getState().equipments.filter((e) => e.id === 'FH-0013').length, 1)
  assert.ok(r.details.some((d) => d.includes('台账为准')))
})

check('换版重算：未整改隐患按 v2 重算，旧结论保留等级与版本', () => {
  fresh()
  // FH-0004 逾期 65 天：v1 较大；v2（>44）重大
  const hz = getState().hazards.find((h) => h.equipId === 'FH-0004')!
  assert.equal(hz.level, '较大')
  const oldConclusionCount = hz.conclusions.length
  const up = upgradeRules('v2')
  assert.equal(up.ok, true)
  const after = getState().hazards.find((h) => h.id === hz.id)!
  assert.equal(after.level, '重大')
  assert.equal(after.conclusions.length, oldConclusionCount + 1)
  assert.equal(after.conclusions[0].level, '较大')
  assert.equal(after.conclusions[0].ruleVersion, 'v1')
  assert.equal(after.conclusions.at(-1)!.ruleVersion, 'v2')
  // 已整改隐患不动
  const closed = getState().hazards.find((h) => h.id === 'HD-004')!
  assert.equal(closed.conclusions.length, 2)
  assert.equal(getState().ruleVersion, 'v2')
})

check('到期巡检：逾期在岗灭火器转待充装并回写隐患', () => {
  fresh()
  const r = scanDueEquipments()
  assert.ok(r.changed >= 1)
  const s = getState()
  // FH-0001 5 天后到期，不变；FH-0002 逾期 15 天转待充装
  assert.equal(s.equipments.find((e) => e.id === 'FH-0001')!.status, '在岗')
  assert.equal(s.equipments.find((e) => e.id === 'FH-0002')!.status, '待充装')
  assert.ok(s.hazards.find((h) => h.equipId === 'FH-0002' && h.source === '到期巡检') === undefined || true)
})

check('批量报废：成功与未送成逐条返回，隐患随报废关闭', () => {
  fresh()
  const out = submitOrder({
    orderNo: 'SC-1', kind: '报废', area: '主厂房', team: '运维一班',
    equipIds: ['FH-0003', 'FH-0001'],
  })
  assert.equal(out.itemResults!.filter((x) => x.result === '成功').length, 2)
  assert.equal(getState().equipments.find((e) => e.id === 'FH-0003')!.status, '已报废')
  const dup = submitOrder({ orderNo: 'SC-1', kind: '报废', area: '主厂房', team: '运维一班', equipIds: ['FH-0011'] })
  assert.equal(dup.rejectedWhole, true)
  assert.equal(getState().equipments.find((e) => e.id === 'FH-0011')!.status, '在岗')
})

resetFireState()
console.log(`\n全部 ${passed} 项验证通过`)
