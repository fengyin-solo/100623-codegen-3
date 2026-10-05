<template>
  <div class="fire-panel">
    <!-- 规则版本 -->
    <section class="form-card">
      <h3>规则口径与换版重算</h3>
      <div class="version-row">
        <button
          v-for="v in ['v1', 'v2']"
          :key="v"
          class="btn"
          :class="{ primary: store.state.ruleVersion === v }"
          type="button"
          @click="changeVersion(v as 'v1' | 'v2')"
        >
          {{ v }} {{ store.state.ruleVersion === v ? '（当前）' : '' }}
        </button>
      </div>
      <ul class="rule-list">
        <li><b>v1 旧版</b>：{{ labels.v1 }}</li>
        <li><b>v2 新版</b>：{{ labels.v2 }}</li>
      </ul>
      <p class="muted">换版后按新版重算全部已有器材的到期与等级；旧处理结论保留当时等级并注明版本（隐患表“形成时等级”列不改，只在旁边给出新版建议）。</p>
      <p v-if="message" class="result-banner" :class="ok ? 'ok' : 'err'">{{ message }}</p>
    </section>

    <!-- 并发 / 重复提交演练 -->
    <section class="form-card">
      <h3>并发与重复提交演练（同一刻点两笔提交）</h3>
      <div class="bulk-actions">
        <button class="btn primary" type="button" @click="demoSameKey">模拟：同一张充装单两笔并发提交</button>
        <button class="btn primary" type="button" @click="demoOverlap">模拟：两张不同单据勾选同一台并发提交</button>
      </div>
      <ul class="demo-log">
        <li v-for="(line, i) in demoLines" :key="i" :class="line.kind">{{ line.text }}</li>
      </ul>
      <p class="muted">
        说明：第一笔先落库并占用；同单号的第二笔按幂等整套退回；不同单号但动到同一台的第二笔在落库前比对版本（CAS）发现已被先改，整笔拒绝写入。台账与业务清单在同一事务里，失败一笔都不会半写。
      </p>
    </section>

    <!-- 迁移报告 -->
    <section v-if="report">
      <h3>老数据一次性迁移报告（{{ report.at }}）</h3>
      <div class="stat-row">
        <article class="stat-card"><span class="stat-label">迁移器材</span><strong>{{ report.total }}</strong></article>
        <article class="stat-card"><span class="stat-label">沿用原编号</span><strong>{{ report.keptCodes.length }}</strong></article>
        <article class="stat-card"><span class="stat-label">补齐缺项</span><strong>{{ report.backfilled.length }}</strong></article>
        <article class="stat-card"><span class="stat-label">取值冲突仲裁</span><strong>{{ report.conflicts.length }}</strong></article>
        <article class="stat-card"><span class="stat-label">结转老充装单</span><strong>{{ report.carriedOrders.length }}</strong></article>
      </div>

      <h4>缺项补齐（出厂日期按采购批次口径）</h4>
      <table class="data-table compact">
        <thead><tr><th>器材</th><th>字段</th><th>补入值</th><th>口径</th></tr></thead>
        <tbody>
          <tr v-for="(b, i) in report.backfilled" :key="i"><td>{{ b.equipId }}</td><td>{{ b.field }}</td><td>{{ b.value }}</td><td>{{ b.rule }}</td></tr>
        </tbody>
      </table>

      <h4>两边取值冲突的仲裁结果与依据</h4>
      <table class="data-table compact">
        <thead><tr><th>器材</th><th>字段</th><th>资产台账</th><th>班组自报</th><th>采信</th><th>采信来源</th><th>依据</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in report.conflicts" :key="i">
            <td>{{ c.equipId }}</td><td>{{ fieldLabel(c.field) }}</td><td>{{ c.ledgerValue }}</td><td>{{ c.crewValue }}</td>
            <td><b>{{ c.resolvedValue }}</b></td><td><span class="tag tag-warn">{{ c.winner }}</span></td><td class="muted">{{ c.basis }}</td>
          </tr>
        </tbody>
      </table>

      <h4>口语状态归一化</h4>
      <table class="data-table compact">
        <thead><tr><th>器材</th><th>班组原话</th><th>归一化业务状态</th></tr></thead>
        <tbody>
          <tr v-for="(n, i) in report.normalized" :key="i"><td>{{ n.equipId }}</td><td>“{{ n.raw }}”</td><td>{{ n.normalized }}</td></tr>
        </tbody>
      </table>
      <p class="muted">
        仲裁口径：资产属性（型号/出厂日期/批次/采购日）以资产台账为准；现场状态（压力/铅封/在位/锈蚀）以最新现场巡视为准；业务状态（待充装）以先落库单据为准；编号一律沿用老编号不重发。
      </p>
    </section>

    <!-- 提交日志 -->
    <section>
      <h3>落库日志（台账与业务清单同事务修订号）</h3>
      <table class="data-table compact">
        <thead><tr><th>时间</th><th>修订号</th><th>类型</th><th>操作人</th><th>摘要</th><th>变更范围</th></tr></thead>
        <tbody>
          <tr v-for="(log, i) in store.logList.value" :key="i">
            <td>{{ log.at }}</td><td>{{ log.revision }}</td><td>{{ log.type }}</td><td>{{ log.operator }}</td><td>{{ log.summary }}</td><td class="cell-sub">{{ log.scopes.join('、') }}</td>
          </tr>
          <tr v-if="!store.logList.value.length"><td colspan="6" class="empty-state">尚无落库记录</td></tr>
        </tbody>
      </table>
    </section>

    <section class="form-card">
      <h3>演示数据</h3>
      <button class="btn danger" type="button" @click="resetAll">重置为迁移后的初始数据</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { RULE_LABEL } from '../rules'
