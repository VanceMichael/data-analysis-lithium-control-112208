// 寿命分析与换柱排程的主引擎。每次交班后对同一组来源表整体重算，
// 输出带依据、区间与阻塞原因的结构化结果，供计划员签下一个运行周期。

import { validateTables, checkReferences, num } from './parse.js'
import { buildSampleLedger, checkLabSlots } from './sampling.js'
import { parseThresholds, buildExperiences } from './experience.js'
import { compareLots, dependenceClusters } from './life.js'
import { columnRisk, combinedRisk, passesWindowCap } from './risk.js'
import {
  parsePaths, parseWork, evaluateWindow, planScenarios, pendingImpactColumns, committedImpact,
} from './schedule.js'
import {
  parseRules, parseHandoffs, parseStorage, stableReadiness, holdUsage,
  evaluateDelivery, customerBlockers,
} from './product.js'
import { buildDayWindowIndex, queryDay, windowForDay } from './query.js'
import { TASK, PIECE } from './constants.js'

const EXPECTED_COLUMNS = {
  performance: ['column', 'load_lot', 'day', 'feed', 'processed', 'ratio', 'state'],
  lab: ['column', 'day', 'revision', 'ratio', 'state'],
  paths: ['line', 'units', 'capacity', 'backup'],
  work: ['task', 'column', 'period', 'status', 'authority'],
  delivery: ['window', 'min_qty', 'max_combined_risk'],
  thresholds: ['feed', 'min_ratio', 'window_ready'],
  maintenance: ['window', 'crew_slots', 'restart'],
  product_rules: ['customer', 'grade', 'hold_allowed', 'latest', 'minimum'],
  handoffs: ['piece', 'line', 'qty', 'col', 'window', 'condition', 'customer'],
  storage: ['window', 'hold_volume', 'lab_slots'],
}

/**
 * 对一组来源表执行完整分析。纯函数：同样输入得到同样输出，便于交班后重算。
 * @param {Record<string, object[]>} rawTables
 * @param {{operatorRole?: string}} [options]
 */
