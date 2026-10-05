<template>
  <div class="fire-panel">
    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">隐患总数（页面条数）</span><strong>{{ store.hazardsList.value.length }}</strong></article>
      <article class="stat-card"><span class="stat-label">未整改</span><strong style="color:#b42318">{{ count('未整改') }}</strong></article>
      <article class="stat-card"><span class="stat-label">整改中</span><strong style="color:#b54708">{{ count('整改中') }}</strong></article>
      <article class="stat-card"><span class="stat-label">已闭环</span><strong style="color:#067647">{{ count('已闭环') }}</strong></article>
      <article class="stat-card" style="display:flex;align-items:center">
        <button class="btn" type="button" @click="exportHazards">导出隐患清单 CSV</button>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="() => {}">
      <label class="filter-item"><span>区域</span>
        <select v-model="area"><option value="">全部</option><option v-for="a in store.state.areas" :key="a" :value="a">{{ a }}</option></select>
      </label>
      <label class="filter-item"><span>状态</span>
        <select v-model="statusFilter"><option value="">全部</option><option>未整改</option><option>整改中</option><option>已闭环</option></select>
      </label>
      <label class="filter-item"><span>来源</span>
        <select v-model="sourceFilter">
          <option value="">全部</option><option>现场巡视</option><option>充装处理回写</option><option>报废处理回写</option><option>迁移结论回写</option>
        </select>
      </label>
    </form>

    <table class="data-table">
      <thead>
        <tr><th>隐患编号</th><th>来源单据</th><th>器材/区域</th><th>描述</th><th>形成时等级（含版本）</th><th>换版重算建议</th><th>状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="h in rows" :key="h.id" :class="{ 'row-closed': h.status === '已闭环' }">
          <td>{{ h.id }}</td>
          <td>{{ h.source }}<div v-if="h.refOrder" class="cell-sub">{{ h.refOrder }}</div></td>
          <td>{{ h.equipId }}<div class="cell-sub">{{ h.area }}</div></td>
          <td>{{ h.description }}</td>
          <td><b :class="gradeClass(h.grade)">{{ h.grade }}</b><div class="cell-sub">形成于 {{ h.concludedAt }} · {{ h.ruleVersion }}</div></td>
          <td>
            <span v-if="suggestion(h.id)" class="cell-sub warn">{{ suggestion(h.id) }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td>{{ h.status }}<div v-if="h.closedAt" class="cell-sub">{{ h.closedAt }}</div></td>
          <td>
            <button v-if="h.status !== '已闭环'" class="link" type="button" @click="close(h.id)">现场巡视确认闭环</button>
            <span v-else class="muted">已闭环</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="lastMsg" class="result-banner" :class="ok ? 'ok' : 'err'">{{ lastMsg }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { useFireStore } from '../store'

const store = useFireStore()
const area = ref('')
const statusFilter = ref('')
const sourceFilter = ref('')
const lastMsg = ref('')
const ok = ref(true)

const rows = computed(() =>
  store.hazardsList.value.filter((h) =>
    (!area.value || h.area === area.value) &&
    (!statusFilter.value || h.status === statusFilter.value) &&
    (!sourceFilter.value || h.source === sourceFilter.value),
  ),
)
const count = (s: string) => store.hazardsList.value.filter((h) => h.status === s).length

/** 换版后旧结论保留当时等级：建议只显示在旁边，不改原等级 */
function suggestion(id: string): string {
  const h = store.hazardsList.value.find((x) => x.id === id)
  if (!h || !h.note) {
    return ''
  }
  return h.note
}

async function close(id: string) {
  const r = await store.closeHazard(id, '值班管理员')
  ok.value = r.ok
  lastMsg.value = r.message
}

function exportHazards() {
  const data = rows.value.map((h) => [h.id, h.source, h.refOrder ?? '', h.equipId, h.area, h.description, h.grade, h.ruleVersion, h.status, h.note ?? ''])
  const n = store.downloadCsv('现场巡视隐患清单.csv', ['隐患编号', '来源', '关联单据', '器材', '区域', '描述', '形成时等级', '版本', '状态', '换版重算建议'], data)
  ok.value = true
  lastMsg.value = `导出 ${n} 条，与页面当前条数（${rows.value.length}）相同`
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
