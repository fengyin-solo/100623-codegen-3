<template>
  <section class="page fire-page" data-module="fire">
    <header class="page-head">
      <div>
        <h2>消防器材与应急演练一体化清单</h2>
        <p class="page-desc">
          灭火器等消防器材台账与季度应急演练合并为一张清单：按区域多选批量送充/报废、逐台结果回写隐患；
          演练排期看器材状态、取消释放时段；每季度按区域整组另存；老数据按原编号迁移并按批次补缺、冲突仲裁。
        </p>
      </div>
      <div class="page-actions">
        <span class="version-badge">口径 {{ store.state.ruleVersion }} · 修订号 {{ store.state.revision }}</span>
      </div>
    </header>

    <nav class="fire-tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="fire-tab"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </nav>

    <EquipmentPanel v-if="tab === 'equipment'" />
    <DrillPanel v-else-if="tab === 'drill'" />
    <HazardPanel v-else-if="tab === 'hazard'" />
    <ArchivePanel v-else-if="tab === 'archive'" />
    <GovernancePanel v-else />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import ArchivePanel from './components/ArchivePanel.vue'
import DrillPanel from './components/DrillPanel.vue'
import EquipmentPanel from './components/EquipmentPanel.vue'
import GovernancePanel from './components/GovernancePanel.vue'
import HazardPanel from './components/HazardPanel.vue'
import { useFireStore } from './store'

const store = useFireStore()
const tab = ref<'equipment' | 'drill' | 'hazard' | 'archive' | 'governance'>('equipment')
const tabs = [
  { key: 'equipment', label: '器材清单与批量处理' },
  { key: 'drill', label: '应急演练排期' },
  { key: 'hazard', label: '现场巡视隐患清单' },
  { key: 'archive', label: '季度整组另存' },
  { key: 'governance', label: '规则版本·迁移·并发' },
] as const
</script>
