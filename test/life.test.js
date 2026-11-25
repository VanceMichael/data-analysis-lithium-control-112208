import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseThresholds, buildExperiences } from '../src/experience.js'
import { buildSampleLedger } from '../src/sampling.js'
import { compareLots, dependenceClusters, remainingLife } from '../src/life.js'

const load = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url)))

async function fixture() {
  const [performance, lab, thresholds] = await Promise.all([
    load('performance'), load('lab'), load('thresholds'),
  ])
  const ledger = buildSampleLedger(lab)
  const exps = buildExperiences(performance, parseThresholds(thresholds), ledger)
  return { exps, table: compareLots(exps, ['A', 'B']) }
}

test('计划拆除与期末在役按右删失处理，不进入失效计数', async () => {
  const { table } = await fixture()
  const l2 = table.get('A').find(r => r.lot === 'L2')
  assert.equal(l2.failures, 1) // 仅 C6
  assert.equal(l2.censored, 1) // C3 计划拆除
  assert.equal(l2.sampleSize, 2)
})

test('待查单位不进 KM 风险集，料次标记 provisional', async () => {
  const { table } = await fixture()
  const l1 = table.get('A').find(r => r.lot === 'L1')
  assert.deepEqual(l1.pending, ['C1'])
  assert.equal(l1.provisional, true)
  // KM 只含 C2(失效,d4，化验补救) 与 C5(失效,d4)，C1 待查排除
  assert.deepEqual(l1.km.map(r => r.day), [4])
  assert.equal(l1.km[0].nRisk, 2)
  assert.equal(l1.km[0].nFail, 2)
  assert.equal(l1.km[0].survival, 0)
})

test('无失效或无观察的料次显式给出无有效参考原因，而不是编造区间', async () => {
  const { table } = await fixture()
  const l3A = table.get('A').find(r => r.lot === 'L3')
  assert.equal(l3A.noReference, true)
  assert.match(l3A.noReferenceReason, /没有任何可比/)
  const l1B = table.get('B').find(r => r.lot === 'L1')
  assert.equal(l1B.noReference, true)
  assert.match(l1B.noReferenceReason, /无失效/)
  assert.equal(l1B.median.value, null)
})

test('KM 中位寿命在小样本下给区间与闭合说明，且附故障平均寿命偏差警告', async () => {
  const { table } = await fixture()
  const l1 = table.get('A').find(r => r.lot === 'L1')
  assert.equal(l1.median.value, 4)
  assert.ok(l1.median.reason?.includes('区间无法闭合'))
  assert.equal(l1.naiveMeanFailureDays, 4)
  assert.match(l1.naiveWarning, /禁止用于排程/)
})

test('同料次+共用进料形成失效依赖簇，簇内声明不独立', async () => {
  const { exps } = await fixture()
  const { lotClusters, feedClusters } = dependenceClusters(exps)
  const l1a = lotClusters.find(c => c.id === 'L1@A')
  assert.deepEqual(l1a.columns.sort(), ['C1', 'C2', 'C5'])
  assert.deepEqual(l1a.failed.sort(), ['C2', 'C5'])
  assert.equal(l1a.independent, false)
  const feedA = feedClusters.find(c => c.id === 'feed:A')
  assert.ok(feedA.columns.includes('C6'))
  assert.ok(feedA.lots.includes('L2'))
})

test('剩余可用概率为条件生存估计并返回区间', () => {
  const km = [
    { day: 3, nRisk: 3, nFail: 1, survival: 2 / 3, ciLower: 0.2, ciUpper: 0.95 },
    { day: 5, nRisk: 2, nFail: 1, survival: 1 / 3, ciLower: 0.05, ciUpper: 0.7 },
  ]
  const r = remainingLife(km, 3, 2)
  assert.ok(r.point >= 0 && r.point <= 1)
  assert.ok(r.interval[0] <= r.point && r.point <= r.interval[1])
  const dead = remainingLife([{ day: 1, survival: 0, ciLower: 0, ciUpper: 0 }], 1, 1)
  assert.equal(dead.point, 0)
})
