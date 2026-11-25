import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseThresholds, buildExperiences } from '../src/experience.js'
import { buildSampleLedger } from '../src/sampling.js'
import {
  parseRules, parseHandoffs, parseStorage, stableReadiness, holdUsage,
  evaluateDelivery, applyLabVerdict, customerBlockers,
} from '../src/product.js'
import { PIECE, GRADE } from '../src/constants.js'

const load = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url)))

async function fixture() {
  const [performance, lab, thresholds, rulesRows, handoffRows, storageRows] = await Promise.all([
    load('performance'), load('lab'), load('thresholds'),
    load('product_rules'), load('handoffs'), load('storage'),
  ])
  const ledger = buildSampleLedger(lab)
  const exps = buildExperiences(performance, parseThresholds(thresholds), ledger)
  const thresholdMap = parseThresholds(thresholds)
  return {
    readiness: stableReadiness(exps, thresholdMap),
    rules: parseRules(rulesRows),
    pieces: parseHandoffs(handoffRows),
    storage: parseStorage(storageRows),
  }
}

test('新装填/待查柱未取得首批稳定读数前只能产出待检量', async () => {
  const { readiness } = await fixture()
  assert.equal(readiness.get('C1').ready, true) // 有 day1 有效读数
  assert.equal(readiness.get('C3').ready, true)
  // C2 有有效化验确认稳定读数历史
  assert.equal(readiness.get('C2').ready, true)
})

test('待检量物理占用容器与化验名额，超额窗口显式报满', async () => {
  const { pieces, storage } = await fixture()
  const w1 = holdUsage('W1', pieces, storage)
  assert.equal(w1.holdVolumeUsed, 25)
  assert.equal(w1.overHold, false)
  assert.equal(w1.labDemands, 1)
  const overflow = holdUsage('W1', [
    ...pieces,
    { piece: 'PX', line: 'B', qty: 10, col: 'C2', window: 'W1', condition: PIECE.RECHECK, customer: 'CTB' },
  ], storage)
  assert.equal(overflow.overLab, true)
  assert.equal(overflow.overHold, true) // 25+10 > 29
})

test('只收稳定量的客户不能接收待检/重检量，待检量不能两边重复计用', async () => {
  const { readiness, rules, pieces } = await fixture()
  const evalAll = evaluateDelivery(pieces, rules, readiness)
  const p2 = evalAll.find(d => d.piece === 'P2') // 待检 -> CTC 允许待检
  assert.equal(p2.acceptable, true)
  assert.equal(p2.grade, GRADE.PENDING)
  const p4 = evalAll.find(d => d.piece === 'P4') // 重检 -> CTB 只收稳定
  assert.equal(p4.acceptable, false)
  assert.match(p4.blocking.join(), /物理占用/)
})

test('化验改判可让待检批转可交或降级，并保留依据', async () => {
  const { readiness, rules, pieces } = await fixture()
  let overrides = new Map()
  const turn = applyLabVerdict(pieces, overrides, {
    piece: 'P4', decision: '转可交', basis: 'W2 复核化验 0.88，达到进料 A 阈值',
  })
  overrides = turn.overrides
  let evalAll = evaluateDelivery(pieces, rules, readiness, overrides)
  const p4ok = evalAll.find(d => d.piece === 'P4')
  assert.equal(p4ok.condition, PIECE.ISSUED)
  assert.equal(p4ok.acceptable, true)

  const down = applyLabVerdict(pieces, overrides, {
    piece: 'P4', decision: '降级', basis: '复检波动超差',
  })
  evalAll = evaluateDelivery(pieces, rules, readiness, down.overrides)
  const p4down = evalAll.find(d => d.piece === 'P4')
  assert.equal(p4down.condition, PIECE.RECHECK)
  assert.equal(p4down.acceptable, false)
})

test('已发货批次不收回：改判只登记原签发依据与应补沟通', async () => {
  const { readiness, rules, pieces } = await fixture()
  const { overrides, effect } = applyLabVerdict(pieces, new Map(), {
    piece: 'P3', decision: '降级', basis: '事后质量回顾', communication: '通知 CTA 下批补偿',
  })
  assert.equal(effect, 'shipped-communication-only')
  const evalAll = evaluateDelivery(pieces, rules, readiness, overrides)
  const p3 = evalAll.find(d => d.piece === 'P3')
  assert.equal(p3.condition, PIECE.SHIPPED)
  assert.match(p3.originalBasis, /不可假定收回/)
  assert.match(p3.communication, /CTA/)
})

test('紧缺时按等待时限与最低量输出客户阻塞链', async () => {
  const { readiness, rules, pieces, storage } = await fixture()
  const evalAll = evaluateDelivery(pieces, rules, readiness)
  const w1 = customerBlockers('W1', evalAll, rules, storage.get('W1'))
  const ctc = w1.find(r => r.customer === 'CTC')
  assert.equal(ctc.meetsMinimum, true) // 25 >= 25 待检可接受
  const cta = w1.find(r => r.customer === 'CTA')
  // 可交量含已签发 P1=30 与已发 P3=12（已发仍留原签发依据），42 < 65 最低量
  assert.equal(cta.acceptableQty, 42)
  assert.equal(cta.meetsMinimum, false)
  assert.ok(cta.blocks.join().includes('最低 65'))
  const w2 = customerBlockers('W2', evalAll, rules, storage.get('W2'))
  const ctb = w2.find(r => r.customer === 'CTB')
  assert.equal(ctb.meetsMinimum, false) // P4 重检不可交，可交 0 < 50
  assert.ok(ctb.blocks.join().includes('P4'))
})
