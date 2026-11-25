// 换柱排程。处理维修任务状态/权限、有限施工窗口、串联同时可用、
// 并联最低能力、共用备用柱冲突，以及"换一根 / 降负荷 / 备用线路"三类方案。
//
// 排程纪律：
// - 已开工换料的柱在该窗口计入不可用；
// - 已签未开工任务只有授权班组能移位，不可移位任务锁定窗口；
// - 同一备用柱同窗只替代一个停用单元，两条方案不能各自把它算成已保障；
// - 新化验使证据待查时，受影响的替代方案重判可用性，并显示对已承诺产量的影响。

import { num, splitJoined } from './parse.js'
import { TASK, AUTHORITY, STATE } from './constants.js'

export function parsePaths(pathRows) {
  return pathRows.map(row => ({
    line: row.line,
    units: splitJoined(row.units),
    capacity: num(row.capacity, 'capacity'),
    backup: row.backup || null,
  }))
}

export function parseWork(workRows) {
  return workRows.map(row => ({
    task: row.task,
    column: row.column,
    window: row.period,
    status: row.status,
    authority: row.authority,
  }))
}

/**
 * 判断已签未开工任务能否在给定操作者权限下移到目标窗口。
 * @returns {{movable:boolean, reason:string}}
 */
export function canMoveTask(task, operatorRole, targetWindow) {
  if (task.status === TASK.STARTED) {
    return { movable: false, reason: '已开工换料，窗口内不可用，不能移位' }
  }
  if (task.authority === AUTHORITY.IMMOVABLE) {
    return { movable: false, reason: '任务标记为不可移位' }
  }
  if (task.window === targetWindow) {
    return { movable: true, reason: '目标窗口即已签窗口，无需移位' }
  }
  // 已签任务的移位权限保守处理：只有任务上注明的授权班组可移位
  if (operatorRole !== task.authority) {
    return {
      movable: false,
      reason: `任务由${task.authority}签发，操作者(${operatorRole ?? '无权限'})不能移位，需${task.authority}确认`,
    }
  }
  return { movable: true, reason: `${operatorRole}有权移位该已签任务` }
}

/**
 * 窗口内柱可用性：返回 unavailable 集合与原因。
 * 已开工换料直接锁柱；已签未开工任务在未取得授权移位确认前同样锁柱，
 * 但通过 movableBlockers 显式给出移位条件，计划员可凭班组权限重判。
 */
export function windowAvailability(tasks, windowName, operatorRole, targetWindowOverride = null) {
  const unavailable = new Map() // column -> reasons[]
  const movableBlockers = []
  for (const task of tasks) {
    const addReason = (s) => {
      const arr = unavailable.get(task.column) ?? []
      arr.push(s)
      unavailable.set(task.column, arr)
    }
    if (task.status === TASK.STARTED && task.window === windowName) {
      addReason(`${task.task} 已开工换料，本窗口不可用`)
    } else if (task.status === TASK.SIGNED && task.window === windowName) {
      const decision = canMoveTask(task, operatorRole, targetWindowOverride ?? windowName)
      addReason(`${task.task} 已签未开工：${decision.movable ? '本窗口按计划停用，移位需' + task.authority + '确认' : decision.reason}`)
      if (!decision.movable) {
        movableBlockers.push({ task: task.task, column: task.column, reason: decision.reason })
      } else {
        movableBlockers.push({
          task: task.task,
          column: task.column,
          reason: `已签任务计划本窗口停用；若要移位需 ${task.authority} 确认（当前操作者: ${operatorRole}）`,
        })
      }
    } else if (task.status === TASK.CANDIDATE && task.window === windowName) {
      // 候选任务尚未签，不直接锁柱，但要在方案里显式选择
    }
  }
  return { unavailable, movableBlockers }
}

