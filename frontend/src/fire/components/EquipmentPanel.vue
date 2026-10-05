<template>
  <div class="fire-panel">
    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">灭火器台账（页面条数）</span>
        <strong class="stat-value">{{ store.equipmentList.value.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在值</span>
        <strong class="stat-value" style="color:#067647">{{ countByStatus('在值') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待充装（已送未回）</span>
        <strong class="stat-value" style="color:#b54708">{{ countByStatus('待充装') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已报废离位</span>
        <strong class="stat-value" style="color:#64748b">{{ countByStatus('已报废') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前结论重大隐患</span>
        <strong class="stat-value" style="color:#b42318">{{ countMajor }}</strong>
      </article>
    </div>

    <!-- 区域可演练状态：与演练页同一份 areaReadiness 算出，指纹一致 -->
    <div class="ready-row">
      <div v-for="r in store.allReadiness.value" :key="r.area" class="ready-card" :class="{ blocked: !r.ready }">
        <div class="ready-head">
          <strong>{{ r.area }}</strong>
          <span class="tag" :class="r.ready ? 'tag-ok' : 'tag-block'">{{ r.ready ? '可排演练' : '待充装阻塞' }}</span>
        </div>
        <div class="ready-meta">台账 {{ r.total }} 台 · 在值 {{ r.onDuty }} 台 · 待充装 {{ r.pendingRefill.length }} 台</div>
        <div class="ready-meta">最高隐患等级：<b :class="gradeClass(r.worstGrade)">{{ r.worstGrade }}</b></div>
        <div v-if="r.pendingRefill.length" class="ready-blockers">
          阻塞器材：{{ r.pendingRefill.map((e) => e.id).join('、') }}（回厂后自动解除）
        </div>
        <div class="ready-fp">同源指纹 {{ r.fingerprint }}（器材页/演练页一致）</div>
      </div>
    </div>

    <form class="filter-bar" @submit.prevent="() => {}">
      <label class="filter-item">
        <span>区域（可多选筛选）</span>
        <span class="check-group">
          <label v-for="a in store.state.areas" :key="a" class="check-pill">
            <input type="checkbox" :checked="areaFilter.includes(a)" @change="toggleArea(a)" />{{ a }}
          </label>
        </span>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option value="在值">在值</option>
          <option value="待充装">待充装</option>
          <option value="已报废">已报废</option>
        </select>
      </label>
      <label class="filter-item">
        <span>关键字（编号/班组/批次）</span>
        <input v-model="keyword" placeholder="按编号、班组、批次检索" />
      </label>
      <label class="filter-item">
        <span>数据来源</span>
        <select v-model="sourceFilter">
          <option value="">全部</option>
          <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置</button>
    </form>

    <div class="bulk-bar">
      <div class="bulk-info">
        已勾选 <b>{{ selectedCount }}</b> 台（支持跨区域多选）
        <button class="link" type="button" @click="selectAllVisible">全选当前结果</button>
        <button class="link" type="button" @click="selected = {}">清空选择</button>
      </div>
      <div class="bulk-actions">
        <button class="btn primary" type="button" :disabled="!selected.size" @click="openSubmit('充装')">批量送充装</button>
        <button class="btn danger" type="button" :disabled="!selected.size" @click="openSubmit('报废')">批量报废</button>
        <button class="btn" type="button" @click="exportEquipment">导出台账 CSV（条数对齐）</button>
        <button class="btn ghost" type="button" @click="runFailingTx">演练：故意失败的整笔事务</button>
      </div>
    </div>

    <p v-if="lastMessage" class="result-banner" :class="lastOk ? 'ok' : 'err'">{{ lastMessage }}</p>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:34px"></th>
            <th>器材编号</th>
            <th>类型</th>
            <th>规格</th>
            <th>区域</th>
            <th>责任班组</th>
            <th>采购批次</th>
            <th>出厂日期（补齐口径）</th>
            <th>充装到期</th>
            <th>报废到期</th>
            <th>现场检查</th>
            <th>业务状态</th>
            <th>当前结论@版本</th>
            <th>数据来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.id" :class="{ 'row-scrap': row.status === '已报废' }">
            <td><input type="checkbox" :checked="!!selected[row.id]" @change="toggle(row.id)" :disabled="row.status === '已报废'" /></td>
            <td>{{ row.id }}</td>
            <td>{{ row.type }}</td>
            <td>{{ row.model }}</td>
            <td>{{ row.area }}</td>
            <td>{{ row.crew }}</td>
            <td>{{ row.batchId }}</td>
            <td>
              {{ row.manufactureDate }}
              <div v-if="row.manufactureSource !== '原始'" class="cell-sub warn">{{ row.manufactureSource }}</div>
            </td>
            <td :class="{ due: row.conclusion.needsRefill && row.status !== '待充装' }">
              {{ row.conclusion.refillDue }}
              <div v-if="row.lastRefillDate" class="cell-sub">上次回厂 {{ row.lastRefillDate }}</div>
            </td>
            <td :class="{ due: row.conclusion.needsScrap }">{{ row.conclusion.scrapDue }}</td>
            <td>
              压力{{ row.pressure }} · 铅封{{ row.seal }} · {{ row.location === '在位' ? '在位' : row.location }}
              <span v-if="row.corrosion" class="cell-sub warn">有锈蚀</span>
            </td>
            <td><span class="tag" :class="statusClass(row.status)">{{ row.status }}</span></td>
            <td>
              <b :class="gradeClass(row.conclusion.grade)">{{ row.conclusion.grade }}</b>
              <div class="cell-sub">{{ row.conclusion.reasons.join('；') }}</div>
            </td>
            <td>
              {{ row.dataSource }}
              <div v-if="row.conflictNote" class="cell-sub warn" :title="row.conflictNote">冲突/缺项已仲裁</div>
            </td>
          </tr>
          <tr v-if="!visibleRows.length">
            <td colspan="14" class="empty-state">没有符合条件的器材</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 提交确认弹层：一次提交、逐台结果 -->
    <div v-if="pendingKind" class="modal-mask" @click.self="pendingKind = ''">
      <div class="modal">
        <h3>批量{{ pendingKind }}提交确认</h3>
        <p class="muted">
          共勾选 {{ selectedCount }} 台，提交后生成同一张{{ pendingKind }}单；同一张单重复提交只有先落库的一版算数。
        </p>
        <ul class="mini-list">
          <li v-for="row in selectedRows" :key="row.id">
            {{ row.id }} · {{ row.area }} · {{ row.type }} · 当前 {{ row.status }}
            <span v-if="pendingKind === '充装' && row.status !== '在值'" class="cell-sub warn">
              ——预计无法送出（{{ row.status === '已报废' ? '已报废，应走报废' : '待充装途中' }}）
            </span>
          </li>
        </ul>
        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmSubmit">
            {{ submitting ? '提交中…' : `确认提交${pendingKind}单` }}
          </button>
          <button class="btn ghost" type="button" @click="pendingKind = ''">取消</button>
        </div>
      </div>
    </div>

    <!-- 逐台结果 -->
    <section v-if="lastResult" class="result-box">
      <header class="result-head">
        <h3>单据 {{ lastResult.order?.id }} 逐台结果</h3>
        <span class="muted">提交时间 {{ lastResult.at }} · 修订号 {{ lastResult.revision }}</span>
      </header>
      <div class="result-summary">
        <span class="tag tag-ok">送出/处理成功 {{ lastResult.okItems.length }} 台</span>
        <span class="tag tag-block">没送成/未处理 {{ lastResult.failedItems.length }} 台（单独列出，写明原因）</span>
      </div>
      <table v-if="lastResult.okItems.length" class="data-table compact">
        <thead><tr><th>器材</th><th>结果</th><th>变更</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="r in lastResult.okItems" :key="r.id">
            <td>{{ r.id }}</td><td class="ok-text">成功</td><td>{{ r.before }} → {{ r.after }}</td><td>{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
      <table v-if="lastResult.failedItems.length" class="data-table compact">
        <thead><tr><th>器材</th><th>结果</th><th>当前状态</th><th>没送成的原因</th></tr></thead>
        <tbody>
          <tr v-for="r in lastResult.failedItems" :key="r.id" class="row-fail">
            <td>{{ r.id }}</td><td class="err-text">未送出</td><td>{{ r.after }}</td><td>{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 充装/报废单据台账：重复提交留痕、回厂登记 -->
    <section class="order-book">
      <h3>充装 / 报废单据台账（同一单号只有第一笔算）</h3>
      <table class="data-table compact">
        <thead>
          <tr><th>单号</th><th>类型</th><th>区域</th><th>提交人/时间</th><th>状态</th><th>勾选台数</th><th>成功/未送出</th><th>重复提交退回记录</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in store.ordersList.value" :key="o.id">
            <td>{{ o.id }}<div class="cell-sub">幂等键 {{ o.idempotencyKey }}</div></td>
            <td>{{ o.kind }}</td>
            <td>{{ o.areas.join('、') }}</td>
            <td>{{ o.operator }}<div class="cell-sub">{{ o.submittedAt }}</div></td>
            <td><span class="tag" :class="o.status === '已回厂' ? 'tag-ok' : o.status === '已报废' ? 'tag-gray' : 'tag-warn'">{{ o.status }}</span></td>
            <td>{{ o.items.length }}</td>
            <td>{{ o.results.filter((r) => r.ok).length }} / {{ o.results.filter((r) => !r.ok).length }}</td>
            <td>
              <span v-if="!o.repeatAttempts.length" class="muted">无</span>
              <div v-for="(a, i) in o.repeatAttempts" :key="i" class="cell-sub warn">{{ a.at }} {{ a.operator }} 的后到提交被整套退回</div>
            </td>
            <td>
              <button v-if="o.kind === '充装' && o.status !== '已回厂'" class="link" type="button" @click="returnOrder(o)">登记回厂</button>
              <span v-else-if="o.kind === '充装'" class="muted">回厂于 {{ o.returnedAt }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { useFireStore } from '../store'
import type { BatchResponse, BusinessOrder } from '../types'

const store = useFireStore()

const areaFilter = ref<string[]>([])
const statusFilter = ref('')
const sourceFilter = ref('')
const keyword = ref('')
const selected = reactive<Record<string, boolean>>({})
const pendingKind = ref<'' | '充装' | '报废'>('')
const submitting = ref(false)
const lastResult = ref<BatchResponse | null>(null)
const lastMessage = ref('')
const lastOk = ref(true)

const sources = ['资产台账', '班组自报', '两源一致', '冲突仲裁', '先落库单据']

// 勾选状态用响应式对象（Vue 对普通 Set 的变更追踪不可靠）
const selectedCount = computed(() => Object.values(selected).filter(Boolean).length)

const visibleRows = computed(() =>
  store.equipmentList.value.filter((row) => {
    if (areaFilter.value.length && !areaFilter.value.includes(row.area)) {
      return false
    }
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (sourceFilter.value && row.dataSource !== sourceFilter.value) {
      return false
    }
    const kw = keyword.value.trim()
    if (kw && ![row.id, row.crew, row.batchId, row.model].some((v) => String(v).includes(kw))) {
      return false
    }
    return true
  }),
)

const selectedRows = computed(() => store.equipmentList.value.filter((r) => selected[r.id]))
const countByStatus = (s: string) => store.equipmentList.value.filter((r) => r.status === s).length
const countMajor = computed(() => store.equipmentList.value.filter((r) => r.status !== '已报废' && r.conclusion.grade === '重大隐患').length)

function toggle(id: string) {
  selected[id] = !selected[id]
}
function toggleArea(area: string) {
  const list = areaFilter.value
  areaFilter.value = list.includes(area) ? list.filter((a) => a !== area) : [...list, area]
}
function selectAllVisible() {
  visibleRows.value.filter((r) => r.status !== '已报废').forEach((r) => (selected[r.id] = true))
}
function resetFilters() {
  areaFilter.value = []
  statusFilter.value = ''
  sourceFilter.value = ''
  keyword.value = ''
}
function openSubmit(kind: '充装' | '报废') {
  lastResult.value = null
  pendingKind.value = kind
}

async function confirmSubmit() {
  if (!pendingKind.value) {
    return
  }
  submitting.value = true
  lastMessage.value = ''
  const ids = Object.keys(selected).filter((id) => selected[id])
  // baseRevs 在“勾选提交这一刻”采集：后到提交若遇到先落库版本，整笔被拒
  const baseRevs: Record<string, number> = {}
  for (const row of store.equipmentList.value) {
    if (selected[row.id]) {
      baseRevs[row.id] = row.rev
    }
  }
  const key = `${pendingKind.value}-${[...ids].sort().join('|')}`
  const result = await store.evaluateBatch({
    kind: pendingKind.value,
    ids,
    operator: '值班管理员',
    key,
    baseRevs,
  })
  submitting.value = false
  pendingKind.value = ''
  lastResult.value = result
  if (result.accepted) {
    lastOk.value = true
    const failed = result.failedItems.length
      ? `；${result.failedItems.length} 台没送成，已在下方单独列清原因`
      : '；全部成功'
    lastMessage.value = `单据 ${result.order?.id} 已先落库（修订号 ${result.revision}）${failed}`
    for (const id of ids) {
      selected[id] = false
    }
  } else {
    lastOk.value = false
    lastMessage.value = result.reason ?? '整笔被拒绝写入'
  }
}

async function returnOrder(order: BusinessOrder) {
  const pendingIds = order.items.filter((id) =>
    store.equipmentList.value.some((e) => e.id === id && e.status === '待充装'),
  )
  const result = await store.returnRefill(order.id, '值班管理员', pendingIds)
  lastOk.value = result.ok
  lastMessage.value = result.message
}

function exportEquipment() {
  const rows = visibleRows.value
  const data = rows.map((r) => [
    r.id, r.type, r.model, r.area, r.crew, r.batchId, r.manufactureDate, r.manufactureSource,
    r.conclusion.refillDue, r.conclusion.scrapDue, r.status, r.conclusion.grade, r.dataSource,
  ])
  const count = store.downloadCsv(
    `灭火器台账-${store.state.ruleVersion}.csv`,
    ['器材编号', '类型', '规格', '区域', '责任班组', '采购批次', '出厂日期', '出厂日期补齐口径', '充装到期', '报废到期', '业务状态', '隐患等级', '数据来源'],
    data,
  )
  lastOk.value = true
  lastMessage.value = `已导出 ${count} 条，与页面当前结果条数（${rows.length}）相同`
}

async function runFailingTx() {
  const result = await store.simulateFailingTx('值班管理员')
  lastOk.value = false
  lastMessage.value = result.message
}

function statusClass(s: string) {
  return s === '在值' ? 'tag-ok' : s === '待充装' ? 'tag-warn' : 'tag-gray'
}
function gradeClass(g: string) {
  return {
    'grade-normal': g === '正常',
    'grade-minor': g === '一般隐患',
    'grade-major': g === '严重隐患',
    'grade-critical': g === '重大隐患',
  }
}
</script>