export function buildAnalysis(rawTables, options = {}) {
  validateTables(rawTables, { columns: EXPECTED_COLUMNS })
  const referenceProblems = checkReferences(rawTables)
  const operatorRole = options.operatorRole ?? '计划员'

  const thresholdMap = parseThresholds(rawTables.thresholds)
  const labLedger = buildSampleLedger(rawTables.lab)
  const experiences = buildExperiences(rawTables.performance, thresholdMap, labLedger)
  const feeds = [...new Set(rawTables.thresholds.map(r => r.feed))].sort()
  const lotTable = compareLots(experiences, feeds)
  const clusters = dependenceClusters(experiences)

  const paths = parsePaths(rawTables.paths)
  const tasks = parseWork(rawTables.work)
  const storageMap = parseStorage(rawTables.storage)
  const rules = parseRules(rawTables.product_rules)
  const pieces = parseHandoffs(rawTables.handoffs)
  const pendingColumns = pendingImpactColumns(experiences)
  const readiness = stableReadiness(experiences, thresholdMap)
  const dayWindowIndex = buildDayWindowIndex(tasks, experiences)

  // 各窗口展望长度（运行日数），由运行日-窗口映射反推；未知窗口默认 1
  const windowHorizon = new Map()
  for (const w of rawTables.maintenance.map(r => r.window)) {
    const days = [...dayWindowIndex.map.values()].filter(x => x === w).length
    windowHorizon.set(w, days || 1)
  }
  const currentDay = Math.max(...experiences.map(e => e.lastObservedDay))

  // 单柱风险与线路组合风险（展望长度取窗口运行日跨度，缺省 1 个运行日）
  const defaultHorizon = Math.max(1, ...windowHorizon.values())
  const columnRiskMap = new Map()
  for (const exp of experiences) {
    columnRiskMap.set(exp.column, columnRisk(lotTable, exp, currentDay, defaultHorizon))
  }
  const lineRisk = paths.map(line => ({
    line: line.line,
    units: line.units,
    backup: line.backup,
    risk: combinedRisk(line.units, columnRiskMap, 'series'),
  }))

  // 窗口排程：施工名额、串联可用性、备用占用
  const scheduleByWindow = new Map()
  const scenarioByWindow = new Map()
  const riskCapByWindow = new Map()
  for (const maint of rawTables.maintenance) {
    const w = maint.window
    const evaluation = evaluateWindow({
      windowName: w,
      paths,
      tasks,
      maintenanceRows: rawTables.maintenance,
      operatorRole,
      labPendingColumns: pendingColumns,
    })
    scheduleByWindow.set(w, evaluation)

    const deliveryRow = rawTables.delivery.find(d => d.window === w)
    const targetLoad = deliveryRow ? num(deliveryRow.min_qty, 'min_qty') : 0
    const candidate = tasks.find(t => t.status === TASK.CANDIDATE && t.window === w) ?? null
    scenarioByWindow.set(w, planScenarios({
      windowName: w,
      paths,
      tasks,
      maintenanceRows: rawTables.maintenance,
      operatorRole,
      labPendingColumns: pendingColumns,
      targetLoad,
      candidateTask: candidate,
    }))
    if (deliveryRow) {
      const cap = num(deliveryRow.max_combined_risk, 'max_combined_risk')
      riskCapByWindow.set(w, {
        cap,
        lines: lineRisk.map(lr => ({ line: lr.line, ...passesWindowCap(lr.risk, cap) })),
      })
    }
  }

  // 化验名额：待检/重检产物 + 待查寿命证据各占名额，同一样本只占一次
  const labDemandByWindow = new Map()
  for (const p of pieces.filter(p => p.condition === PIECE.PENDING_QC || p.condition === PIECE.RECHECK)) {
    const arr = labDemandByWindow.get(p.window) ?? []
    arr.push({ id: p.piece, reason: `产物 ${p.piece}（${p.condition}）` })
    labDemandByWindow.set(p.window, arr)
  }
  for (const col of pendingColumns) {
    for (const [d, w] of dayWindowIndex.map) {
      const exp = experiences.find(e => e.column === col)
      if (exp?.pendingEvidence.includes(d)) {
        const arr = labDemandByWindow.get(w) ?? []
        arr.push({ id: `lab:${col}#${d}`, reason: `${col} 寿命证据待查` })
        labDemandByWindow.set(w, arr)
      }
    }
  }
  const labSlotReport = checkLabSlots(rawTables.storage, labDemandByWindow)

  // 待检容器占用与客户交付
  const holdByWindow = new Map()
  const deliveryByWindow = new Map()
  const blockersByWindow = new Map()
  for (const w of [...storageMap.keys()]) {
    holdByWindow.set(w, holdUsage(w, pieces, storageMap))
    const deliveryEval = evaluateDelivery(pieces, rules, readiness)
    deliveryByWindow.set(w, deliveryEval.filter(d => d.window === w))
    blockersByWindow.set(w, customerBlockers(w, deliveryEval, rules, storageMap.get(w)))
  }

  // 已承诺生产量受当前可用性的影响
  const commitments = pieces
    .filter(p => p.condition !== PIECE.SHIPPED)
    .map(p => ({ line: p.line, customer: p.customer, qty: p.qty, window: p.window }))
  const impactByWindow = new Map()
  for (const [w, evaluation] of scheduleByWindow) {
    impactByWindow.set(w, committedImpact(evaluation, commitments.filter(c => c.window === w)))
  }

  return {
    generatedFrom: rawTables,
    referenceProblems,
    operatorRole,
    currentDay,
    dayWindowIndex: { map: [...dayWindowIndex.map.entries()], note: dayWindowIndex.note },
    labLedger: [...labLedger.values()],
    experiences,
    lotComparison: [...lotTable.entries()].map(([feed, rows]) => ({ feed, lots: rows })),
    dependence: clusters,
    columnRisk: [...columnRiskMap.values()],
    lineRisk,
    schedule: [...scheduleByWindow.entries()].map(([window, evaluation]) => ({ window, ...evaluation })),
    scenarios: [...scenarioByWindow.values()],
    riskCaps: [...riskCapByWindow.entries()].map(([window, v]) => ({ window, ...v })),
    labSlots: labSlotReport,
    hold: [...holdByWindow.values()],
    delivery: [...deliveryByWindow.entries()].map(([window, items]) => ({ window, items })),
    customerBlockers: [...blockersByWindow.entries()].map(([window, rows]) => ({ window, rows })),
    committedImpact: [...impactByWindow.entries()].map(([window, rows]) => ({ window, rows })),
    queryByDay: d => queryDay({
      dayValue: d,
      experiences,
      tasks,
      dayWindowIndex,
      scheduleEvaluation: scheduleByWindow,
      lotTable,
    }),
    windowForDay: d => windowForDay(dayWindowIndex, d),
  }
}
