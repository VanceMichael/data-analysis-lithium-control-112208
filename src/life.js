// 寿命证据分析。
//
// 针对"用故障记录平均寿命会把同批老化柱一起留到高负荷时段"的问题，
// 这里采用 Kaplan–Meier 乘积极限估计：
//   - 计划拆除、观察期末仍在役都按右删失处理，不伪造自然失效时间；
//   - 按进料入口条件分别建表，跨进料读数不混合；
//   - Greenwood 方差 + log(-log) 变换给出生存函数的 95% 区间，
//     中位寿命及其区间在样本不足/未观测到失效时显式给出"无有效参考"原因；
//   - 同时输出朴素的"故障平均寿命"仅作对照，并标注其偏差，排程不得使用。
//
// 同批次同时劣化在组合层体现：同料次+同进料（以及更宽的共用进料）
// 的柱归入同一依赖簇，簇内观察不能当作相互独立的失效。

import { EVIDENCE } from './constants.js'

const Z95 = 1.959964

/** 取一个料次经历在指定进料下的单位信息。 */
function unitUnderFeed(exp, feed) {
  const feedDays = exp.days.filter(d => d.feed === feed)
  const comparableDays = feedDays.filter(d => d.comparable)
  const lastComparable = comparableDays.reduce((m, d) => Math.max(m, d.day), 0)
  const failureHere = exp.failure && exp.failure.feed === feed ? exp.failure : null
  const pending = feedDays.some(d => d.evidence === EVIDENCE.PENDING)
  const insufficientDays = feedDays
    .filter(d => d.evidence === EVIDENCE.INSUFFICIENT)
    .map(d => d.day)
  const observed = comparableDays.length > 0 || pending
  return {
    column: exp.column,
    lot: exp.lot,
    feed,
    observed,
    lastComparableDay: lastComparable,
    failure: failureHere ? failureHere.day : null,
    eventDay: failureHere ? failureHere.day : lastComparable,
    status: failureHere ? '失效' : pending ? '待查' : '删失',
    pending,
    insufficientDays,
  }
}

/** Greenwood 方差与 log(-log) 95% 区间。 */
function kaplanMeier(units) {
  const eventTimes = [...new Set(units.filter(u => u.failure !== null).map(u => u.eventDay))]
    .sort((a, b) => a - b)
  const rows = []
  let survival = 1
  let greenwoodSum = 0
  for (const t of eventTimes) {
    const nRisk = units.filter(u => (u.failure !== null ? u.eventDay >= t : u.eventDay >= t)).length
    const nFail = units.filter(u => u.failure !== null && u.eventDay === t).length
    const factor = 1 - nFail / nRisk
    survival *= factor
    if (nRisk - nFail > 0) greenwoodSum += nFail / (nRisk * (nRisk - nFail))
    const variance = survival * survival * greenwoodSum
    let ciLower = 0
    let ciUpper = 0
    if (survival > 0 && survival < 1) {
      const seLogLog = Math.sqrt(greenwoodSum) / Math.abs(Math.log(survival))
      ciLower = Math.pow(survival, Math.exp(Z95 * seLogLog))
      ciUpper = Math.pow(survival, Math.exp(-Z95 * seLogLog))
    } else if (survival === 1) {
      ciLower = 1
      ciUpper = 1
    }
    rows.push({ day: t, nRisk, nFail, survival, variance, ciLower, ciUpper })
  }
  return rows
}

/** 中位寿命及其区间；未达到 0.5 或区间无法确定时给出原因而非编造数值。 */
function medianLife(kmRows) {
  if (kmRows.length === 0) {
    return { value: null, ci: [null, null], reason: '样本内无失效事件，无法估计中位寿命' }
  }
  const cross = kmRows.find(r => r.survival <= 0.5)
  const value = cross ? cross.day : null
  const lowRow = kmRows.find(r => r.ciLower <= 0.5)
  const highRow = [...kmRows].reverse().find(r => r.ciUpper > 0.5)
  const ci = [lowRow ? lowRow.day : null, highRow ? highRow.day : null]
  const reason = value === null
    ? '随访期内生存函数未降到 0.5，中位寿命未观测到（只能给出下界）'
    : ci[0] === null || ci[1] === null
      ? '样本量过小，95% 区间无法闭合'
      : null
  return { value, ci, reason }
}

/**
 * 按进料汇总各料次的寿命证据与区间。
 * @returns {Map<string, Array>} feed -> 料次比较行
 */
