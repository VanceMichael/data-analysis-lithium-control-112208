// 来源资料解析。约定：原始资料中数字、日期、标记均为字符串，
// 缺失值统一为 "?"，组合编号用 "+" 分隔。解析层只做类型与引用核对，
// 不做任何业务推断，保证原始值可追溯。

import { MISSING } from './constants.js'

/** 解析数值；"?" 与空串返回 null，其余按 Number 解析，非法值抛错。 */
export function num(value, field = '<unknown>') {
  if (value === MISSING || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`字段 ${field} 的数值无法解析: "${value}"`)
  return n
}

/** 解析整数运行日（资料里的日自换料试运行起计）。 */
export function day(value, field = 'day') {
  const n = num(value, field)
  if (n === null || !Number.isInteger(n) || n < 1) {
    throw new Error(`字段 ${field} 不是合法运行日: "${value}"`)
  }
  return n
}

/** 拆分组合编号，如 "C1+C3" -> ["C1", "C3"]。 */
export function splitJoined(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split('+').map(s => s.trim()).filter(Boolean)
}

export function isMissing(value) {
  return value === MISSING || value === null || value === undefined
}

/**
 * 读取并校验一组来源表。
 * @param {Record<string, Array<Record<string,string>>>} tables 表名 -> 原始行
 * @param {{ columns?: Record<string, string[]> }} [options] 期望字段（用于引用核对）
 * @returns 原样字符串表（行以数组顺序保留）
 */
export function validateTables(tables, options = {}) {
  const expectedColumns = options.columns ?? {}
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`来源表 ${name} 为空或不是数组`)
    }
    const columns = Object.keys(rows[0])
    if (expectedColumns[name]) {
      const missing = expectedColumns[name].filter(c => !columns.includes(c))
      if (missing.length) throw new Error(`来源表 ${name} 缺少字段: ${missing.join(', ')}`)
    }
    for (const [i, row] of rows.entries()) {
      if (Object.keys(row).join('|') !== columns.join('|')) {
        throw new Error(`来源表 ${name} 第 ${i + 1} 行字段不一致`)
      }
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== 'string') {
          throw new Error(`来源表 ${name} 第 ${i + 1} 行字段 ${k} 不是字符串`)
        }
      }
    }
  }
  return tables
}

/**
 * 跨表引用核对：返回发现的引用问题列表（空数组表示全部闭合）。
 * 这是 data:check 可独立运行的核对逻辑，不依赖业务模块。
 */
export function checkReferences(tables) {
  const problems = []
  const ref = (table, col) => new Set((tables[table] ?? []).map(r => r[col]))
  const columns = new Set([
    ...(tables.paths ?? []).flatMap(p => splitJoined(p.units)),
    ...(tables.paths ?? []).map(p => p.backup).filter(Boolean),
    ...(tables.performance ?? []).map(r => r.column),
    ...(tables.lab ?? []).map(r => r.column),
  ])
  for (const t of ['work', 'handoffs']) {
    for (const row of tables[t] ?? []) {
      if (row.column && !columns.has(row.column)) {
        problems.push(`${t}.${row.task ?? row.piece} 引用了未知柱 ${row.column}`)
      }
    }
  }
  const windows = new Set([
    ...(tables.maintenance ?? []).map(r => r.window),
    ...(tables.delivery ?? []).map(r => r.window),
    ...(tables.storage ?? []).map(r => r.window),
  ])
  for (const t of ['work', 'handoffs']) {
    for (const row of tables[t] ?? []) {
      if (row.window && !windows.has(row.window)) {
        problems.push(`${t}.${row.task ?? row.piece} 引用了未知窗口 ${row.window}`)
      }
    }
  }
  const feeds = ref('thresholds', 'feed')
  for (const row of tables.performance ?? []) {
    if (!feeds.has(row.feed)) problems.push(`performance(${row.column},d${row.day}) 的进料 ${row.feed} 无阈值资料`)
  }
  const customers = ref('product_rules', 'customer')
  for (const row of tables.handoffs ?? []) {
    if (row.customer && !customers.has(row.customer)) {
      problems.push(`handoffs.${row.piece} 引用了未知客户 ${row.customer}`)
    }
  }
  const lines = ref('paths', 'line')
  for (const row of tables.handoffs ?? []) {
    if (row.line && !lines.has(row.line)) {
      problems.push(`handoffs.${row.piece} 引用了未知线路 ${row.line}`)
    }
  }
  return problems
}
