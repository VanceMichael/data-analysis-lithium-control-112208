import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseThresholds, buildExperiences } from '../src/experience.js'
import { buildSampleLedger } from '../src/sampling.js'
import { compareLots } from '../src/life.js'
import { columnRisk, combinedRisk, passesWindowCap } from '../src/risk.js'

const load = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url)))

async function fixture() {
  const [performance, lab, thresholds] = await Promise.all([
    load('performance'), load('lab'), load('thresholds'),
  ])
  const ledger = buildSampleLedger(lab)
  const exps = buildExperiences(performance, parseThresholds(thresholds), ledger)
  return { exps, table: compareLots(exps, ['A', 'B']) }
}

test('待查柱的风险不可数值化，显式标记 provisional 与原因', async () => {
  const { exps, table } = await fixture()
  const c1 = exps.find(e => e.column === 'C1')
  const r = columnRisk(table, c1, 4, 1)
  assert.equal(r.point, null)
  assert.equal(r.provisional, true)
  assert.match(r.reasons.join(), /待查/)
})

test('无有效参考进料下的柱返回 noReference，而不是给假区间', async () => {
  const { exps, table } = await fixture()
  const c4 = exps.find(e => e.column === 'C4')
  const r = columnRisk(table, c4, 4, 1)
  assert.equal(r.noReference, true)
  assert.equal(r.interval[0], null)
})

test('可估计柱返回失效概率与 95% 区间，点估计落在区间内', async () => {
  const { exps, table } = await fixture()
  const c5 = exps.find(e => e.column === 'C5')
  const r = columnRisk(table, c5, 4, 1)
  assert.ok(typeof r.point === 'number')
  assert.ok(r.interval[0] <= r.point && r.point <= r.interval[1])
})

test('串联组合在正相关假设下取保守上界，并联给 Fréchet 边界', () => {
  const map = new Map([
    ['C1', { interval: [0.1, 0.3], noReference: false, provisional: false, reasons: [] }],
    ['C2', { interval: [0.05, 0.2], noReference: false, provisional: false, reasons: [] }],
    ['CX', { interval: [null, null], noReference: true, provisional: false, reasons: ['无参考'] }],
  ])
  const series = combinedRisk(['C1', 'C2'], map, 'series')
  assert.equal(series.interval[1], 0.3) // 完全正相关上界 = 最大单柱
  assert.ok(series.interval[0] >= 0)
  const parallel = combinedRisk(['C1', 'C2'], map, 'parallel')
  assert.equal(parallel.interval[0], 0.1) // max
  assert.equal(parallel.interval[1], 0.5) // min(1, sum)

  const withGap = combinedRisk(['C1', 'CX'], map, 'series')
  assert.equal(withGap.noReference, true)
  assert.match(withGap.reasons.join(), /CX/)
})

test('交付窗风险上限用区间上界判定，闭合不了即不能证明满足', () => {
  const ok = passesWindowCap({ interval: [0.02, 0.09], noReference: false }, 0.1)
  assert.equal(ok.pass, true)
  const bad = passesWindowCap({ interval: [0.2, 0.6], noReference: false }, 0.12)
  assert.equal(bad.pass, false)
  const gap = passesWindowCap({ interval: [null, null], noReference: true }, 0.1)
  assert.equal(gap.pass, false)
  assert.match(gap.why, /无法闭合/)
})
