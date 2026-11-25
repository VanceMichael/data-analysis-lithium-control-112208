// 按料次（柱+装填批次）形成实际运行经历，区分运行、旁路、停机和拆装，
// 并依据入口条件（进料）、处理量与取样变化判定每个运行日的寿命证据。
//
// 关键纪律：
// - 只有"运行"状态下的有效读数参与寿命比较；旁路读数只作参考，不计磨损。
// - 化验有效则以化验值为准；化验未生效时证据待查，不能直接判越界。
// - 计划拆除是删失（不知道自然失效时间），不是失效事件。
// - 换低浓度卤水后的"好转"读数因进料入口条件不同而不可与原进料直接比较。

import { num, day, isMissing } from './parse.js'
import { STATE, EVIDENCE } from './constants.js'

export function parseThresholds(thresholdRows) {
  const map = new Map()
  for (const row of thresholdRows) {
    map.set(row.feed, {
      feed: row.feed,
      minRatio: num(row.min_ratio, 'min_ratio'),
      windowReady: num(row.window_ready, 'window_ready'),
    })
  }
  return map
}

/**
 * 构建全部柱的料次运行经历。
 * @param {Array} performanceRows 原始 performance 表
 * @param {Map<string, any>} thresholdMap parseThresholds 的结果
 * @param {Map<string, any>} labLedger buildSampleLedger 的结果
 */
