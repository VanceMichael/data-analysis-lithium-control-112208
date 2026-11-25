// 化验取样台账。
// 规则要点：
// - 同一柱同一运行日只对应一份独立样本；跨班复用的同一份样本不能当独立样本。
// - 同一柱/日的多次化验按 revision 归并，取最新修订；旧修订保留为修订链。
// - 班组固定采样上限（storage.lab_slots）是化验名额，不是设备寿命依据。
// - 化验未生效（非"有效"）时，相关寿命证据进入"待查"，不能直接判失效。

import { num, day, isMissing } from './parse.js'

const EFFECTIVE_STATE = '有效'

/**
 * 归并化验记录为按 柱+运行日 唯一的样本台账。
 * @returns {Map<string, import('./index.js').LabSample>} key = column#day
 */
export function buildSampleLedger(labRows) {
  const ledger = new Map()
  for (const row of labRows) {
    const d = day(row.day)
    const key = `${row.column}#${d}`
    const revision = num(row.revision, 'revision') ?? 1
    const ratio = isMissing(row.ratio) ? null : num(row.ratio, 'ratio')
    const sample = ledger.get(key) ?? {
      column: row.column,
      day: day(row.day),
      revisions: [],
      latestRevision: 0,
      latestRatio: null,
      state: row.state,
      effective: false,
    }
    sample.revisions.push({ revision, ratio, state: row.state })
    if (revision >= sample.latestRevision) {
      sample.latestRevision = revision
      sample.latestRatio = ratio
      sample.state = row.state
      sample.effective = row.state === EFFECTIVE_STATE
    }
    ledger.set(key, sample)
  }
  for (const sample of ledger.values()) {
    sample.revisions.sort((a, b) => a.revision - b.revision)
    sample.effective = sample.state === EFFECTIVE_STATE
  }
  return ledger
}

/**
 * 窗口化验名额占用核对。待检/重检/复核中的产物与待查寿命证据都会占名额；
 * 名额是固定上限，不能当作寿命。
 * @param {Array<{window:string, lab_slots:string}>} storageRows
 * @param {Map<string, Array<{id:string, reason:string}>>} demandsByWindow
 */
export function checkLabSlots(storageRows, demandsByWindow) {
  const result = []
  for (const row of storageRows) {
    const cap = num(row.lab_slots, 'lab_slots')
    const demands = demandsByWindow.get(row.window) ?? []
    // 同一样本（同 id）即使被多个方案引用也只占一个名额
    const unique = new Map()
    for (const d of demands) if (!unique.has(d.id)) unique.set(d.id, d)
    const holders = [...unique.values()]
    result.push({
      window: row.window,
      labSlots: cap,
      occupied: holders.length,
      free: Math.max(0, cap - holders.length),
      overloaded: holders.length > cap,
      holders,
      note: '化验名额是固定采样上限，不构成吸附柱寿命依据',
    })
  }
  return result
}
