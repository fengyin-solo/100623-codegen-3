<template>
  <section class="page" data-module="fire-safety">
    <header class="page-head">
      <div>
        <h2>消防器材与应急演练</h2>
        <p class="page-desc">
          灭火器、消防栓等器材与季度演练并成一张清单：按区域多选批量充装/报废、逐台结果；
          演练排期自动看器材状态；隐患结论随处置回写；季度整组另存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runScan">到期巡检转待充装</button>
        <button class="btn" type="button" @click="resetAll">恢复演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">在岗器材</span>
        <strong class="stat-value">{{ equipments.filter((e) => e.status === '在岗').length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待充装（演练会被拦）</span>
        <strong class="stat-value">{{ equipments.filter((e) => e.status === '待充装').length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">充装中/已报废</span>
        <strong class="stat-value">
          {{ equipments.filter((e) => e.status === '充装中').length }} /
          {{ equipments.filter((e) => e.status === '已报废').length }}
        </strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">未整改隐患</span>
        <strong class="stat-value">{{ hazards.filter((h) => h.status === '未整改').length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前口径版本</span>
        <strong class="stat-value">{{ ruleVersion }}
          <button class="link" type="button" @click="doUpgrade">换版重算</button>
        </strong>
      </article>
    </div>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: tab === t.key }"
        type="button"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <p v-if="message.text" class="banner" :class="message.kind">{{ message.text }}</p>

    <!-- ============ 器材台账（含批量充装/报废） ============ -->
    <template v-if="tab === 'equipment'">
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>区域</span>
          <select v-model="equipFilter.area">
            <option value="">全部区域</option>
            <option v-for="a in areas" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>状态</span>
          <select v-model="equipFilter.status">
            <option value="">全部状态</option>
            <option v-for="s in statusList" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>检索</span>
          <input v-model="equipFilter.kw" placeholder="编号 / 名称 / 批次" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetEquipFilter">重置</button>
        <span class="grow" />
        <button class="btn" type="button" @click="exportEquipment">导出台账 CSV</button>
      </form>

      <p class="status-legend">
        <span class="legend-item">已选 {{ selected.size }} 台</span>
        <button class="btn" type="button" :disabled="filteredEquips.length === 0" @click="selectAll">
          全选当前结果
        </button>
        <button class="btn ghost" type="button" :disabled="selected.size === 0" @click="selected.clear()">
          清空选择
        </button>
        <span class="legend-item warn" v-if="batchArea === '__mixed__'">勾选跨了多个区域，单据必须按一个区域提交</span>
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 36px">选</th>
            <th>编号</th>
            <th>名称</th>
            <th>类别</th>
            <th>区域</th>
            <th>采购批次</th>
            <th>出厂日期</th>
            <th>有效期至</th>
            <th>逾期</th>
            <th>所属班组</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredEquips" :key="row.id" :class="{ picked: selected.has(row.id) }">
            <td><input type="checkbox" :checked="selected.has(row.id)" @change="toggleSelect(row.id)" /></td>
            <td>{{ row.code }}</td>
            <td>{{ row.name }}</td>
            <td>{{ row.kind }}</td>
            <td>{{ row.area }}</td>
            <td>{{ row.batchNo }}</td>
            <td>
              {{ row.manufactureDate || '缺失' }}
              <span v-if="row.manufactureDateFilled" class="tag">批次补齐</span>
            </td>
            <td>{{ row.dueDate }}</td>
            <td :class="{ overdue: overdueOf(row) > 0 }">
              {{ row.kind === '灭火器' ? (overdueOf(row) > 0 ? `逾期 ${overdueOf(row)} 天` : `${-overdueOf(row)} 天后到期`) : '—' }}
            </td>
            <td>{{ row.team }}</td>
            <td><span class="status" :data-status="row.status">{{ row.status }}</span></td>
          </tr>
          <tr v-if="!filteredEquips.length">
            <td colspan="11" class="empty-state">没有符合条件的器材</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>页面显示 {{ filteredEquips.length }} 条 / 台账共 {{ equipments.length }} 条（导出取当前筛选结果）</span>
      </footer>

      <!-- 批量提交单据 -->
      <div class="batch-box" v-if="selected.size > 0">
        <h3>批量提交（已选 {{ selected.size }} 台）</h3>
        <div class="filter-bar">
          <label class="filter-item">
            <span>单号 *（同号只认第一笔）</span>
            <input v-model="orderForm.orderNo" placeholder="如 RF-2026Q4-01" />
          </label>
          <label class="filter-item">
            <span>类型</span>
            <select v-model="orderForm.kind">
              <option value="充装">充装送检</option>
              <option value="报废">报废处置</option>
            </select>
          </label>
          <label class="filter-item">
            <span>所属区域 *（按勾选器材自动带入）</span>
            <input :value="batchAreaLabel" readonly />
          </label>
          <label class="filter-item">
            <span>送检班组</span>
            <input v-model="orderForm.team" />
          </label>
          <label class="filter-item" v-if="orderForm.kind === '充装'">
            <span>预计回库日</span>
            <input type="date" v-model="orderForm.expectedBackDate" />
          </label>
          <button class="btn primary" type="button" @click="doSubmitOrder">一次提交</button>
        </div>
        <p class="page-desc">
          提交规则：台账状态、充装单、隐患结论在同一事务里一起落库；
          同一充装单重复提交只有第一笔算数，后到的整套退回、零写入；
          逐台结果见下。
        </p>
        <table class="data-table" v-if="lastResults.length">
          <thead><tr><th>编号</th><th>结果</th><th>原因/说明</th></tr></thead>
          <tbody>
            <tr v-for="r in lastResults" :key="r.equipId">
              <td>{{ r.code }}</td>
              <td :class="r.result === '成功' ? 'ok-text' : 'error-text'">{{ r.result }}</td>
              <td>{{ r.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 充装/报废单 ============ -->
    <template v-else-if="tab === 'orders'">
      <div class="page-actions" style="margin-bottom: 10px">
        <button class="btn" type="button" @click="exportOrders">导出单据清单 CSV</button>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>单号</th><th>类型</th><th>区域</th><th>班组</th><th>提交时间</th><th>预计回库</th><th>状态</th><th>逐台结果</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.orderNo">
            <td>{{ o.orderNo }}</td>
            <td>{{ o.kind }}</td>
            <td>{{ o.area }}</td>
            <td>{{ o.team }}</td>
            <td>{{ o.createdAt.replace('T', ' ') }}</td>
            <td>{{ o.expectedBackDate }}</td>
            <td>{{ o.status }}</td>
            <td>
              <span v-for="(r, i) in o.itemResults" :key="i" class="mini" :class="r.result === '成功' ? 'ok' : 'fail'">
                {{ r.code }}：{{ r.result }}
              </span>
            </td>
            <td>
              <button
                v-if="o.kind === '充装' && o.status === '已受理'"
                class="link"
                type="button"
                @click="doComplete(o.orderNo)"
              >完成回库</button>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!orders.length"><td colspan="9" class="empty-state">暂无充装/报废单，去器材台账勾选后批量提交</td></tr>
        </tbody>
      </table>
      <footer class="page-foot"><span>共 {{ orders.length }} 张单据</span></footer>
    </template>

    <!-- ============ 演练排期（与待办共用同一份区域状态） ============ -->
    <template v-else-if="tab === 'drill'">
      <div class="two-col">
        <div>
          <h3>区域器材约束（演练页与待办页读的是同一份）</h3>
          <table class="data-table">
            <thead><tr><th>区域</th><th>待充装</th><th>充装中</th><th>最晚回库</th><th>能否排期</th></tr></thead>
            <tbody>
              <tr v-for="a in areaConstraintRows" :key="a.area">
                <td>{{ a.area }}</td>
                <td :class="{ 'error-text': a.pendingCodes.length }">{{ a.pendingCodes.length }} 台 {{ a.pendingCodes.join('、') }}</td>
                <td>{{ a.transitCodes.length }} 台</td>
                <td>{{ a.latestBackDate || '—' }}</td>
                <td v-if="a.blocked"><span class="error-text">禁止：先送检充装</span></td>
                <td v-else-if="a.earliestDrillDate">仅可排到 {{ a.earliestDrillDate }} 之后</td>
                <td v-else class="ok-text">可排</td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin-top:16px">新建演练计划</h3>
          <form class="filter-bar" @submit.prevent="doSchedule">
            <label class="filter-item"><span>区域</span>
              <select v-model="drillForm.area">
                <option v-for="a in areas" :key="a" :value="a">{{ a }}</option>
              </select>
            </label>
            <label class="filter-item"><span>班组</span><input v-model="drillForm.team" /></label>
            <label class="filter-item"><span>演练名称</span><input v-model="drillForm.drillName" /></label>
            <label class="filter-item"><span>开始</span><input type="datetime-local" v-model="drillForm.startAt" /></label>
            <label class="filter-item"><span>结束</span><input type="datetime-local" v-model="drillForm.endAt" /></label>
            <button class="btn primary" type="submit">提交排期</button>
          </form>
        </div>
      </div>

      <h3 style="margin-top:16px">演练计划与待办（随器材状态自动变化）</h3>
      <table class="data-table">
        <thead><tr><th>编号</th><th>区域</th><th>名称</th><th>班组</th><th>时段</th><th>状态</th><th>排期依据</th><th>待办</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="d in drills" :key="d.id">
            <td>{{ d.id }}</td>
            <td>{{ d.area }}</td>
            <td>{{ d.drillName }}</td>
            <td>{{ d.team }}</td>
            <td>{{ d.startAt.replace('T', ' ') }} ~ {{ d.endAt.replace('T', ' ') }}</td>
            <td>{{ d.status }}</td>
            <td>{{ d.basedOnRefillDate ? `充装须在 ${d.basedOnRefillDate} 前回库` : '排期时无在途/待充装' }}</td>
            <td>
              <span v-if="d.status === '计划中'" class="mini" :class="todoOf(d.area).blocked ? 'fail' : todoOf(d.area).earliestDrillDate ? 'warn-tag' : 'ok'">
                {{ todoOf(d.area).text }}
              </span>
              <span v-else>—</span>
            </td>
            <td>
              <button v-if="d.status === '计划中'" class="link" type="button" @click="doCancel(d.id)">取消并释放时段</button>
              <span v-else>已释放/结束</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- ============ 隐患清单（巡视 + 回写） ============ -->
    <template v-else-if="tab === 'hazard'">
      <div class="page-actions" style="margin-bottom:10px">
        <button class="btn" type="button" @click="exportHazards">导出隐患清单 CSV</button>
        <button class="btn" type="button" @click="doUpgrade">按新口径（{{ ruleVersion === 'v1' ? 'v2' : 'v1' }}）重算未整改项</button>
      </div>
      <table class="data-table">
        <thead><tr><th>编号</th><th>来源</th><th>区域</th><th>关联器材</th><th>描述</th><th>当前等级</th><th>状态</th><th>处理结论流水（保留当时等级与版本）</th></tr></thead>
        <tbody>
          <tr v-for="h in hazards" :key="h.id">
            <td>{{ h.id }}</td>
            <td>{{ h.source }}</td>
            <td>{{ h.area }}</td>
            <td>{{ h.equipId || '—' }}</td>
            <td>{{ h.description }}</td>
            <td><span class="lvl" :data-lvl="h.level">{{ h.level }}</span></td>
            <td>{{ h.status }}</td>
            <td>
              <ol class="conclusions">
                <li v-for="(c, i) in h.conclusions" :key="i">
                  <span class="mini">[{{ c.ruleVersion }} · {{ c.level }} · {{ c.status }}]</span>
                  {{ c.at.replace('T', ' ') }} {{ c.text }}
                </li>
              </ol>
            </td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>页面共 {{ hazards.length }} 条隐患，导出条数与之相同（含结论版本留痕）</span>
      </footer>
    </template>

    <!-- ============ 季度归档与老数据迁移 ============ -->
    <template v-else-if="tab === 'archive'">
      <h3>每季度按区域整组另存（演练 + 器材台账）</h3>
      <form class="filter-bar" @submit.prevent="doSnapshot">
        <label class="filter-item"><span>季度</span><input v-model="snapshotForm.quarter" placeholder="如 2026-Q4" /></label>
        <label class="filter-item"><span>区域</span>
          <select v-model="snapshotForm.area">
            <option v-for="a in areas" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <label class="filter-item"><span>备注</span><input v-model="snapshotForm.note" /></label>
        <button class="btn primary" type="submit">整组另存</button>
      </form>
      <table class="data-table">
        <thead><tr><th>季度</th><th>区域</th><th>另存时间</th><th>器材条数</th><th>演练条数</th><th>备注</th><th>导出</th></tr></thead>
        <tbody>
          <tr v-for="s in snapshots" :key="s.id">
            <td>{{ s.quarterKey }}</td>
            <td>{{ s.area }}</td>
            <td>{{ s.createdAt.replace('T', ' ') }}</td>
            <td>{{ s.equipmentCount }}</td>
            <td>{{ s.drillCount }}</td>
            <td>{{ s.note || '—' }}</td>
            <td>
              <button class="link" type="button" @click="exportSnapshot(s.id, 'equipment')">灭火器台账</button>
              <button class="link" type="button" @click="exportSnapshot(s.id, 'drill')">演练清单</button>
            </td>
          </tr>
          <tr v-if="!snapshots.length"><td colspan="7" class="empty-state">还没有季度归档</td></tr>
        </tbody>
      </table>
      <p class="page-desc">另存条数 = 另存当时页面按该区域过滤出的条数，且为独立副本；事后再改台账不影响已归档数据。</p>

      <h3 style="margin-top:20px">班组散表老数据迁移</h3>
      <p class="page-desc">
        规则：按原编号迁移，台账缺项一并补入；两边取值冲突时<strong>以消防器材台账为准</strong>
        （台账是设备主数据，散表是班组自记），冲突在迁移说明里留痕；
        缺出厂日期的，按<strong>同采购批次已知最早出厂日</strong>补齐（安全从严，宁可早判到期不漏检）。
      </p>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="doMigrate">迁移未处理的老数据（{{ legacy.filter((l) => !l.migrated).length }} 条）</button>
      </div>
      <table class="data-table">
        <thead><tr><th>原编号</th><th>班组</th><th>区域</th><th>批次</th><th>散表出厂日</th><th>散表有效期</th><th>冲突字段/散表值</th><th>已迁移</th></tr></thead>
        <tbody>
          <tr v-for="l in legacy" :key="l.code">
            <td>{{ l.code }}</td><td>{{ l.team }}</td><td>{{ l.area }}</td><td>{{ l.batchNo }}</td>
            <td>{{ l.manufactureDate || '缺失' }}</td><td>{{ l.dueDate }}</td>
            <td>{{ l.conflictField ? `${l.conflictField} = ${l.conflictValue}` : '—' }}</td>
            <td>{{ l.migrated ? '是' : '否' }}</td>
          </tr>
        </tbody>
      </table>
      <ul v-if="migrationLog.length" class="migrate-log">
        <li v-for="(line, i) in migrationLog" :key="i">{{ line }}</li>
      </ul>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import {
  cancelDrill,
  completeRefill,
  migrateLegacy,
  saveQuarterlySnapshot,
  scanDueEquipments,
  scheduleDrill,
  submitOrder,
  upgradeRules,
  getState,
} from '@/data/fire-service'
import { resetFireState } from '@/data/fire-store'
import { areaRefillState, overdueDays, quarterKey, toCsv } from '@/data/fire-rules'
import type {
  DrillPlan,
  FireEquipment,
  Hazard,
  LegacyRecord,
  OrderItemResult,
  QuarterlySnapshot,
  RefillOrder,
  RuleVersion,
} from '@/data/fire-types'

const tabs = [
  { key: 'equipment', label: '器材台账与批量处置' },
  { key: 'orders', label: '充装/报废单' },
  { key: 'drill', label: '演练排期与待办' },
  { key: 'hazard', label: '隐患清单' },
  { key: 'archive', label: '季度归档/老数据迁移' },
] as const

const tab = ref<(typeof tabs)[number]['key']>('equipment')

const equipments = ref<FireEquipment[]>([])
const orders = ref<RefillOrder[]>([])
const drills = ref<DrillPlan[]>([])
const hazards = ref<Hazard[]>([])
const legacy = ref<LegacyRecord[]>([])
const snapshots = ref<QuarterlySnapshot[]>([])
const ruleVersion = ref<RuleVersion>('v1')

const message = reactive<{ text: string; kind: 'ok' | 'err' }>({ text: '', kind: 'ok' })
function flash(text: string, kind: 'ok' | 'err' = 'ok') {
  message.text = text
  message.kind = kind
}

const statusList = ['在岗', '待充装', '充装中', '已报废']
const areas = computed(() => [...new Set(equipments.value.map((e) => e.area))].sort())

function reload() {
  const s = getState()
  equipments.value = s.equipments
  orders.value = s.orders
  drills.value = s.drills
  hazards.value = s.hazards
  legacy.value = s.legacy
  snapshots.value = s.snapshots
  ruleVersion.value = s.ruleVersion
}
reload()

function overdueOf(e: FireEquipment): number {
  return e.kind === '灭火器' && e.dueDate ? overdueDays(e.dueDate) : 0
}

// ---------- 器材筛选 / 多选 ----------
const equipFilter = reactive({ area: '', status: '', kw: '' })
const filteredEquips = computed(() =>
  equipments.value.filter((e) => {
    if (equipFilter.area && e.area !== equipFilter.area) return false
    if (equipFilter.status && e.status !== equipFilter.status) return false
    if (equipFilter.kw) {
      const kw = equipFilter.kw.trim()
      const hay = `${e.code} ${e.name} ${e.batchNo}`
      if (!hay.includes(kw)) return false
    }
    return true
  }),
)
function resetEquipFilter() {
  equipFilter.area = ''
  equipFilter.status = ''
  equipFilter.kw = ''
}
const selected = ref<Set<string>>(new Set())
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function selectAll() {
  selected.value = new Set(filteredEquips.value.map((e) => e.id))
}
// 批量单据只允许单区域：取勾选器材的区域集合
const selectedEquips = computed(() => equipments.value.filter((e) => selected.value.has(e.id)))
const batchArea = computed(() => {
  const set = new Set(selectedEquips.value.map((e) => e.area))
  return set.size === 1 ? [...set][0] : set.size === 0 ? '' : '__mixed__'
})
const batchAreaLabel = computed(() => (batchArea.value === '__mixed__' ? '勾选跨区，无法提交' : batchArea.value || ''))

const orderForm = reactive({
  orderNo: `RF-${quarterKey()}-${String(Math.floor(Math.random() * 900) + 100)}`,
  kind: '充装' as '充装' | '报废',
  team: '',
  expectedBackDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
})
const lastResults = ref<OrderItemResult[]>([])

function doSubmitOrder() {
  if (batchArea.value === '__mixed__') {
    flash('勾选跨了多个区域：充装单按区域管理，请按区域分别勾选提交', 'err')
    return
  }
  if (!batchArea.value) {
    flash('没有可提交的器材', 'err')
    return
  }
  try {
    const out = submitOrder({
      orderNo: orderForm.orderNo,
      kind: orderForm.kind,
      area: batchArea.value,
      team: orderForm.team || selectedEquips.value[0]?.team || '未填班组',
      equipIds: [...selected.value],
      expectedBackDate: orderForm.expectedBackDate,
    })
    reload()
    if (out.rejectedWhole) {
      flash(out.message, 'err')
      lastResults.value = []
    } else {
      flash(out.message, 'ok')
      lastResults.value = out.itemResults ?? []
      selected.value = new Set()
    }
  } catch (error) {
    // 事务内查重抛出：整笔未写入
    flash(error instanceof Error ? error.message : '提交失败，整笔未写入', 'err')
    reload()
  }
}

function doComplete(orderNo: string) {
  const next = new Date()
  next.setFullYear(next.getFullYear() + 1)
  const due = next.toISOString().slice(0, 10)
  const r = completeRefill(orderNo, due)
  reload()
  flash(r.ok ? `${r.message}，逐台结果已更新；隐患同步回写闭环` : r.message, r.ok ? 'ok' : 'err')
}

function runScan() {
  const r = scanDueEquipments()
  reload()
  if (!r.details.length) flash('巡检完成：没有逾期在岗的灭火器')
  else flash(`巡检完成：${r.changed} 台转待充装，隐患已同步登记/更新`)
}

// ---------- 演练 ----------
const drillForm = reactive({
  area: '主厂房',
  team: '',
  drillName: '',
  startAt: '',
  endAt: '',
})

const activeBackDates = computed(() =>
  orders.value
    .filter((o) => o.kind === '充装' && o.status === '已受理')
    .map((o) => ({ area: o.area, expectedBackDate: o.expectedBackDate })),
)

const areaConstraintRows = computed(() =>
  areas.value.map((area) => {
    const c = areaRefillState(area, equipments.value, activeBackDates.value)
    return {
      area,
      blocked: c.blocked,
      latestBackDate: c.latestBackDate,
      earliestDrillDate: c.earliestDrillDate,
      pendingCodes: c.pendingEquipments.map((e) => e.code),
      transitCodes: c.inTransitEquipments.map((e) => e.code),
    }
  }),
)

function todoOf(area: string): { blocked: boolean; earliestDrillDate: string | null; text: string } {
  const c = areaRefillState(area, equipments.value, activeBackDates.value)
  if (c.blocked) {
    return { blocked: true, earliestDrillDate: null, text: `先送修：${c.pendingEquipments.map((e) => e.code).join('、')} 待充装，演练前必须送走` }
  }
  if (c.earliestDrillDate) {
    return { blocked: false, earliestDrillDate: c.earliestDrillDate, text: `器材充装中，确认 ${c.latestBackDate} 前回库后方可实施` }
  }
  return { blocked: false, earliestDrillDate: null, text: '器材就绪，可按期实施' }
}

function doSchedule() {
  if (!drillForm.startAt || !drillForm.endAt) {
    flash('请填写演练起止时间', 'err')
    return
  }
  const r = scheduleDrill({
    area: drillForm.area,
    team: drillForm.team || '未指定班组',
    drillName: drillForm.drillName,
    startAt: drillForm.startAt,
    endAt: drillForm.endAt,
  })
  flash(r.message, r.ok ? 'ok' : 'err')
  if (r.ok) {
    drillForm.drillName = ''
    reload()
  }
}
function doCancel(id: string) {
  const r = cancelDrill(id)
  reload()
  flash(r.message, r.ok ? 'ok' : 'err')
}

// ---------- 换版 ----------
function doUpgrade() {
  const next: RuleVersion = ruleVersion.value === 'v1' ? 'v2' : 'v1'
  const r = upgradeRules(next)
  reload()
  flash(r.message, r.ok ? 'ok' : 'err')
}

// ---------- 迁移 ----------
const migrationLog = ref<string[]>([])
function doMigrate() {
  const r = migrateLegacy()
  reload()
  migrationLog.value = r.details
  flash(
    r.details.length
      ? `迁移完成：新补入 ${r.migratedNew} 台，冲突按台账处理 ${r.conflictResolved} 处，出厂日期补齐 ${r.dateFilled} 台`
      : '没有待迁移的老数据（迁移幂等）',
  )
}

// ---------- 季度归档 ----------
const snapshotForm = reactive({ quarter: quarterKey(), area: '主厂房', note: '' })
function doSnapshot() {
  const r = saveQuarterlySnapshot(snapshotForm.area, snapshotForm.quarter, snapshotForm.note || undefined)
  reload()
  flash(r.message, r.ok ? 'ok' : 'err')
}

// ---------- 导出（条数与页面一致） ----------
function downloadCsv(filename: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function exportEquipment() {
  const rows = filteredEquips.value
  const csv = toCsv(
    ['编号', '名称', '类别', '区域', '批次', '出厂日期', '出厂日期是否补齐', '有效期至', '位置', '班组', '状态'],
    rows.map((e) => [
      e.code, e.name, e.kind, e.area, e.batchNo, e.manufactureDate,
      e.manufactureDateFilled ? '批次最早值补齐' : '', e.dueDate, e.location, e.team, e.status,
    ]),
  )
  downloadCsv(`消防器材台账-${equipFilter.area || '全部区域'}-${rows.length}条.csv`, csv)
  flash(`已导出 ${rows.length} 条，与页面当前条数一致`)
}

function exportOrders() {
  // 一张单一行，逐台结果并入一个单元格，保证导出行数与页面单据条数一致
  const csv = toCsv(
    ['单号', '类型', '区域', '班组', '提交时间', '预计回库', '状态', '逐台结果（编号：结果/原因）'],
    orders.value.map((o) => [
      o.orderNo, o.kind, o.area, o.team, o.createdAt, o.expectedBackDate, o.status,
      o.itemResults.map((r) => `${r.code}：${r.result}/${r.reason}`).join('；'),
    ]),
  )
  downloadCsv(`充装报废单-${orders.value.length}单.csv`, csv)
  flash(`已导出 ${orders.value.length} 张单据，与页面条数一致`)
}

function exportHazards() {
  // 一条隐患一行，全部历史结论并入一个单元格，保证导出行数与页面条数相同
  const csv = toCsv(
    ['隐患编号', '来源', '区域', '关联器材', '描述', '当前等级', '状态', '处理结论流水（含当时版本与等级）'],
    hazards.value.map((h) => [
      h.id, h.source, h.area, h.equipId ?? '', h.description, h.level, h.status,
      h.conclusions
        .map((c) => `[${c.ruleVersion}·${c.level}·${c.status}] ${c.at.replace('T', ' ')} ${c.text}`)
        .join('；'),
    ]),
  )
  downloadCsv(`现场巡视隐患清单-${hazards.value.length}条.csv`, csv)
  flash(`已导出隐患 ${hazards.value.length} 条（每条含全部历史结论），与页面条数一致`)
}

function exportSnapshot(id: string, part: 'equipment' | 'drill') {
  const s = snapshots.value.find((x) => x.id === id)
  if (!s) return
  if (part === 'equipment') {
    const csv = toCsv(
      ['编号', '名称', '类别', '区域', '批次', '出厂日期', '有效期至', '状态'],
      s.equipments.map((e) => [e.code, e.name, e.kind, e.area, e.batchNo, e.manufactureDate, e.dueDate, e.status]),
    )
    downloadCsv(`${s.quarterKey}-${s.area}-灭火器等台账-${s.equipments.length}条.csv`, csv)
  } else {
    const csv = toCsv(
      ['编号', '区域', '名称', '班组', '开始', '结束', '状态', '排期依据'],
      s.drills.map((d) => [d.id, d.area, d.drillName, d.team, d.startAt, d.endAt, d.status, d.basedOnRefillDate ?? '']),
    )
    downloadCsv(`${s.quarterKey}-${s.area}-演练清单-${s.drills.length}条.csv`, csv)
  }
  flash(`归档导出 ${part === 'equipment' ? s.equipments.length : s.drills.length} 条，与另存时条数一致`)
}

function resetAll() {
  resetFireState()
  selected.value = new Set()
  lastResults.value = []
  migrationLog.value = []
  reload()
  flash('已恢复为演示数据')
}
</script>

<style scoped>
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.tab { border: none; background: none; padding: 8px 14px; cursor: pointer; font-size: 13px; color: var(--muted); border-bottom: 2px solid transparent; }
.tab.active { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }
.banner { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 0 0 12px; }
.banner.ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.banner.err { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.grow { flex: 1; }
.picked { background: #f0f7ff; }
.tag { font-size: 11px; color: #b54708; background: #fffaeb; border: 1px solid #fedf89; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.overdue { color: #b42318; font-weight: 600; }
.ok-text { color: #027a48; }
.status[data-status='待充装'] { color: #b54708; font-weight: 600; }
.status[data-status='充装中'] { color: #175cd3; }
.status[data-status='已报废'] { color: #b42318; }
.batch-box { margin-top: 16px; border: 1px dashed #94a3b8; border-radius: 8px; padding: 12px; background: #fbfdff; }
.mini { display: inline-block; font-size: 11px; margin: 1px 4px 1px 0; padding: 0 6px; border-radius: 999px; }
.mini.ok { background: #ecfdf3; color: #027a48; }
.mini.fail { background: #fef3f2; color: #b42318; }
.mini.warn-tag { background: #fffaeb; color: #b54708; }
.lvl { padding: 1px 8px; border-radius: 4px; font-size: 12px; }
.lvl[data-lvl='一般'] { background: #eef2f7; color: #475467; }
.lvl[data-lvl='较大'] { background: #fffaeb; color: #b54708; }
.lvl[data-lvl='重大'] { background: #fef3f2; color: #b42318; }
.conclusions { margin: 0; padding-left: 18px; font-size: 12px; }
.conclusions li { margin-bottom: 2px; }
.migrate-log { margin-top: 8px; font-size: 12px; color: #475467; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 8px 24px; }
</style>
