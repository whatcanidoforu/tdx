<template>
  <div class="file-selector">
    <div class="selector-header">📁 选择文件</div>

    <div class="drop-zone"
      :class="{ active: dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="drop-icon">📂</div>
      <div class="drop-text">拖拽 .day / .lc1 / .lc5 文件到此处</div>
      <div class="drop-hint">或点击下方按钮</div>
    </div>

    <div class="selector-section">
      <label class="file-input-label">
        <input type="file" accept=".day,.lc1,.lc5,.min" @change="onFileInput" class="hidden-input" />
        <span class="btn btn-block">选择单个文件</span>
      </label>
    </div>

    <div class="selector-section">
      <label class="file-input-label">
        <input type="file" webkitdirectory directory multiple @change="onDirInput" class="hidden-input" />
        <span class="btn btn-block btn-secondary">{{ dirFiles.length ? '切换目录' : '选择数据目录' }}</span>
      </label>
    </div>

    <div v-if="dirFiles.length > 0" class="code-search">
      <div class="search-label">🔍 输入代码查找并加载</div>
      <div class="market-chips">
        <button v-for="m in ['', 'sh', 'sz', 'bj']" :key="m" class="chip"
          :class="{ active: filterMarket === m }" @click="filterMarket = m">{{ m || '全部' }}</button>
      </div>
      <input v-model="filterText" type="text" placeholder="例如: 600000、000001..."
        class="filter-input" @keydown.enter="onEnterSearch" />
      <div v-if="filterText.trim() && filteredNames.length > 0" class="match-list">
        <div v-for="name in filteredNames" :key="name" class="match-item" @click="loadByName(name)">
          <span class="match-name">{{ name }}</span>
        </div>
      </div>
      <div v-else-if="filterText.trim() && filteredNames.length === 0" class="empty-msg">无匹配文件</div>
      <div v-if="!filterText.trim()" class="dir-info">
        目录中有 {{ dirFiles.length }} 个行情文件（sh{{ shCount }} / sz{{ szCount }} / bj{{ bjCount }}）
      </div>
    </div>

    <div class="current-file" v-if="filePath">
      <span class="current-label">当前文件</span>
      <span class="current-path">{{ filePath }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  filePath: { type: String, default: '' },
});

const emit = defineEmits(['select', 'error']);

const dragging = ref(false);
const dirFiles = ref([]);
const filterText = ref('');
const filterMarket = ref('');

const shCount = computed(() => dirFiles.value.filter((f) => f.name.startsWith('sh')).length);
const szCount = computed(() => dirFiles.value.filter((f) => f.name.startsWith('sz')).length);
const bjCount = computed(() => dirFiles.value.filter((f) => f.name.startsWith('bj')).length);

const filteredNames = computed(() => {
  const text = filterText.value.trim().toLowerCase();
  const market = filterMarket.value;
  if (!text) return [];

  let list = dirFiles.value;
  if (market) {
    list = list.filter((f) => f.name.startsWith(market));
  }
  return list
    .filter((f) => f.name.toLowerCase().includes(text))
    .map((f) => f.name)
    .slice(0, 20);
});

function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, arrayBuffer: reader.result });
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

async function onFileInput(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const result = await readFileAsBuffer(file);
    emit('select', result);
  } catch (err) {
    emit('error', err.message);
  }
  e.target.value = '';
}

async function onDrop(e) {
  dragging.value = false;
  const files = e.dataTransfer.files;
  if (files.length === 0) return;
  try {
    const result = await readFileAsBuffer(files[0]);
    emit('select', result);
  } catch (err) {
    emit('error', err.message);
  }
}

function onDirInput(e) {
  const files = Array.from(e.target.files).filter((f) => {
    const name = f.name.toLowerCase();
    return name.endsWith('.day') || name.endsWith('.lc1') || name.endsWith('.lc5') || name.endsWith('.min');
  });

  if (files.length === 0) {
    emit('error', '所选目录中没有 .day/.lc1/.lc5/.min 文件');
    e.target.value = '';
    return;
  }

  dirFiles.value = files.sort((a, b) => a.name.localeCompare(b.name));
  filterText.value = '';
  e.target.value = '';
}

async function loadByName(name) {
  const file = dirFiles.value.find((f) => f.name === name);
  if (!file) return;
  filterText.value = name;
  try {
    const result = await readFileAsBuffer(file);
    emit('select', result);
  } catch (err) {
    emit('error', err.message);
  }
}

function onEnterSearch() {
  if (filteredNames.value.length > 0) {
    loadByName(filteredNames.value[0]);
  }
}
</script>

<style scoped>
.file-selector {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.selector-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.drop-zone {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 20px 16px;
  text-align: center;
  transition: border-color 0.2s, background 0.2s;
}

.drop-zone.active {
  border-color: var(--accent-blue);
  background: rgba(88, 166, 255, 0.05);
}

.drop-icon { font-size: 28px; margin-bottom: 8px; opacity: 0.5; }
.drop-text { font-size: 13px; color: var(--text-primary); margin-bottom: 4px; }
.drop-hint { font-size: 11px; color: var(--text-muted); }

.selector-section { display: flex; flex-direction: column; }
.hidden-input { display: none; }
.file-input-label { cursor: pointer; }

.btn {
  display: block;
  padding: 8px 14px;
  background: var(--accent-blue);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  text-align: center;
  transition: opacity 0.2s;
}

.btn:hover { opacity: 0.85; }

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.code-search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.search-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.filter-input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: var(--font-mono);
  outline: none;
  transition: border-color 0.2s;
}

.filter-input::placeholder { color: var(--text-muted); }
.filter-input:focus { border-color: var(--accent-blue); }

.market-chips { display: flex; gap: 4px; }

.chip {
  flex: 1;
  padding: 3px 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.chip:hover { border-color: var(--accent-blue); color: var(--text-secondary); }
.chip.active { background: var(--accent-blue); border-color: var(--accent-blue); color: #fff; }

.match-list {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.match-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-family: var(--font-mono);
  color: var(--text-primary);
  transition: background 0.1s;
}

.match-item:hover { background: rgba(88, 166, 255, 0.12); }

.match-name { }

.empty-msg {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.dir-info {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.current-file {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--bg-card);
  border-radius: 6px;
  border: 1px solid var(--border);
}

.current-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
}

.current-path {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-all;
}
</style>