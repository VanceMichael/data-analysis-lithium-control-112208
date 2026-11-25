// 下游验收与产品交接。
//
// 规则要点：
// - 稳定品级要求来源柱在取料窗口有可比的有效读数（thresholds.window_ready
//   个窗口的稳定读数）；新装填柱未取得首批稳定读数前只能算待检量。
// - 待检量物理上占用 hold_volume 容器与 lab_slots 化验名额：
//   不能一边留给允许待检的客户，一边又按连续可用量出给只收稳定量的客户。
// - 化验改判（重检 -> 有效/否决）可让待检批转可交或降级；
//   已发货批次不收回，但保留原签发依据并登记应补沟通。
// - 紧缺时按客户 latest 等待时限与 minimum 阻塞关系输出谁会被卡住。

import { num } from './parse.js'
import { PIECE, GRADE, EVIDENCE } from './constants.js'

export function parseRules(ruleRows) {
  return ruleRows.map(r => ({
    customer: r.customer,
    grade: r.grade,
    holdAllowed: r.hold_allowed === 'yes',
    latest: r.latest,
    minimum: num(r.minimum, 'minimum'),
  }))
}

export function parseHandoffs(rows) {
  return rows.map(r => ({
    piece: r.piece,
    line: r.line,
    qty: num(r.qty, 'qty'),
    col: r.col,
    window: r.window,
    condition: r.condition,
    customer: r.customer,
  }))
}

export function parseStorage(rows) {
  return new Map(rows.map(r => [r.window, {
    window: r.window,
    holdVolume: num(r.hold_volume, 'hold_volume'),
    labSlots: num(r.lab_slots, 'lab_slots'),
  }]))
}

/**
 * 柱在某窗口是否已取得首批稳定读数。
 * 以 thresholds.window_ready 为所需连续可比有效读数的窗口/运行日数。
 */
export function stableReadiness(experiences, thresholdMap) {
  const result = new Map()
  for (const exp of experiences) {
    const readyDays = []
    const pendingDays = []
    for (const d of exp.days) {
      if (d.evidence === EVIDENCE.OK) readyDays.push(d.day)
      if (d.evidence === EVIDENCE.PENDING) pendingDays.push(d.day)
    }
    const needed = thresholdMap.get(exp.feedSeen[0] ?? 'A')?.windowReady ?? 1
    const ready = readyDays.length >= needed
    result.set(exp.column, {
      column: exp.column,
      lot: exp.lot,
      ready,
      readyDays,
      pendingDays,
      needed,
      reason: ready
        ? `已有 ${readyDays.length} 个有效稳定读数（要求 ${needed}）`
        : pendingDays.length
          ? '化验待查，首批稳定读数未确认'
          : '新装填/有效读数不足，只能产出待检量',
    })
  }
  return result
}

/** 窗口内待检量的容器与化验名额占用。同一件产品只占一次。 */
export function holdUsage(windowName, pieces, storageMap) {
  const holding = pieces.filter(p => p.window === windowName &&
    (p.condition === PIECE.PENDING_QC || p.condition === PIECE.RECHECK))
  const volume = holding.reduce((s, p) => s + p.qty, 0)
  const limit = storageMap.get(windowName)
  return {
    window: windowName,
    holders: holding.map(p => ({ piece: p.piece, qty: p.qty, condition: p.condition, customer: p.customer })),
    holdVolumeUsed: volume,
    holdVolumeLimit: limit?.holdVolume ?? null,
    overHold: limit ? volume > limit.holdVolume : false,
    labDemands: holding.length,
    labSlots: limit?.labSlots ?? null,
    overLab: limit ? holding.length > limit.labSlots : false,
  }
}

/**
 * 按客户规则评估每件产品的可交状态。
 * 待检量被物理占用的事实在这里强制：待检件不能计入稳定品级供给。
 */
