// 下一轮判断的统一运行入口：录入实际换料、复启、有效化验、物料交接
// 与维修回执。所有追加资料仍遵守"全字符串原始值 + 引用闭合"的来源纪律，
// 重复录入按业务键幂等处理，保证每次交班都能走相同入口重算。

import { checkReferences } from './parse.js'

const TABLE_KEYS = {
  performance: r => `${r.column}#${r.load_lot}#${r.day}`,
  lab: r => `${r.column}#${r.day}#${r.revision}`,
  work: r => r.task,
  handoffs: r => r.piece,
  maintenance: r => r.window,
}

/** 深拷贝一组表，避免录入过程污染上一轮快照。 */
export function snapshot(tables) {
  return Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, structuredClone(v)]))
}

/**
 * 追加一批交班记录。
 * @param tables 当前全部来源表（会被复制后返回新表）
 * @param incoming { table: rows[] } 按表名分组的新行
 * @returns {{tables, accepted, duplicates, referenceProblems}}
 */
export function ingest(tables, incoming) {
  const next = snapshot(tables)
  const accepted = []
  const duplicates = []
  for (const [table, rows] of Object.entries(incoming)) {
    if (!next[table]) throw new Error(`未知来源表 ${table}`)
    if (!Array.isArray(rows)) throw new Error(`表 ${table} 的录入内容必须是数组`)
    const keyOf = TABLE_KEYS[table]
    const seen = new Set(next[table].map(r => keyOf?.(r)))
    const columns = Object.keys(next[table][0] ?? {})
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== 'string') throw new Error(`表 ${table} 新行字段 ${k} 必须是字符串原始值`)
      }
      const extra = Object.keys(row).filter(k => !columns.includes(k))
      if (extra.length) throw new Error(`表 ${table} 新行含未知字段 ${extra.join(',')}`)
      const key = keyOf?.(row)
      if (key !== undefined && seen.has(key)) {
        duplicates.push({ table, key })
        continue
      }
      next[table].push({ ...row })
      if (key !== undefined) seen.add(key)
      accepted.push({ table, key })
    }
  }
  const referenceProblems = checkReferences(next)
  return { tables: next, accepted, duplicates, referenceProblems }
}

/**
 * 维修回执：把已开工任务推进为完成，并在 performance 表补一条复启/装填记录。
 * 回执同样是字符串原始值。
 */
export function maintenanceReceipt(tables, { task, restartDay, newLot, state = '已装填' }) {
  const workRow = tables.work.find(r => r.task === task)
  if (!workRow) throw new Error(`维修任务 ${task} 不存在`)
  const incoming = {
    work: [{ ...workRow, status: '已完工' }],
    performance: [{
      column: workRow.column,
      load_lot: newLot,
      day: String(restartDay),
      feed: tables.performance.find(r => r.column === workRow.column)?.feed ?? 'A',
      processed: '?',
      ratio: '?',
      state,
    }],
  }
  // work 表以 task 为键，完工回执是同键状态推进：先替换再 ingest 其余表
  const replaced = snapshot(tables)
  const idx = replaced.work.findIndex(r => r.task === task)
  replaced.work[idx] = incoming.work[0]
  return ingest(replaced, { performance: incoming.performance })
}
