// 从数据目录读取全部来源表。保持字符串原始值，不在加载层做类型转换。

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const TABLE_NAMES = [
  'performance', 'lab', 'paths', 'work', 'delivery', 'thresholds',
  'maintenance', 'product_rules', 'handoffs', 'storage',
]

export async function loadTables(dataDir, names = TABLE_NAMES) {
  const tables = {}
  for (const name of names) {
    const file = new URL(`file://${join(dataDir, `${name}.json`)}`)
    const text = await readFile(file, 'utf8')
    tables[name] = JSON.parse(text)
  }
  return tables
}

export async function listDataFiles(dataDir) {
  return (await readdir(dataDir)).filter(f => f.endsWith('.json')).sort()
}
