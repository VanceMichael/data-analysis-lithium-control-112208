import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseThresholds, buildExperiences } from '../src/experience.js'
import { buildSampleLedger } from '../src/sampling.js'
import { EVIDENCE, STATE } from '../src/constants.js'

const load = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url)))

async function fixture() {
  const [performance, lab, thresholds] = await Promise.all([
    load('performance'), load('lab'), load('thresholds'),
  ])
  const ledger = buildSampleLedger(lab)
  return buildExperiences(performance, parseThresholds(thresholds), ledger)
}

const find = (exps, col, lot) => exps.find(e => e.column === col && e.lot === lot)

test('按料次形成运行经历并区分运行/旁路/停机/拆装四类状态', async () => {
  const exps = await fixture()
  const c1 = find(exps, 'C1', 'L1')
  const states = c1.days.map(d => d.state)
  assert.ok(states.includes(STATE.RUN))
  assert.ok(states.includes(STATE.BYPASS))
  const c3 = find(exps, 'C3', 'L2')
  assert.equal(c3.plannedRemovalDay, 3)
  assert.equal(c3.censored.kind, '删失')
  assert.equal(c3.censored.reason, EVIDENCE.PLANNED)
})

test('处理量只累计运行日，旁路与拆装不计磨损', async () => {
  const exps = await fixture()
  const c1 = find(exps, 'C1', 'L1')
  // 48 + 55（运行），day4 旁路 processed=25 不计入
  assert.equal(c1.throughput, 103)
  assert.equal(c1.runDays, 2)
  assert.equal(c1.bypassDays, 1)
})

test('有效化验优先于运行记录；未生效化验使证据待查，不能直接判越界', async () => {
  const exps = await fixture()
  const c1 = find(exps, 'C1', 'L1')
  const day3Entry = c1.days.find(d => d.day === 3)
  assert.equal(day3Entry.evidence, EVIDENCE.PENDING)
  assert.equal(day3Entry.labPending, true)
  // 原始运行读数保留可追溯，但因化验待复核不得用于越界判定
  assert.equal(day3Entry.rawRatio, 0.77)
  assert.equal(day3Entry.effectiveRatio, null)
  assert.deepEqual(c1.pendingEvidence, [3])
  assert.equal(c1.failure, null) // 0.77 虽低于 0.78，但被待复核化验挂起

  const c2 = find(exps, 'C2', 'L1')
  const d4 = c2.days.find(d => d.day === 4)
  assert.equal(d4.evidence, EVIDENCE.BREACH) // 缺测日被有效化验 0.73 补救
  // 化验有效（0.73 < 0.78）应判越界
  assert.ok(c2.failure, 'C2 应有化验确认的失效')
  assert.equal(c2.failure.ratio, 0.73)
  assert.equal(c2.failure.source, '化验有效')
})

test('性能越界按进料阈值判定，换进料后的好转读数不混入原进料比较', async () => {
  const exps = await fixture()
  const c5 = find(exps, 'C5', 'L1')
  assert.equal(c5.failure.day, 4)
  assert.equal(c5.failure.ratio, 0.72)
  assert.equal(c5.failure.threshold, 0.78)

  const c1 = find(exps, 'C1', 'L1')
  // C1 在 day4 切到进料 B，进料变化显式留痕
  assert.deepEqual(c1.feedChangeDays.map(x => x.to), ['B'])
  const segB = c1.feedSegments.find(s => s.feed === 'B')
  assert.deepEqual(segB.states, [STATE.BYPASS])
})

test('缺测与计划拆除时间窗归为取样不足/计划证据，不伪造自然失效；有效化验可补救缺测日', async () => {
  const exps = await fixture()
  const c2 = find(exps, 'C2', 'L1')
  const d4 = c2.days.find(d => d.day === 4)
  assert.equal(d4.evidence, EVIDENCE.BREACH) // 有效化验 0.73 < 0.78
  assert.equal(d4.comparable, true)
  const c3 = find(exps, 'C3', 'L2')
  const d3 = c3.days.find(d => d.day === 3)
  assert.equal(d3.evidence, EVIDENCE.PLANNED)
})

test('低浓度进料下表现好转的柱保留分段记录，可比记录按进料区分', async () => {
  const exps = await fixture()
  const c4 = find(exps, 'C4', 'L3')
  assert.deepEqual(c4.feedSeen, ['B'])
  assert.equal(c4.comparableRecordKeys.length, 2)
  assert.equal(c4.failure, null)
})