export function buildExperiences(performanceRows, thresholdMap, labLedger) {
  const groups = new Map()
  for (const row of performanceRows) {
    const key = `${row.column}#${row.load_lot}`
    if (!groups.has(key)) {
      groups.set(key, {
        column: row.column,
        lot: row.load_lot,
        records: [],
        feedSegments: [],
      })
    }
    groups.get(key).records.push(row)
  }

  const experiences = []
  for (const g of groups.values()) {
    g.records.sort((a, b) => day(a.day) - day(b.day))
    const exp = {
      column: g.column,
      lot: g.lot,
      days: [],
      runDays: 0,
      bypassDays: 0,
      stopDays: 0,
      installDays: 0,
      throughput: 0, // 仅累计"运行"日的归一处理量
      feedSeen: [],
      feedChangeDays: [],
      failure: null, // 最早确认越界
      pendingEvidence: [], // 待查的运行日
      insufficientWindows: [], // 取样不足时间窗
      plannedRemovalDay: null,
      lastObservedDay: 0,
      comparableRecordKeys: [], // 可比性能记录（同进料、运行、有效读数）
    }
    let lastFeed = null
    for (const row of g.records) {
      const d = day(row.day)
      const processed = isMissing(row.processed) ? null : num(row.processed, 'processed')
      const rawRatio = isMissing(row.ratio) ? null : num(row.ratio, 'ratio')
      const lab = labLedger.get(`${row.column}#${d}`) ?? null
      const labPending = lab !== null && !lab.effective
      // 有效化验是权威读数：即便当日运行记录缺测，也以化验值作为该日证据
      const effectiveRatio = lab?.effective
        ? lab.latestRatio
        : labPending
          ? null
          : row.state === STATE.RUN && rawRatio !== null
            ? rawRatio
            : null
      const threshold = thresholdMap.get(row.feed)?.minRatio ?? null

      const entry = {
        column: row.column,
        lot: row.load_lot,
        day: d,
        feed: row.feed,
        state: row.state,
        processed,
        rawRatio,
        lab,
        labPending,
        effectiveRatio,
        threshold,
        evidence: null,
        comparable: false,
        wear: false, // 该日是否计入磨损暴露
      }

      // 有效化验可把缺测/停机日补救为有证据日（不计磨损，但形成寿命证据）
      const labRescues = lab?.effective && row.state !== STATE.RUN && row.state !== STATE.BYPASS
      if (labRescues) {
        if (threshold !== null && effectiveRatio < threshold) {
          entry.evidence = EVIDENCE.BREACH
          if (!exp.failure) {
            exp.failure = { day: d, ratio: effectiveRatio, threshold, feed: row.feed, source: '化验有效' }
          }
        } else {
          entry.evidence = EVIDENCE.OK
        }
        entry.comparable = true
      }

      switch (row.state) {
        case STATE.RUN: {
          exp.runDays += 1
          if (processed !== null) exp.throughput += processed
          entry.wear = true
          if (labPending) {
            entry.evidence = EVIDENCE.PENDING
            exp.pendingEvidence.push(d)
          } else if (effectiveRatio === null) {
            entry.evidence = EVIDENCE.INSUFFICIENT
            exp.insufficientWindows.push({ day: d, reason: '运行日无有效读数（缺测）' })
          } else if (threshold !== null && effectiveRatio < threshold) {
            entry.evidence = EVIDENCE.BREACH
            if (!exp.failure) {
              exp.failure = {
                day: d,
                ratio: effectiveRatio,
                threshold,
                feed: row.feed,
                source: lab?.effective ? '化验有效' : '运行记录',
              }
            }
          } else {
            entry.evidence = EVIDENCE.OK
          }
          // 可比记录：运行 + 有效读数 + 非待查（进料分组在寿命分析里再按 feed 切分）
          if (effectiveRatio !== null && !labPending) entry.comparable = true
          break
        }
        case STATE.BYPASS: {
          exp.bypassDays += 1
          entry.evidence = EVIDENCE.NON_RUN
          break
        }
        case STATE.STOP:
        case STATE.MISSING: {
          exp.stopDays += 1
          if (!labRescues) {
            entry.evidence = EVIDENCE.INSUFFICIENT
            exp.insufficientWindows.push({ day: d, reason: `${row.state}，无可用性能记录` })
          }
          break
        }
        case STATE.PLANNED_REMOVAL:
        case STATE.REMOVED:
        case STATE.INSTALLED: {
          exp.installDays += 1
          if (row.state === STATE.PLANNED_REMOVAL) {
            entry.evidence = EVIDENCE.PLANNED
            exp.plannedRemovalDay = d
          } else {
            entry.evidence = EVIDENCE.INSUFFICIENT
          }
          break
        }
        default: {
          entry.evidence = EVIDENCE.INSUFFICIENT
          exp.insufficientWindows.push({ day: d, reason: `未知状态 ${row.state}` })
        }
      }

      if (entry.comparable) {
        exp.comparableRecordKeys.push(`${row.column}#${d}`)
        if (!exp.feedSeen.includes(row.feed)) exp.feedSeen.push(row.feed)
      }
      if (lastFeed !== null && row.feed !== lastFeed) {
        exp.feedChangeDays.push({ from: lastFeed, to: row.feed, day: d, state: row.state })
      }
      lastFeed = row.feed
      exp.days.push(entry)
      exp.lastObservedDay = Math.max(exp.lastObservedDay, d)
    }

    exp.feedSegments = buildFeedSegments(exp.days)
    exp.censored = censorInfo(exp)
    experiences.push(exp)
  }
  return experiences
}

function buildFeedSegments(days) {
  const segments = []
  for (const d of days) {
    const last = segments[segments.length - 1]
    if (!last || last.feed !== d.feed) {
      segments.push({ feed: d.feed, startDay: d.day, endDay: d.day, states: [d.state] })
    } else {
      last.endDay = d.day
      if (!last.states.includes(d.state)) last.states.push(d.state)
    }
  }
  return segments
}

function censorInfo(exp) {
  if (exp.failure) {
    return { kind: '失效', atDay: exp.failure.day, reason: '有效读数越过进料阈值' }
  }
  if (exp.plannedRemovalDay !== null) {
    return {
      kind: '删失',
      atDay: exp.plannedRemovalDay,
      reason: EVIDENCE.PLANNED,
    }
  }
  if (exp.pendingEvidence.length) {
    return { kind: '待查', atDay: exp.lastObservedDay, reason: '存在未生效化验，寿命证据挂起' }
  }
  return { kind: '删失', atDay: exp.lastObservedDay, reason: '观察期末仍在役（右删失）' }
}
