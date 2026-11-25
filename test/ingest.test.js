import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTables } from '../src/io.js'
import { ingest, maintenanceReceipt, snapshot } from '../src/ingest.js'
import { buildAnalysis } from '../src/app.js'

const dataDir = new URL('../data/', import.meta.url).pathname

test('新交班记录走统一入口：合法追加被接受，重复业务键幂等', async () => {
  const tables = await loadTables(dataDir)
  const incoming = {
    lab: [
      { column: 'C1', day: '3', revision: '3', ratio: '0.81', state: '有效' },
      { column: 'C1', day: '3', revision: '2', ratio: '0.83', state: '报告待复核' }, // 重复
    ],
  }
  const result = ingest(tables, incoming)
  assert.equal(result.accepted.length, 1)
  assert.deepEqual(result.duplicates, [{ table: 'lab', key: 'C1#3#2' }])
  assert.deepEqual(result.referenceProblems, [])
  // 原表不被污染
  assert.equal(tables.lab.length, 2)
  assert.equal(result.tables.lab.length, 3)
})

test('追加非字符串原始值或未知字段会被拒绝', async () => {
  const tables = await loadTables(dataDir)
  assert.throws(() => ingest(tables, { lab: [{ column: 'C9', day: '1', revision: 1, ratio: '0.9', state: '有效' }] }),
    /必须是字符串/)
  assert.throws(() => ingest(tables, { lab: [{ column: 'C9', day: '1', revision: '1', ratio: '0.9', state: '有效', extra: 'x' }] }),
    /未知字段/)
})

test('维修回执：任务推进完工并补复启记录，之后重算得到新料次经历', async () => {
  const tables = await loadTables(dataDir)
  const before = buildAnalysis(tables)
  const c3before = before.experiences.find(e => e.column === 'C3')
  assert.equal(c3before.lot, 'L2')

  const result = maintenanceReceipt(tables, {
    task: 'M1', restartDay: 5, newLot: 'L4', state: '已装填',
  })
  assert.deepEqual(result.referenceProblems, [])
  const after = buildAnalysis(result.tables)
  const c3lots = after.experiences.filter(e => e.column === 'C3').map(e => e.lot).sort()
  assert.deepEqual(c3lots, ['L2', 'L4'])
  const workRow = result.tables.work.find(r => r.task === 'M1')
  assert.equal(workRow.status, '已完工')
})

test('快照隔离：录入过程不改变上一轮分析输入', async () => {
  const tables = await loadTables(dataDir)
  const clone = snapshot(tables)
  ingest(tables, { lab: [{ column: 'C1', day: '5', revision: '1', ratio: '0.9', state: '有效' }] })
  assert.equal(clone.lab.length, tables.lab.length)
})