import { useFireStore } from '../store'

const store = useFireStore()
const labels = RULE_LABEL
const report = ref(store.state.migrationReport)
const message = ref('')
const ok = ref(true)
const demoLines = ref<{ text: string; kind: string }[]>([])

async function changeVersion(v: 'v1' | 'v2') {
  const r = await store.switchVersion(v, '值班管理员')
  ok.value = r.ok
  message.value = r.message
  report.value = store.state.migrationReport
}

function fieldLabel(f: string): string {
  return { model: '规格型号', manufactureDate: '出厂日期', pressure: '压力', seal: '铅封', location: '在位', corrosion: '锈蚀', status: '业务状态', type: '类型', batchId: '采购批次', purchaseDate: '采购日期' }[f] ?? f
}

async function demoSameKey() {
  demoLines.value = []
  const ids = ['XF-1009', 'XF-1011']
  const revs: Record<string, number> = {}
  store.equipmentList.value.filter((e) => ids.includes(e.id)).forEach((e) => (revs[e.id] = e.rev))
  const key = 'DEMO-DUP-CZ'
  demoLines.value.push({ text: '两笔请求在同一刻发出，单号同为 DEMO-DUP-CZ……', kind: 'info' })
  const [a, b] = await Promise.all([
    store.evaluateBatch({ kind: '充装', ids, operator: '运行一班', key, baseRevs: { ...revs } }),
    store.evaluateBatch({ kind: '充装', ids, operator: '运行二班', key, baseRevs: { ...revs } }),
  ])
  demoLines.value.push({ text: a.accepted ? `① 第一笔已落库：单据 ${a.order?.id}，修订号 ${a.revision}` : `① 第一笔被拒：${a.reason}`, kind: a.accepted ? 'ok' : 'err' })
  demoLines.value.push({ text: b.accepted ? `② 第二笔竟然写入：${b.order?.id}` : `② 第二笔整套退回（重复）：${b.reason}`, kind: b.accepted ? 'err' : 'ok' })
}

async function demoOverlap() {
  demoLines.value = []
  const id = 'XF-1007'
  const rev = store.equipmentList.value.find((e) => e.id === id)?.rev ?? 1
  demoLines.value.push({ text: `两笔不同单据在同一刻发出，都勾选 ${id}……`, kind: 'info' })
  const [a, b] = await Promise.all([
    store.evaluateBatch({ kind: '充装', ids: [id], operator: '运行一班', key: 'DEMO-A', baseRevs: { [id]: rev } }),
    store.evaluateBatch({ kind: '报废', ids: [id], operator: '后勤班', key: 'DEMO-B', baseRevs: { [id]: rev } }),
  ])
  demoLines.value.push({ text: a.accepted ? `① A（充装）先落库：单据 ${a.order?.id}` : `① A 被拒：${a.reason}`, kind: a.accepted ? 'ok' : 'err' })
  demoLines.value.push({ text: b.accepted ? `② B（报废）竟然写入：${b.order?.id}` : `② B 整笔拒绝写入（并发冲突，CAS）：${b.reason}`, kind: b.accepted ? 'err' : 'ok' })
}

function resetAll() {
  store.resetDemo()
  report.value = store.state.migrationReport
  ok.value = true
  message.value = '已重置为迁移完成后的初始数据（v1 口径）'
  demoLines.value = []
}
</script>
