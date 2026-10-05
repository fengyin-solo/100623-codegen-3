<template>
  <div class="fire-panel">
    <!-- 区域可演练：与器材页同一份函数、同一份指纹 -->
    <div class="ready-row">
      <div v-for="r in store.allReadiness.value" :key="r.area" class="ready-card" :class="{ blocked: !r.ready }">
        <div class="ready-head">
          <strong>{{ r.area }}</strong>
          <span class="tag" :class="r.ready ? 'tag-ok' : 'tag-block'">{{ r.ready ? '可排演练' : '只能排到充装完成之后' }}</span>
        </div>
        <div class="ready-meta">在值 {{ r.onDuty }}/{{ r.total }} 台 · 待充装 {{ r.pendingRefill.length }} 台</div>
        <div v-if="r.pendingRefill.length" class="ready-blockers">
          待充装：{{ r.pendingRefill.map((e) => `${e.id}(${e.crew})`).join('、') }}
        </div>
        <div class="ready-fp">同源指纹 {{ r.fingerprint }} —— 与器材台账页一致</div>
      </div>
    </div>

    <div class="two-col">
      <form class="form-card" @submit.prevent="submitSchedule">
        <h3>排定季度应急演练</h3>
        <label class="filter-item"><span>演练区域</span>
          <select v-model="form.area">
            <option v-for="a in store.state.areas" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <label class="filter-item"><span>参演班组</span>
          <input v-model="form.crew" placeholder="如：运行一班" />
        </label>
        <label class="filter-item"><span>日期</span>
          <input v-model="form.date" type="date" />
        </label>
        <label class="filter-item"><span>时段</span>
          <select v-model="form.slot">
            <option value="上午">上午</option>
            <option value="下午">下午</option>
            <option value="夜间">夜间</option>
          </select>
        </label>
        <label class="filter-item"><span>演练场景</span>
          <input v-model="form.scenario" placeholder="如：油系统火灾应急处置" />
        </label>

        <!-- 排期前就用同一份判定告诉用户是否会被拦 -->
        <div class="precheck" :class="blocker ? 'err' : 'ok'">
          <template v-if="blocker">⛔ {{ blocker }}</template>
          <template v-else>✅ 本区域当前无待充装器材，可排期（提交时仍会再校验一次）</template>
        </div>
        <div v-if="slotOccupant" class="precheck warn">
          ⚠ {{ form.area }} {{ form.date }} {{ form.slot }} 已被 {{ slotOccupant.crew }} 的 {{ slotOccupant.id }} 占用
        </div>
        <button class="btn primary" type="submit">提交排期（占用时段）</button>
        <p v-if="message" class="result-banner" :class="messageOk ? 'ok' : 'err'">{{ message }}</p>
      </form>

      <div class="todo-card">
        <h3>演练待办（跟随器材状态实时变化）</h3>
        <ul class="todo-list">
          <li v-for="t in todos" :key="t.planId + t.text" :class="t.level">
            <span class="tag" :class="t.level === 'block' ? 'tag-block' : t.level === 'warn' ? 'tag-warn' : 'tag-ok'">{{ t.area }}</span>
            {{ t.text }}
          </li>
          <li v-if="!todos.length" class="muted">暂无待办</li>
        </ul>
      </div>
    </div>

    <section>
      <h3>演练计划与时段占用</h3>
      <table class="data-table">
        <thead>
          <tr><th>计划号</th><th>区域</th><th>班组</th><th>日期</th><th>时段</th><th>场景</th><th>状态</th><th>器材联动</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="d in store.drillsList.value" :key="d.id" :class="{ 'row-cancel': d.status === '已取消' }">
            <td>{{ d.id }}</td>
            <td>{{ d.area }}</td>
            <td>{{ d.crew }}</td>
            <td>{{ d.date }}</td>
            <td>{{ d.slot }}</td>
            <td>{{ d.scenario }}</td>
            <td>
              <span class="tag" :class="d.status === '已排期' ? 'tag-ok' : d.status === '已完成' ? 'tag-gray' : 'tag-block'">{{ d.status }}</span>
              <div v-if="d.cancelledAt" class="cell-sub">取消于 {{ d.cancelledAt }}，时段已释放</div>
            </td>
            <td>
              <template v-if="d.status === '已排期'">
                <span v-if="pendingNow(d.area).length" class="err-text">
                  现阻塞：{{ pendingNow(d.area).map((e) => e.id).join('、') }} 待充装，演练前必须回厂
                </span>
                <span v-else class="ok-text">器材齐装，可按计划演练</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="row-actions">
              <button v-if="d.status === '已排期'" class="link" type="button" @click="doCancel(d.id)">取消（释放时段）</button>
              <button v-if="d.status === '已排期'" class="link" type="button" @click="doFinish(d.id)">登记完成</button>
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
import { drillBlockers } from '../rules'

const store = useFireStore()

const form = reactive({ area: '主厂房', crew: '运行一班', date: '2026-10-28', slot: '上午' as '上午' | '下午' | '夜间', scenario: '油系统火灾应急处置与灭火器实操' })
const message = ref('')
const messageOk = ref(true)

const blocker = computed(() => drillBlockers(store.equipmentList.value, form.area, store.state.ruleVersion))
const slotOccupant = computed(() =>
  store.drillsList.value.find(
    (d) => d.area === form.area && d.date === form.date && d.slot === form.slot && d.status !== '已取消',
  ),
)

const pendingNow = (area: string) => store.equipmentList.value.filter((e) => e.area === area && e.status === '待充装')

interface Todo {
  planId: string
  area: string
  level: 'block' | 'warn' | 'ok'
  text: string
}

/** 待办随器材状态变：直接从当前器材推导，器材一回厂待办立即解除 */
const todos = computed<Todo[]>(() => {
  const list: Todo[] = []
  for (const d of store.drillsList.value.filter((x) => x.status === '已排期')) {
    const pending = pendingNow(d.area)
    if (pending.length) {
      list.push({
        planId: d.id,
        area: d.area,
        level: 'block',
        text: `${d.date} ${d.slot} 演练前，${pending.map((e) => e.id).join('、')} 必须充装回厂（单据可在器材页登记回厂）`,
      })
    } else {
      list.push({ planId: d.id, area: d.area, level: 'ok', text: `${d.date} ${d.slot} 演练器材已齐装，按计划组织` })
    }
    const worst = store.readiness(d.area).worstGrade
    if (worst === '重大隐患' && !pending.length) {
      list.push({ planId: d.id, area: d.area, level: 'warn', text: `${d.area} 仍有重大隐患（待报废/超期未充），演练前建议现场核查` })
    }
  }
  return list
})

async function submitSchedule() {
  message.value = ''
  const result = await store.scheduleDrill({ ...form, operator: '值班管理员' })
  messageOk.value = result.ok
  message.value = result.message
}
async function doCancel(id: string) {
  const result = await store.cancelDrill(id, '值班管理员')
  messageOk.value = result.ok
  message.value = result.message
}
async function doFinish(id: string) {
  const result = await store.finishDrill(id, '值班管理员')
  messageOk.value = result.ok
  message.value = result.message
}
</script>
