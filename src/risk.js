// 组合风险。失效依赖（同料次、共用进料）意味着不能把多根柱当独立事件
// 相乘：串联线路的"同时可用"风险取保守上界，并联线路给出 Fréchet 边界。
// 交付窗 max_combined_risk 用区间上界判定，避免低估同批同时劣化。

import { remainingLife } from './life.js'

/**
 * 单柱在 [t0, t0+horizon] 内的失效概率与证据状态。
 * @param {Map} lotTable feed -> compareLots 的料次行
 * @param {object} exp 运行经历
 * @param {number} t0 当前运行日
 * @param {number} horizon 展望运行日数
 */
export function columnRisk(lotTable, exp, t0, horizon) {
  const feed = exp.failure?.feed ?? exp.feedSeen[0] ?? null
  const lotRow = feed ? (lotTable.get(feed) ?? []).find(r => r.lot === exp.lot) : null
  const base = {
    column: exp.column,
    lot: exp.lot,
    feed,
    horizon,
    fromDay: t0,
    toDay: t0 + horizon,
    noReference: false,
    provisional: false,
    reasons: [],
  }
  if (exp.pendingEvidence.length) {
    return {
      ...base,
      point: null,
      interval: [null, null],
      noReference: false,
      provisional: true,
      reasons: ['化验未生效，寿命证据待查'],
    }
  }
  if (!lotRow || lotRow.noReference || lotRow.km.length === 0) {
    return {
      ...base,
      point: null,
      interval: [null, null],
      noReference: true,
      reasons: [lotRow?.noReferenceReason ?? '该进料下无有效寿命参考'],
    }
  }
  const r = remainingLife(lotRow.km, t0, horizon)
  const failPoint = 1 - r.point
  const failInterval = r.interval[0] === null
    ? [null, null]
    : [1 - r.interval[1], 1 - r.interval[0]]
  return {
    ...base,
    point: round(failPoint),
    interval: failInterval.map(round),
    provisional: lotRow.provisional,
    reasons: lotRow.sampleSize < 3 ? [`参考样本仅 ${lotRow.sampleSize} 个单位，区间较宽`] : [],
  }
}

/**
 * 线路组合风险。
 * 串联 units：全部同时可用才行；在正相关（同批/共用进料）下，
 * 联合失效上界取单柱最大，下界取 max(0, sum-1)。
 * 并联线路：给出系统失效的 Fréchet 边界，下限=max p_i，上限=min(1, sum p_i)。
 * 缺失参考的柱会让区间无法闭合，返回 noReference 与原因。
 */
export function combinedRisk(lineColumns, columnRiskMap, mode) {
  const risks = lineColumns.map(c => columnRiskMap.get(c)).filter(Boolean)
  const missing = lineColumns.filter(c => {
    const r = columnRiskMap.get(c)
    return !r || r.noReference || r.interval[0] === null
  })
  const valid = risks.filter(r => r.interval[0] !== null)
  if (valid.length === 0) {
    return {
      mode,
      point: null,
      interval: [null, null],
      noReference: true,
      provisional: risks.some(r => r.provisional),
      reasons: missing.length
        ? [`无有效参考的柱: ${missing.join(', ')}`]
        : ['线路内没有可估计风险的柱'],
    }
  }
  const upperVals = valid.map(r => r.interval[1])
  const lowerVals = valid.map(r => r.interval[0])
  let interval
  if (mode === 'series') {
    // P(任一失效) 在完全正相关时取 max；独立下界 Fréchet: max(0, Σp-1)
    interval = [
      Math.max(0, lowerVals.reduce((a, b) => a + b, 0) - (valid.length - 1)),
      Math.max(...upperVals),
    ]
  } else {
    interval = [Math.max(...lowerVals), Math.min(1, upperVals.reduce((a, b) => a + b, 0))]
  }
  return {
    mode,
    point: round(interval[1]), // 保守点估计取上界
    interval: interval.map(round),
    noReference: missing.length > 0,
    provisional: risks.some(r => r.provisional),
    reasons: missing.length
      ? [`部分柱无有效参考（${missing.join(', ')}），区间只覆盖可估计单元，需人工补证`]
      : [],
  }
}

export function passesWindowCap(risk, cap) {
  if (risk.noReference || risk.interval[1] === null) {
    return { pass: false, why: '风险区间无法闭合，不能证明满足交付窗风险上限' }
  }
  return {
    pass: risk.interval[1] <= cap,
    why: risk.interval[1] <= cap
      ? `区间上界 ${risk.interval[1]} ≤ 上限 ${cap}`
      : `区间上界 ${risk.interval[1]} > 上限 ${cap}`,
  }
}

function round(x) {
  return Math.round(x * 10000) / 10000
}