function availableCapacity(line, unavailable, backupUsage, labPendingColumns) {
  const down = line.units.filter(c => unavailable.has(c))
  const unitStatus = line.units.map(c => ({
    column: c,
    up: !unavailable.has(c),
    reasons: unavailable.get(c) ?? [],
    evidencePending: labPendingColumns.has(c),
  }))
  // 串联：任一单元停用且无备用替代 → 整条不可用
  if (down.length === 0) {
    return {
      line: line.line,
      usable: true,
      capacity: line.capacity,
      mode: '正常串联',
      backupUsed: null,
      unitStatus,
      blockers: [],
    }
  }
  const blockers = []
  if (down.length > 1) {
    blockers.push(`串联单元 ${down.join('、')} 同时停用，单根备用柱无法替代多个单元`)
    return { line: line.line, usable: false, capacity: 0, mode: '不可用', backupUsed: null, unitStatus, blockers }
  }
  const [onlyDown] = down
  if (!line.backup) {
    blockers.push(`单元 ${onlyDown} 停用且线路无备用柱`)
    return { line: line.line, usable: false, capacity: 0, mode: '不可用', backupUsed: null, unitStatus, blockers }
  }
  if (unavailable.has(line.backup)) {
    blockers.push(`备用柱 ${line.backup} 自身不可用: ${(unavailable.get(line.backup) ?? []).join('；')}`)
    return { line: line.line, usable: false, capacity: 0, mode: '不可用', backupUsed: null, unitStatus, blockers }
  }
  const holder = backupUsage.get(line.backup)
  if (holder && holder !== line.line) {
    blockers.push(`共用备用柱 ${line.backup} 同窗已被线路 ${holder} 占用，不能重复计保障`)
    return { line: line.line, usable: false, capacity: 0, mode: '备用冲突', backupUsed: null, unitStatus, blockers }
  }
  backupUsage.set(line.backup, line.line)
  return {
    line: line.line,
    usable: true,
    // 备用只替代停用单元，不能增加原线路上限
    capacity: line.capacity,
    mode: `备用 ${line.backup} 替代 ${onlyDown}`,
    backupUsed: line.backup,
    unitStatus,
    blockers: [],
  }
}

/**
 * 评估一个窗口下的全部线路能力。
 * @param options.signedAsUnavailable 已签但未确认移位的任务是否锁柱（默认 true）
 */
export function evaluateWindow({
  windowName,
  paths,
  tasks,
  maintenanceRows,
  operatorRole,
  labPendingColumns,
  extraCandidates = [],
}) {
  const slotsRow = maintenanceRows.find(r => r.window === windowName)
  const crewSlots = slotsRow ? num(slotsRow.crew_slots, 'crew_slots') : 0
  const effectiveTasks = [...tasks, ...extraCandidates]
  const { unavailable, movableBlockers } = windowAvailability(effectiveTasks, windowName, operatorRole)
  const backupUsage = new Map()
  const lines = paths.map(line => availableCapacity(line, unavailable, backupUsage, labPendingColumns))
  const startedInWindow = tasks.filter(t => t.status === TASK.STARTED && t.window === windowName).length
  return {
    window: windowName,
    crewSlots,
    crewUsed: startedInWindow,
    crewFree: Math.max(0, crewSlots - startedInWindow),
    unavailableColumns: [...unavailable.entries()].map(([column, reasons]) => ({ column, reasons })),
    movableBlockers,
    lines,
    totalParallelCapacity: lines.reduce((s, l) => s + (l.usable ? l.capacity : 0), 0),
    backupUsage: [...backupUsage.entries()].map(([backup, line]) => ({ backup, line })),
  }
}

/**
 * 三类值班方案的并列比较：换一根 / 降负荷 / 改用备用线路。
 * 共用备用柱的方案在同一比较中只能出现一次占用。
 */
