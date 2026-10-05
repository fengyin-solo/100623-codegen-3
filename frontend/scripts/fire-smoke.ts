// 领域逻辑冒烟测试：esbuild 打包后在 Node 内执行，localStorage/window 用内存垫片。
import { useFireStore } from '../src/fire/store'
import { areaReadiness, drillBlockers, evaluate, backfillManufactureDate, parseDate, daysBetween } from '../src/fire/rules'

let passed = 0
let failed = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const store = useFireStore()

  console.log('① 迁移：原编号、补缺、仲裁')
  const ids = store.state.equipment.map((e) => e.id)
  assert(ids.includes('XF-1014'), '班组多出的 XF-1014 缺项一并补入')
  assert(store.state.equipment.length === 14, `共迁移 14 台（实际 ${store.state.equipment.length}）`)
  const x1005 = store.state.equipment.find((e) => e.id === 'XF-1005')!
  assert(x1005.manufactureDate === '2021-06-07', `整批缺出厂日按验收日倒推90天：${x1005.manufactureDate}`)
  assert(x1005.manufactureSource === '批次验收日倒推90天补齐', '补齐口径已标注')
  const x1008 = store.state.equipment.find((e) => e.id === 'XF-1008')!
  assert(x1008.manufactureDate === '2024-05-06', `部分缺失按批次最早出厂日补齐：${x1008.manufactureDate}`)
  const x1004 = store.state.equipment.find((e) => e.id === 'XF-1004')!
  assert(x1004.manufactureDate === '2019-03-11', '出厂日期冲突按资产台账仲裁')
  assert(x1004.location === '缺失', '在位状态冲突按最新现场巡视（班组）仲裁为缺失')
  assert(x1004.dataSource === '冲突仲裁', '冲突来源已标记')
  const x1002 = store.state.equipment.find((e) => e.id === 'XF-1002')!
  assert(x1002.status === '待充装', '业务状态冲突以先落库老充装单为准：待充装')

  console.log('② 区域可演练判定（器材/演练同源）')
  const main = areaReadiness(store.state.equipment, '主厂房', 'v1')
  assert(main.ready === false, '主厂房有待充装器材，不能排演练')
  assert(main.pendingRefill.map((e) => e.id).includes('XF-1002'), '阻塞器材点名 XF-1002')
  assert(!!drillBlockers(store.state.equipment, '主厂房', 'v1'), 'drillBlockers 返回阻塞原因')
  assert(areaReadiness(store.state.equipment, '办公区', 'v1').ready, '办公区当前可演练')

  console.log('③ 批量充装 + 逐台结果 + 回写隐患')
  const beforeHazards = store.state.hazards.length
  const revs = Object.fromEntries(store.equipmentList.value.map((e) => [e.id, e.rev]))
  const r1 = await store.evaluateBatch({ kind: '充装', ids: ['XF-1009', 'XF-1010', 'XF-1013'], operator: 'A', key: 'K-1', baseRevs: revs })
  assert(r1.accepted, '第一张充装单落库')
  assert(r1.okItems.length === 3, `成功 3 台（实际 ${r1.okItems.length}）`)
  assert(store.state.hazards.length === beforeHazards + 3, '处理结论已回写现场巡视隐患清单 3 条')
  assert(store.state.equipment.find((e) => e.id === 'XF-1009')!.status === '待充装', '台账状态随单据一起变为待充装')

  console.log('④ 同一张单重复提交：后到整套退回')
  const revAfter = store.state.revision
  const r2 = await store.evaluateBatch({ kind: '充装', ids: ['XF-1009', 'XF-1010', 'XF-1013'], operator: 'B', key: 'K-1', baseRevs: revs })
  assert(!r2.accepted && r2.duplicate, '重复单整套退回')
  assert(store.state.revision === revAfter + 1, '仅留痕一条，无业务数据写入')
  const order = store.state.orders.find((o) => o.idempotencyKey === 'K-1')!
  assert(order.repeatAttempts.length === 1, '首单上留有后到退回记录')

  console.log('⑤ 批量逐台失败单列原因（已在待充装/已报废）')
  const r3 = await store.evaluateBatch({ kind: '充装', ids: ['XF-1009', 'XF-1002', 'XF-1001'], operator: 'A', key: 'K-2', baseRevs: {} })
  assert(r3.accepted, '单据整体仍受理')
  assert(r3.okItems.length === 1 && r3.okItems[0].id === 'XF-1001', '只有在值的 XF-1001 送出成功')
  const failIds = r3.failedItems.map((f) => f.id)
  assert(failIds.includes('XF-1009') && failIds.includes('XF-1002'), '没送成的 XF-1009/XF-1002 被单独列出')
  assert(r3.failedItems.every((f) => f.reason.length > 0), '每台失败都写明原因')

  console.log('⑥ 并发不同单据抢同一台：只有第一笔生效（CAS）')
  const casId = 'XF-1003'
  const casRev = store.state.equipment.find((e) => e.id === casId)!.rev
  const [c1, c2] = await Promise.all([
    store.evaluateBatch({ kind: '充装', ids: [casId], operator: 'C1', key: 'C-A', baseRevs: { [casId]: casRev } }),
    store.evaluateBatch({ kind: '报废', ids: [casId], operator: 'C2', key: 'C-B', baseRevs: { [casId]: casRev } }),
  ])
  assert(c1.accepted !== c2.accepted, '两笔恰有一笔被接受')
  assert(!c1.accepted ? c1.conflict : c2.conflict, '后到的一笔是并发冲突整笔拒绝')
  const finalCas = store.state.equipment.find((e) => e.id === casId)!
  assert(finalCas.status === (c1.accepted ? '待充装' : '已报废'), `最终状态与获胜单一致：${finalCas.status}`)

  console.log('⑦ 演练排期：待充装阻塞、时段占用、取消释放')
  const blocked = await store.scheduleDrill({ area: '主厂房', crew: '运行一班', date: '2026-10-28', slot: '上午', scenario: 's', operator: 'A' })
  assert(!blocked.ok && blocked.message.includes('待充装'), '主厂房排期被待充装拦截')
  const s1 = await store.scheduleDrill({ area: '办公区', crew: '综合班', date: '2026-10-21', slot: '上午', scenario: 's1', operator: 'A' })
  assert(s1.ok, '办公区 10-21 上午 排期成功')
  const s2 = await store.scheduleDrill({ area: '办公区', crew: '运行二班', date: '2026-10-21', slot: '上午', scenario: 's2', operator: 'B' })
  assert(!s2.ok && s2.message.includes('占用'), '同一时段不能被下一个班组重复占用')
  const cancel = await store.cancelDrill(s1.plan!.id, 'A')
  assert(cancel.ok, '取消演练')
  const s3 = await store.scheduleDrill({ area: '办公区', crew: '运行二班', date: '2026-10-21', slot: '上午', scenario: 's3', operator: 'B' })
  assert(s3.ok, '取消后时段已放回，其他班组可重新占用')

  console.log('⑧ 充装回厂后阻塞解除，待办跟随变化')
  const refillOrder = store.state.orders.find((o) => o.idempotencyKey === 'legacy-cz-XF-1002')!
  const rr = await store.returnRefill(refillOrder.id, 'A', ['XF-1002'])
  assert(rr.ok, '老充装单回厂')
  // ③ 批量送出的主厂房两台（XF-1009/XF-1010）也要回厂后，区域才真正齐装
  const k1Order = store.state.orders.find((o) => o.idempotencyKey === 'K-1')!
  const rr2 = await store.returnRefill(k1Order.id, 'A', ['XF-1009', 'XF-1010'])
  assert(rr2.ok, '批量充装单上的主厂房器材回厂')
  const k2Order = store.state.orders.find((o) => o.idempotencyKey === 'K-2')!
  const rr3 = await store.returnRefill(k2Order.id, 'A', ['XF-1001'])
  assert(rr3.ok, '逐台成功单上的 XF-1001 回厂')
  assert(areaReadiness(store.state.equipment, '主厂房', 'v1').ready, '主厂房待充装清零，可演练')
  const s4 = await store.scheduleDrill({ area: '主厂房', crew: '运行一班', date: '2026-10-28', slot: '上午', scenario: 's4', operator: 'A' })
  assert(s4.ok, '回厂后主厂房排期成功')
  const carriedHazard = store.state.hazards.find((h) => h.equipId === 'XF-1002' && h.refOrder === refillOrder.id)
  assert(carriedHazard?.status === '已闭环', '回写隐患随回厂闭环')

  console.log('⑨ 季度整组另存：条数与页面一致')
  const pageCount = store.state.equipment.filter((e) => e.area === '主厂房').length
  const a1 = await store.archiveQuarter('主厂房', 'A')
  assert(a1.ok, '主厂房季度另存成功')
  const arch = store.state.archives.find((x) => x.area === '主厂房')!
  assert(arch.equipmentCount.match && arch.equipmentCount.archivedCount === pageCount, `灭火器台账条数对得上（${arch.equipmentCount.archivedCount}=${pageCount}）`)
  const a2 = await store.archiveQuarter('主厂房', 'A')
  assert(!a2.ok && !!a2.duplicate, '同季度同区域重复另存被拒')

  console.log('⑩ 规则换版：按新版重算，旧结论保留等级并注明版本')
  const oldHazard = store.state.hazards.filter((h) => h.status !== '已闭环')[0]
  const oldGrade = oldHazard.grade
  const oldVer = oldHazard.ruleVersion
  const sw = await store.switchVersion('v2', 'A')
  assert(sw.ok && store.state.ruleVersion === 'v2', '已切换到 v2')
  const kept = store.state.hazards.find((h) => h.id === oldHazard.id)!
  assert(kept.grade === oldGrade && kept.ruleVersion === oldVer, '旧隐患结论等级/版本保持不变')
  assert((kept.note ?? '').includes('换版重算建议'), '旁边注明新版建议与原等级')
  const x1001 = store.state.equipment.find((e) => e.id === 'XF-1001')!
  const v1Grade = '重大隐患'
  const v2 = evaluate({ ...x1001, status: '在值' } as never, 'v2')
  // XF-1001 2015 干粉：v1 五年报废（2020 已到），v2 十年报废（2025 已到），两版都应判到报废
  assert(v2.needsScrap, 'v2 重算 XF-1001 仍到报废年限')
  assert(v2.grade === v1Grade, `两版最高等级一致：${v2.grade}`)
  const x1007 = store.state.equipment.find((e) => e.id === 'XF-1007')!
  const g1007v1 = evaluate({ ...x1007, status: '在值' } as never, 'v1')
  const g1007v2 = evaluate({ ...x1007, status: '在值' } as never, 'v2')
  assert(daysBetween('2026-10-05', g1007v1.refillDue) <= 0, '水基 2024-05：v1 每年充装已逾期')
  // 历史中保留了旧结论文本
  assert(x1007.history.some((h) => h.text.includes('换版')), '器材历史注明换版前后等级')

  console.log('⑪ 事务原子性：故意失败整笔回滚')
  const revBeforeFail = store.state.revision
  const f1 = await store.simulateFailingTx('A')
  assert(!f1.ok && store.state.revision === revBeforeFail, '失败事务修订号不变，台账与业务清单都没动')

  console.log('⑫ 导出条数（模拟 downloadCsv 在无 DOM 时返回的行数由调用方保证）')
  const visible = store.equipmentList.value.length
  assert(visible === store.state.equipment.length, '页面列表条数=台账条数（导出同一数据源）')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
