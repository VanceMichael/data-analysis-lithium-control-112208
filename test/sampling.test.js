import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSampleLedger, checkLabSlots } from '../src/sampling.js'

test('同柱同日多修订只保留一份独立样本，取最新 revision，跨班复用不当独立样本', () => {
  const rows = [
    { column: 'C1', day: '3', revision: '1', ratio: '0.77', state: '有效' },
    { column: 'C1', day: '3', revision: '2', ratio: '0.83', state: '报告待复核' },
  ]
  const ledger = buildSampleLedger(rows)
  assert.equal(ledger.size, 1)
  const s = ledger.get('C1#3')
  assert.equal(s.revisions.length, 2)
  assert.equal(s.latestRevision, 2)
  assert.equal(s.latestRatio, 0.83)
  assert.equal(s.effective, false) // 待复核状态不生效
})

test('有效化验以最新修订为准并标记生效', () => {
  const ledger = buildSampleLedger([
    { column: 'C2', day: '4', revision: '1', ratio: '0.5', state: '报告待复核' },
    { column: 'C2', day: '4', revision: '2', ratio: '0.73', state: '有效' },
  ])
  const s = ledger.get('C2#4')
  assert.equal(s.effective, true)
  assert.equal(s.latestRatio, 0.73)
})

test('化验名额：同一样本被多个方案引用只占一个名额，超额显式报满', () => {
  const demands = new Map([
    ['W1', [{ id: 'P2', reason: '产物待检' }, { id: 'P2', reason: '另一方案引用同件' }]],
  ])
  const report = checkLabSlots([{ window: 'W1', lab_slots: '1' }], demands)
  assert.equal(report[0].occupied, 1)
  assert.equal(report[0].overloaded, false)

  const over = checkLabSlots([{ window: 'W1', lab_slots: '1' }], new Map([
    ['W1', [{ id: 'P2' }, { id: 'lab:C1#3' }]],
  ]))
  assert.equal(over[0].occupied, 2)
  assert.equal(over[0].overloaded, true)
  assert.match(over[0].note, /采样上限.*寿命/)
})