export function evaluateDelivery(pieces, rules, readiness, overrides = new Map()) {
  const ruleMap = new Map(rules.map(r => [r.customer, r]))
  return pieces.map(p => {
    const rule = ruleMap.get(p.customer)
    const override = overrides.get(p.piece) // 化验改判 {newCondition, newGrade?, basis, communication}
    const condition = override?.newCondition ?? p.condition
    const ready = readiness.get(p.col)
    const base = {
      piece: p.piece,
      customer: p.customer,
      line: p.line,
      col: p.col,
      window: p.window,
      qty: p.qty,
      originalCondition: p.condition,
      condition,
      grade: null,
      acceptable: false,
      blocking: [],
      originalBasis: null,
      communication: override?.communication ?? null,
    }
    if (p.condition === PIECE.SHIPPED) {
      // 已发货：保留原签发依据，不可假定收回
      return {
        ...base,
        grade: GRADE.STABLE,
        acceptable: true,
        originalBasis: `原签发依据：${p.piece} 于 ${p.window} 按已发状态签给 ${p.customer}，物料不可假定收回`,
      }
    }
    if (!rule) {
      return { ...base, blocking: ['缺少客户验收规则'] }
    }
    if (rule.grade === GRADE.STABLE) {
      if (condition === PIECE.PENDING_QC || condition === PIECE.RECHECK) {
        return {
          ...base,
          grade: GRADE.PENDING,
          blocking: [`${p.customer} 只收稳定量，待检/重检量已物理占用，不能按连续可用出货`],
        }
      }
      if (!ready?.ready) {
        return { ...base, grade: GRADE.STABLE, blocking: [ready?.reason ?? '来源柱未稳定'] }
      }
      return { ...base, grade: GRADE.STABLE, acceptable: true }
    }
    // 待检品级客户
    if (!rule.holdAllowed) {
      return { ...base, grade: GRADE.PENDING, blocking: ['客户不接受待检留量'] }
    }
    if (condition === PIECE.PENDING_QC || condition === PIECE.RECHECK) {
      return {
        ...base,
        grade: GRADE.PENDING,
        acceptable: true,
        note: '待检量占用容器与下一次取样名额，不可再计入稳定供给',
      }
    }
    return { ...base, grade: GRADE.STABLE, acceptable: true }
  })
}

/**
 * 化验改判登记。返回新的 overrides 映射与改判后果说明。
 * 已发货件允许登记补沟通，但条件不可改为可收回。
 */
export function applyLabVerdict(pieces, currentOverrides, verdict) {
  const overrides = new Map(currentOverrides)
  const piece = pieces.find(p => p.piece === verdict.piece)
  if (!piece) throw new Error(`未知产品件 ${verdict.piece}`)
  if (piece.condition === PIECE.SHIPPED) {
    overrides.set(verdict.piece, {
      ...(overrides.get(verdict.piece) ?? {}),
      newCondition: PIECE.SHIPPED,
      basis: verdict.basis,
      communication: verdict.communication ?? '已发货，仅登记应补沟通，物料不收回',
    })
    return { overrides, effect: 'shipped-communication-only' }
  }
  const map = {
    转可交: { newCondition: PIECE.ISSUED, effect: '待检批转为可交，释放为稳定品级供给（仍占用当窗化验名额直至结案）' },
    降级: { newCondition: PIECE.RECHECK, effect: '稳定可信度不足，转待检/重检，停止按稳定量出货' },
    否决: { newCondition: '否决', effect: '该批不可交付，容器仍占用至处置完成' },
  }
  const m = map[verdict.decision]
  if (!m) throw new Error(`未知化验改判: ${verdict.decision}`)
  overrides.set(verdict.piece, {
    newCondition: m.newCondition,
    basis: verdict.basis,
    communication: verdict.communication ?? null,
  })
  return { overrides, effect: m.effect }
}

/** 紧缺时的客户承诺阻塞：按 latest 时限与 minimum 给出排序与阻塞链。 */
export function customerBlockers(windowName, deliveryEval, rules, storageLimit) {
  const rows = []
  for (const rule of rules) {
    const items = deliveryEval.filter(d => d.customer === rule.customer)
    const acceptableQty = items.filter(d => d.acceptable).reduce((s, d) => s + d.qty, 0)
    const waitingOn = items
      .filter(d => !d.acceptable)
      .map(d => ({ piece: d.piece, reasons: d.blocking }))
    rows.push({
      customer: rule.customer,
      window: windowName,
      grade: rule.grade,
      latest: rule.latest,
      minimum: rule.minimum,
      acceptableQty,
      meetsMinimum: acceptableQty >= rule.minimum,
      waitingOn,
      blocks: rule.latest === windowName && acceptableQty < rule.minimum
        ? [`等待时限 ${rule.latest} 已到，可交量 ${acceptableQty} < 最低 ${rule.minimum}；等待结果: ${waitingOn.map(w => w.piece).join('、') || '无在途批'}`]
        : acceptableQty < rule.minimum
          ? [`可交量 ${acceptableQty} < 最低 ${rule.minimum}，等待: ${waitingOn.map(w => w.piece).join('、') || '无在途批'}`]
          : [],
    })
  }
  // 时限越近越先阻塞
  rows.sort((a, b) => (a.latest === windowName ? -1 : 1) - (b.latest === windowName ? -1 : 1))
  return rows
}
