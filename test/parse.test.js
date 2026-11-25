import assert from 'node:assert/strict'
import { test } from 'node:test'
import { num, day, splitJoined, isMissing, validateTables, checkReferences } from '../src/parse.js'
import { MISSING } from '../src/constants.js'

test('字符串数值与缺失值解析：问号不是零，非法值显式报错', () => {
  assert.equal(num('48'), 48)
  assert.equal(num(MISSING), null)
  assert.equal(num(''), null)
  assert.equal(isMissing('?'), true)
  assert.throws(() => num('abc'), /无法解析/)
  assert.equal(day('3'), 3)
  assert.throws(() => day('0'), /合法运行日/)
  assert.throws(() => day('1.5'), /合法运行日/)
})

test('组合编号按加号拆分并去空白', () => {
  assert.deepEqual(splitJoined('C1+C3'), ['C1', 'C3'])
  assert.deepEqual(splitJoined(''), [])
})

test('来源表字段一致性与全字符串原始值校验', () => {
  const tables = { t: [{ a: '1', b: 'x' }, { a: '2', b: 'y' }] }
  assert.doesNotThrow(() => validateTables(tables, { columns: { t: ['a', 'b'] } }))
  assert.throws(() => validateTables({ t: [{ a: '1' }, { a: '2', b: 'y' }] }), /字段不一致/)
  assert.throws(() => validateTables({ t: [{ a: 1 }] }), /不是字符串/)
  assert.throws(() => validateTables({ t: [] }), /为空/)
})

test('跨表引用核对：未知柱、窗口、客户与进料都能被指出', () => {
  const good = {
    performance: [{ column: 'C1', load_lot: 'L1', day: '1', feed: 'A', processed: '1', ratio: '0.9', state: '运行' }],
    lab: [{ column: 'C1', day: '1', revision: '1', ratio: '0.9', state: '有效' }],
    paths: [{ line: 'A', units: 'C1', capacity: '10', backup: '' }],
    work: [{ task: 'M1', column: 'C1', period: 'W1', status: '候选', authority: '计划员' }],
    delivery: [{ window: 'W1', min_qty: '1', max_combined_risk: '0.1' }],
    thresholds: [{ feed: 'A', min_ratio: '0.8', window_ready: '1' }],
    maintenance: [{ window: 'W1', crew_slots: '1', restart: '下一窗口' }],
    product_rules: [{ customer: 'CTA', grade: '稳定', hold_allowed: 'no', latest: 'W1', minimum: '1' }],
    handoffs: [{ piece: 'P1', line: 'A', qty: '1', col: 'C1', window: 'W1', condition: '已签发', customer: 'CTA' }],
    storage: [{ window: 'W1', hold_volume: '1', lab_slots: '1' }],
  }
  assert.deepEqual(checkReferences(good), [])
  const bad = structuredClone(good)
  bad.work[0].column = 'CX'
  bad.handoffs[0].customer = 'CTX'
  const problems = checkReferences(bad)
  assert.ok(problems.some(p => p.includes('CX')))
  assert.ok(problems.some(p => p.includes('CTX')))
})
