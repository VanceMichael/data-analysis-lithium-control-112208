import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadTables } from '../src/io.js'
import { buildAnalysis } from '../src/app.js'
import { RISK_KIND, PIECE } from '../src/constants.js'
import { buildDayWindowIndex } from '../src/query.js'
import { parseWork } from '../src/schedule.js'

const dataDir = new URL('../data/', import.meta.url).pathname

async function analysis(role = '计划员') {
  const tables = await loadTables(dataDir)
  return { tables, a: buildAnalysis(tables, { operatorRole: role }) }
}

test('完整分析对同一输入可重复重算且引用闭合', async () => {
  const { a } = await analysis()
  assert.deepEqual(a.referenceProblems, [])
  const again = buildAnalysis(await loadTables(dataDir), { operatorRole: '计划员' })
  assert.equal(JSON.stringify(again.lotComparison), JSON.stringify(a.lotComparison))
})

test('运行日-窗口映射：锚点日及之前属当前窗，之后滚动', async () => {
  const { tables, a } = await analysis()
  const tasks = parseWork(tables.work)
  const idx = buildDayWindowIndex(tasks, a.experiences)
  assert.equal(idx.map.get(1), 'W1')
  assert.equal(idx.map.get(3), 'W1')
  assert.equal(idx.map.get(4), 'W2')
})

test('按运行日查询把问题分成风险上升、缺乏证据、安排不下三类', async () => {
  const { a } = await analysis()
  const q4 = a.queryByDay(4)
  const rising = q4.findings[RISK_KIND.RISING].map(f => f.column)
  assert.ok(rising.includes('C5'))
  assert.ok(rising.includes('C6'))
  assert.ok(rising.includes('C2')) // 有效化验 0.73 确认越界
  const noEvidence = q4.findings[RISK_KIND.NO_EVIDENCE].map(f => f.column)
  assert.ok(noEvidence.includes('C1')) // 旁路
  const q3 = a.queryByDay(3)
  assert.ok(q3.findings[RISK_KIND.NO_EVIDENCE].some(f => f.column === 'C1')) // 化验待查
  // W1 施工名额已满 → 安排不下
  assert.ok(q3.findings[RISK_KIND.NOT_FEASIBLE].some(f => f.text.includes('施工名额')))
})

test('待查化验影响的替代方案被重判：C1 待查在风险与排程中都留痕', async () => {
  const { a } = await analysis()
  const c1risk = a.columnRisk.find(r => r.column === 'C1')
  assert.equal(c1risk.provisional, true)
  const w2 = a.schedule.find(s => s.window === 'W2')
  const c1status = w2.lines.flatMap(l => l.unitStatus).find(u => u.column === 'C1')
  assert.equal(c1status.evidencePending, true)
})

test('共用备用柱在窗口排程中只登记一次占用', async () => {
  const { a } = await analysis()
  const w1 = a.schedule.find(s => s.window === 'W1')
  assert.deepEqual(w1.backupUsage, [{ backup: 'C4', line: 'A' }])
})

test('已承诺生产量影响：逐窗口给缺口与阻塞原因', async () => {
  const { a } = await analysis()
  const w1 = a.committedImpact.find(c => c.window === 'W1')
  assert.ok(w1.rows.every(r => r.shortfall === 0)) // W1 两线均可用
})

test('交付窗风险上限：区间闭合不了或上界超限都判不通过', async () => {
  const { a } = await analysis()
  const w1 = a.riskCaps.find(r => r.window === 'W1')
  assert.ok(w1.lines.every(l => l.pass === false))
  const reasons = w1.lines.map(l => l.why).join('')
  assert.ok(reasons.includes('无法闭合') || reasons.includes('>'))
})

test('化验名额报告把待检产物与待查寿命证据都计入，且同件不重复', async () => {
  const { a } = await analysis()
  const w1slots = a.labSlots.find(s => s.window === 'W1')
  const ids = w1slots.holders.map(h => h.id)
  assert.ok(ids.includes('P2'))
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(w1slots.note.includes('寿命'))
})

test('交付结果中已发件保留原签发依据，待检件不进稳定供给', async () => {
  const { a } = await analysis()
  const w1items = a.delivery.find(d => d.window === 'W1').items
  const shipped = w1items.find(i => i.piece === 'P3')
  assert.match(shipped.originalBasis, /不可假定收回/)
  const pending = w1items.find(i => i.piece === 'P2')
  assert.equal(pending.grade, '待检')
  assert.equal(pending.acceptable, true)
  void PIECE
})