export function planScenarios({
  windowName,
  paths,
  tasks,
  maintenanceRows,
  operatorRole,
  labPendingColumns,
  targetLoad,
  candidateTask,
}) {
  const base = evaluateWindow({ windowName, paths, tasks, maintenanceRows, operatorRole, labPendingColumns })
  const scenarios = []

  // 方案一：换一根（在窗口内执行候选换料，受施工名额与权限约束）
  const slot = maintenanceRows.find(r => r.window === windowName)
  const moveDecision = candidateTask
    ? canMoveTask(
        { ...candidateTask, status: candidateTask.status ?? TASK.CANDIDATE },
        operatorRole,
        windowName,
      )
    : null
  const replacement = (() => {
    if (!candidateTask) return null
    if (candidateTask.window !== windowName && !moveDecision?.movable) {
      return { feasible: false, blockers: [moveDecision.reason] }
    }
    if (base.crewFree < 1 && candidateTask.status !== TASK.STARTED) {
      return { feasible: false, blockers: [`窗口 ${windowName} 施工名额已满（${base.crewSlots} 个）`] }
    }
    const withSwap = evaluateWindow({
      windowName,
      paths,
      tasks,
      maintenanceRows,
      operatorRole,
      labPendingColumns,
      extraCandidates: [{ ...candidateTask, status: TASK.STARTED }],
    })
    return {
      feasible: withSwap.lines.every(l => l.blockers.length === 0),
      blockers: withSwap.lines.flatMap(l => l.blockers),
      capacity: withSwap.totalParallelCapacity,
      restart: slot?.restart ?? null,
      detail: withSwap,
    }
  })()
  scenarios.push({
    id: '换一根',
    feasible: replacement?.feasible ?? false,
    capacity: replacement?.capacity ?? 0,
    meetsLoad: (replacement?.capacity ?? 0) >= targetLoad,
    blockers: replacement?.blockers ?? ['无候选换料任务'],
    restartNote: slot ? `复启规则: ${slot.restart}` : null,
  })

  // 方案二：降负荷（不换料，只取当前可用能力）
  const reduced = {
    id: '降负荷',
    feasible: base.lines.some(l => l.usable),
    capacity: base.totalParallelCapacity,
    meetsLoad: base.totalParallelCapacity >= targetLoad,
    blockers: base.lines.flatMap(l => l.blockers),
    loadCut: Math.max(0, targetLoad - base.totalParallelCapacity),
  }
  scenarios.push(reduced)

  // 方案三：改用备用线路（不增加新施工，依赖备用柱替代）
  const backupLines = base.lines.filter(l => l.backupUsed)
  const conflict = base.lines.find(l => l.mode === '备用冲突')
  scenarios.push({
    id: '改用备用线路',
    feasible: backupLines.length > 0 && !conflict,
    capacity: base.lines.reduce((s, l) => s + (l.usable ? l.capacity : 0), 0),
    meetsLoad: base.totalParallelCapacity >= targetLoad,
    backupUsed: backupLines.map(l => ({ line: l.line, backup: l.backupUsed })),
    blockers: conflict
      ? conflict.blockers
      : backupLines.length === 0
        ? ['当前没有需要备用替代的停用单元，备用方案不适用']
        : [],
    note: '同一备用柱同窗只替代一个单元，两条线路不能各自计为已保障',
  })

  return { window: windowName, targetLoad, base, scenarios }
}

/** 受待查化验影响的柱：证据挂起时其所在线路的替代方案必须重判。 */
export function pendingImpactColumns(experiences) {
  const set = new Set()
  for (const exp of experiences) {
    if (exp.pendingEvidence.length) set.add(exp.column)
  }
  return set
}

/** 已承诺生产量在某窗口评估下的缺口（用于显示新化验/方案变化的影响）。 */
export function committedImpact(evaluation, commitments) {
  return commitments.map(c => {
    const line = evaluation.lines.find(l => l.line === c.line)
    const available = line?.usable ? line.capacity : 0
    return {
      window: evaluation.window,
      line: c.line,
      customer: c.customer,
      committed: c.qty,
      available,
      shortfall: Math.max(0, c.qty - available),
      deliverable: available >= c.qty,
      reasons: line ? line.blockers : ['线路不存在'],
    }
  })
}

export { STATE }
