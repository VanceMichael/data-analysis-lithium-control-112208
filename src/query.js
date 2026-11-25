// 按运行日查询：候选任务、已签窗口、实测依据，并把问题显式分成
// 风险确实上升、缺乏证据、根本安排不下三类，避免互相混淆。

import { TASK, RISK_KIND, EVIDENCE } from './constants.js'
import { day } from './parse.js'

/**
 * 运行日 -> 窗口的映射约定。
 * 资料中 performance 用运行日、work/maintenance 用窗口编号，且未给出日历对照，
 * 因此采用显式、可复核的约定：以"计划拆除日 + 该任务窗口"为锚点，
 * 锚点日及其之前的运行日都落在锚点窗口（拆料当日仍属当前施工窗口），
 * 之后每 anchor 个运行日滚动进入下一窗口。所有窗口的日跨度相同，便于重算。
 */
export function buildDayWindowIndex(tasks, experiences, anchorDay = null) {
  const planned = experiences
    .filter(e => e.plannedRemovalDay !== null)
    .map(e => e.plannedRemovalDay)
  const anchor = anchorDay ?? (planned.length ? Math.max(...planned) : null)
  const anchorWindow = tasks.find(t => t.status === TASK.STARTED || t.status === TASK.SIGNED)?.window ?? null
  if (anchor === null || !anchorWindow) {
    return { map: new Map(), anchor: null, anchorWindow: null, note: '缺少锚点，无法建立运行日-窗口映射' }
  }
  const windowNum = Number(anchorWindow.slice(1))
  const map = new Map()
  const maxDay = Math.max(...experiences.map(e => e.lastObservedDay), anchor)
  for (let d = 1; d <= maxDay + anchor; d += 1) {
    const offset = d <= anchor ? 0 : Math.floor((d - anchor - 1) / anchor) + 1
    map.set(d, `W${windowNum + offset}`)
  }
  return {
    map,
    anchor,
    anchorWindow,
    note: `约定：运行日 ${anchor}（计划拆除日）及其之前锚定 ${anchorWindow}，之后每 ${anchor} 个运行日滚动一窗`,
  }
}

export function windowForDay(index, d) {
  return index.map.get(day(String(d))) ?? null
}

/**
 * 单柱单日的证据三分类。
 * - 风险确实上升：有效越界，或同料次已有失效；
 * - 缺乏证据：待查/取样不足/无参考；
 * - 根本安排不下：由排程硬约束另行补充（见 queryDay 的 scheduleFindings）。
 */
export function classifyEvidence(exp, dayValue, lotFindings) {
  const entry = exp.days.find(d => d.day === dayValue)
  const findings = []
  if (!entry) {
    findings.push({ kind: RISK_KIND.NO_EVIDENCE, text: `${exp.column} 在运行日 ${dayValue} 无记录` })
    return findings
  }
  switch (entry.evidence) {
    case EVIDENCE.BREACH:
      findings.push({
        kind: RISK_KIND.RISING,
        text: `${exp.column} 读数 ${entry.effectiveRatio} 低于进料 ${entry.feed} 阈值 ${entry.threshold}`,
      })
      break
    case EVIDENCE.PENDING:
      findings.push({ kind: RISK_KIND.NO_EVIDENCE, text: `${exp.column} 化验未生效，证据待查（revision ${entry.lab.latestRevision}）` })
      break
    case EVIDENCE.INSUFFICIENT:
      findings.push({ kind: RISK_KIND.NO_EVIDENCE, text: `${exp.column} 取样不足（${entry.state}），该时间窗不构成寿命证据` })
      break
    case EVIDENCE.PLANNED:
      findings.push({ kind: RISK_KIND.NO_EVIDENCE, text: `${exp.column} 计划拆除，属删失而非自然失效` })
      break
    case EVIDENCE.NON_RUN:
      findings.push({ kind: RISK_KIND.NO_EVIDENCE, text: `${exp.column} 旁路运行，读数不参与寿命比较` })
      break
    default:
      if (lotFindings?.get(exp.lot)?.clusterFailure) {
        findings.push({ kind: RISK_KIND.RISING, text: `同料次 ${exp.lot} 已出现失效，组合层同时劣化风险上升` })
      }
  }
  return findings
}

/**
 * 计划员按运行日查询的总入口。
 * @returns 候选、已签窗口、实测依据、三类风险与硬约束冲突
 */
export function queryDay({
  dayValue,
  experiences,
  tasks,
  dayWindowIndex,
  scheduleEvaluation,
  lotTable,
  feed,
}) {
  const windowName = windowForDay(dayWindowIndex, dayValue)
  const lotFindings = new Map()
  for (const [f, rows] of lotTable) {
    if (feed && f !== feed) continue
    for (const row of rows) {
      lotFindings.set(row.lot, {
        clusterFailure: row.failures > 0,
        noReference: row.noReference,
        reason: row.noReferenceReason,
        provisional: row.provisional,
      })
    }
  }
  const columnFindings = experiences.map(exp => ({
    column: exp.column,
    lot: exp.lot,
    findings: classifyEvidence(exp, dayValue, lotFindings),
  }))

  const candidates = tasks.filter(t => t.status === TASK.CANDIDATE)
  const signed = tasks.filter(t => t.status === TASK.SIGNED || t.status === TASK.STARTED)

  const scheduleFindings = []
  const evalForWindow = scheduleEvaluation.get(windowName)
  if (evalForWindow) {
    if (evalForWindow.crewFree === 0) {
      scheduleFindings.push({
        kind: RISK_KIND.NOT_FEASIBLE,
        text: `窗口 ${windowName} 施工名额 ${evalForWindow.crewSlots} 已满，新换料安排不下`,
      })
    }
    for (const line of evalForWindow.lines) {
      for (const blocker of line.blockers) {
        scheduleFindings.push({ kind: RISK_KIND.NOT_FEASIBLE, text: `线路 ${line.line}: ${blocker}` })
      }
    }
    for (const m of evalForWindow.movableBlockers) {
      scheduleFindings.push({ kind: RISK_KIND.NOT_FEASIBLE, text: `${m.column}: ${m.reason}` })
    }
  }

  const groups = {
    [RISK_KIND.RISING]: [],
    [RISK_KIND.NO_EVIDENCE]: [],
    [RISK_KIND.NOT_FEASIBLE]: scheduleFindings,
  }
  for (const cf of columnFindings) {
    for (const f of cf.findings) groups[f.kind].push({ column: cf.column, text: f.text })
  }

  return {
    day: dayValue,
    window: windowName,
    indexNote: dayWindowIndex.note,
    candidates: candidates.map(t => ({ task: t.task, column: t.column, window: t.window, authority: t.authority })),
    signedWindows: signed.map(t => ({ task: t.task, column: t.column, window: t.window, status: t.status, authority: t.authority })),
    measuredBasis: columnFindings,
    findings: groups,
    schedule: evalForWindow ?? null,
  }
}
