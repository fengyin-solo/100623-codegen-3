<template>
  <div class="fire-panel">
    <div class="form-card inline">
      <h3>每季度按区域整组另存演练与器材清单</h3>
      <div class="filter-bar" style="margin:0">
        <label class="filter-item"><span>季度基准日期（决定年/季度）</span>
          <input v-model="date" type="date" />
        </label>
        <label class="filter-item"><span>区域</span>
          <select v-model="area">
            <option v-for="a in store.state.areas" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="doArchive">整组另存（演练 + 灭火器台账）</button>
      </div>
      <p class="muted">另存为只读快照：同季度同区域只存一份；快照里的灭火器台账条数与当时页面条数对得上。</p>
      <p v-if="message" class="result-banner" :class="ok ? 'ok' : 'err'">{{ message }}</p>
    </div>

    <section>
      <h3>已另存的季度清单</h3>
      <table class="data-table">
        <thead>
          <tr><th>归档号</th><th>季度</th><th>区域</th><th>另存时间/版本</th><th>灭火器台账条数（页面=另存）</th><th>演练条数（页面=另存）</th><th>指纹</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in store.archivesList.value" :key="a.id">
            <td>{{ a.id }}</td>
            <td>{{ a.year }}年第{{ a.quarter }}季度</td>
            <td>{{ a.area }}</td>
            <td>{{ a.createdAt }}<div class="cell-sub">{{ a.ruleVersion }}</div></td>
            <td>
              <b :class="a.equipmentCount.match ? 'ok-text' : 'err-text'">{{ a.equipmentCount.pageCount }} = {{ a.equipmentCount.archivedCount }}</b>
              {{ a.equipmentCount.match ? '✓ 对得上' : '✗ 不一致' }}
            </td>
            <td>
              <b :class="a.drillCount.match ? 'ok-text' : 'err-text'">{{ a.drillCount.pageCount }} = {{ a.drillCount.archivedCount }}</b>
              {{ a.drillCount.match ? '✓ 对得上' : '✗ 不一致' }}
            </td>
            <td class="cell-sub">{{ a.fingerprint }}</td>
            <td><button class="link" type="button" @click="viewId = viewId === a.id ? '' : a.id">{{ viewId === a.id ? '收起快照' : '查看快照' }}</button></td>
          </tr>
          <tr v-if="!store.archivesList.value.length"><td colspan="8" class="empty-state">还没有季度另存</td></tr>
        </tbody>
      </table>

      <div v-for="a in store.archivesList.value.filter((x) => x.id === viewId)" :key="'view-' + a.id" class="snapshot-box">
        <h4>{{ a.year }}Q{{ a.quarter }} {{ a.area }} 灭火器台账快照（{{ a.equipmentSnapshot.length }} 条）</h4>
        <table class="data-table compact">
          <thead><tr><th>编号</th><th>类型</th><th>状态</th><th>出厂日期</th><th>快照结论@{{ a.ruleVersion }}</th></tr></thead>
          <tbody>
            <tr v-for="e in a.equipmentSnapshot" :key="e.id">
              <td>{{ e.id }}</td><td>{{ e.type }}</td><td>{{ e.status }}</td><td>{{ e.manufactureDate }}</td>
              <td :class="gradeClass(e.conclusion.grade)">{{ e.conclusion.grade }}（{{ e.conclusion.reasons.join('；') }}）</td>
            </tr>
          </tbody>
        </table>
        <h4>演练快照（{{ a.drillSnapshot.length }} 条）</h4>
        <table class="data-table compact">
          <thead><tr><th>计划号</th><th>班组</th><th>日期</th><th>时段</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="d in a.drillSnapshot" :key="d.id"><td>{{ d.id }}</td><td>{{ d.crew }}</td><td>{{ d.date }}</td><td>{{ d.slot }}</td><td>{{ d.status }}</td></tr>
          </tbody>
        </table>
        <p><button class="btn" type="button" @click="exportArchive(a)">导出该季度灭火器台账 CSV</button></p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { useFireStore } from '../store'
import type { QuarterlyArchive } from '../types'

const store = useFireStore()
const date = ref('2026-10-05')
const area = ref('主厂房')
const viewId = ref('')
const message = ref('')
const ok = ref(true)

async function doArchive() {
  const r = await store.archiveQuarter(area.value, '值班管理员', date.value)
  ok.value = r.ok
  message.value = r.message
}

function exportArchive(a: QuarterlyArchive) {
  const data = a.equipmentSnapshot.map((e) => [e.id, e.type, e.model, e.crew, e.manufactureDate, e.manufactureSource, e.status, e.conclusion.grade, e.conclusion.refillDue, e.conclusion.scrapDue])
  const n = store.downloadCsv(`${a.year}Q${a.quarter}-${a.area}-灭火器台账.csv`, ['器材编号', '类型', '规格', '班组', '出厂日期', '补齐口径', '状态', `结论@${a.ruleVersion}`, '充装到期', '报废到期'], data)
  ok.value = true
  message.value = `导出快照 ${n} 条，与另存条数（${a.equipmentSnapshot.length}）相同`
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