export function compareLots(experiences, feeds) {
  const out = new Map()
  for (const feed of feeds) {
    const lotNames = [...new Set(experiences.map(e => e.lot))].sort()
    const rows = []
    for (const lot of lotNames) {
      const units = experiences
        .filter(e => e.lot === lot)
        .map(e => unitUnderFeed(e, feed))
      const observed = units.filter(u => u.observed)
      const row = {
        lot,
        feed,
        units: units.map(u => ({
          column: u.column,
          status: u.status,
          eventDay: u.eventDay,
          pending: u.pending,
          observed: u.observed,
        })),
        sampleSize: observed.length,
        failures: observed.filter(u => u.failure !== null).length,
        censored: observed.filter(u => u.failure === null && !u.pending).length,
        pending: observed.filter(u => u.pending).map(u => u.column),
        insufficient: observed
          .filter(u => u.insufficientDays.length > 0 && u.lastComparableDay === 0)
          .map(u => u.column),
        km: [],
        median: { value: null, ci: [null, null], reason: null },
        naiveMeanFailureDays: null,
        naiveWarning: null,
        noReference: false,
        noReferenceReason: null,
        provisional: false,
      }
      if (observed.length === 0) {
        row.noReference = true
        row.noReferenceReason = `料次 ${lot} 在进料 ${feed} 下没有任何可比的运行记录`
      } else {
        // 待查单位既不能计失效也不能计删失，只在样本量与 provisional 中留痕
        const kmUnits = observed.filter(u => !u.pending)
        row.km = kaplanMeier(kmUnits)
        row.median = medianLife(row.km)
        const failDays = kmUnits.filter(u => u.failure !== null).map(u => u.eventDay)
        if (failDays.length) {
          row.naiveMeanFailureDays = failDays.reduce((a, b) => a + b, 0) / failDays.length
          row.naiveWarning =
            '故障记录平均寿命忽略删失与待查，会低估寿命并把同批柱压到同一窗口，禁止用于排程'
        }
        if (row.failures === 0) {
          row.noReference = true
          row.noReferenceReason = `料次 ${lot} 在进料 ${feed} 下样本内无失效，寿命上界/中位无有效参考（仅有删失下界）`
        }
        if (row.pending.length) {
          row.provisional = true
        }
      }
      rows.push(row)
    }
    out.set(feed, rows)
  }
  return out
}

/**
 * 失效依赖簇。
 * - lotClusters：同料次 + 共用进料，同批同时劣化风险在组合层体现；
 * - feedClusters：仅共用进料（不同料次也共享同一入口条件冲击）。
 * 每个簇显式声明簇内观察不独立，组合风险不能按独立事件相乘后重复计保障。
 */
export function dependenceClusters(experiences) {
  const lotClusters = new Map()
  const feedClusters = new Map()
  for (const exp of experiences) {
    for (const feed of exp.feedSeen) {
      const lotKey = `${exp.lot}@${feed}`
      if (!lotClusters.has(lotKey)) {
        lotClusters.set(lotKey, { id: lotKey, lot: exp.lot, feed, columns: [], failed: [] })
      }
      const lc = lotClusters.get(lotKey)
      lc.columns.push(exp.column)
      if (exp.failure && exp.failure.feed === feed) lc.failed.push(exp.column)

      if (!feedClusters.has(feed)) {
        feedClusters.set(feed, { id: `feed:${feed}`, feed, columns: [], lots: [] })
      }
      const fc = feedClusters.get(feed)
      if (!fc.columns.includes(exp.column)) fc.columns.push(exp.column)
      if (!fc.lots.includes(exp.lot)) fc.lots.push(exp.lot)
    }
  }
  const finish = clusters => [...clusters.values()].map(c => ({
    ...c,
    independent: false,
    note: '簇内柱共用进料（同料次还共享装填老化），失效观察相互依赖，不得按独立单元重复计算保障',
  }))
  return { lotClusters: finish(lotClusters), feedClusters: finish(feedClusters) }
}

/**
 * 单柱在给定时间轴上的剩余可用概率 P(T > t0 + horizon | T > t0)，
 * 以及点估计/区间。t0、horizon 均为运行日。
 */
export function remainingLife(kmRows, t0, horizon) {
  const surv = t => {
    let s = 1
    let lo = 1
    let hi = 1
    for (const r of kmRows) {
      if (r.day <= t) {
        s = r.survival
        lo = r.ciLower
        hi = r.ciUpper
      }
    }
    return { point: s, lower: lo, upper: hi }
  }
  const now = surv(t0)
  const future = surv(t0 + horizon)
  if (now.point === 0) {
    return { point: 0, interval: [0, 0], note: '当前时刻生存估计已为 0' }
  }
  const point = future.point / now.point
  const interval = [
    now.lower > 0 ? future.lower / now.lower : 0,
    now.upper > 0 ? Math.min(1, future.upper / now.upper) : 1,
  ]
  return { point, interval, note: null }
}
