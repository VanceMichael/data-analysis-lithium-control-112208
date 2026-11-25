#!/usr/bin/env node
// 交班后可重算的命令行入口。所有命令输出确定性 JSON，便于计划员留痕与复核。
//
// 用法：
//   node src/cli.js analyze [--data data] [--role 计划员]
//   node src/cli.js day <运行日>
//   node src/cli.js life [--feed A]
//   node src/cli.js schedule [--window W1]
//   node src/cli.js delivery [--window W1]
//   node src/cli.js ingest <incoming.json>   # 新交班/维修回执走同一运行入口
//   node src/cli.js verdict <piece> <转可交|降级|否决> --basis "..." [--communication "..."]
//   node src/cli.js receipt <task> <restartDay> <newLot>  # 维修回执（完工+复启）

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { loadTables } from './io.js'
import { buildAnalysis } from './app.js'
import { ingest, maintenanceReceipt } from './ingest.js'
import { parseHandoffs, applyLabVerdict, evaluateDelivery, parseRules, stableReadiness } from './product.js'
import { parseThresholds, buildExperiences } from './experience.js'
import { buildSampleLedger } from './sampling.js'

function pickArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: 'string', default: 'data' },
      role: { type: 'string', default: '计划员' },
      feed: { type: 'string' },
      window: { type: 'string' },
      receipt: { type: 'boolean', default: false },
      basis: { type: 'string' },
      communication: { type: 'string' },
    },
  })
  return { values, positionals }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const { values, positionals } = pickArgs(process.argv.slice(2))
  const command = positionals[0] ?? 'analyze'
  const dataDir = resolve(values.data)
  const tables = await loadTables(dataDir)

  if (command === 'ingest') {
    const file = positionals[1]
    if (!file) throw new Error('ingest 需要 incoming.json 路径')
    const payload = JSON.parse(await readFile(resolve(file), 'utf8'))
    const result = values.receipt
      ? maintenanceReceipt(tables, payload)
      : ingest(tables, payload)
    print({
      accepted: result.accepted,
      duplicates: result.duplicates,
      referenceProblems: result.referenceProblems,
    })
    return
  }

  if (command === 'receipt') {
    const [, task, restartDay, newLot] = positionals
    if (!task || !restartDay || !newLot) throw new Error('receipt 需要 <task> <restartDay> <newLot>')
    const result = maintenanceReceipt(tables, { task, restartDay: Number(restartDay), newLot })
    print({
      accepted: result.accepted,
      duplicates: result.duplicates,
      referenceProblems: result.referenceProblems,
    })
    return
  }

  if (command === 'verdict') {
    const [, piece, decision] = positionals
    if (!piece || !decision) throw new Error('verdict 需要 <piece> <转可交|降级|否决>')
    const pieces = parseHandoffs(tables.handoffs)
    const { overrides, effect } = applyLabVerdict(pieces, new Map(), {
      piece,
      decision,
      basis: values.basis ?? '命令行录入化验改判',
      communication: values.communication ?? null,
    })
    const ledger = buildSampleLedger(tables.lab)
    const exps = buildExperiences(tables.performance, parseThresholds(tables.thresholds), ledger)
    const readiness = stableReadiness(exps, parseThresholds(tables.thresholds))
    const reevaluated = evaluateDelivery(pieces, parseRules(tables.product_rules), readiness, overrides)
    print({ effect, piece, delivery: reevaluated.find(d => d.piece === piece) })
    return
  }

  const analysis = buildAnalysis(tables, { operatorRole: values.role })

  switch (command) {
    case 'analyze':
      print({
        referenceProblems: analysis.referenceProblems,
        currentDay: analysis.currentDay,
        dayWindowIndex: analysis.dayWindowIndex,
        lotComparison: analysis.lotComparison,
        dependence: analysis.dependence,
        columnRisk: analysis.columnRisk,
        lineRisk: analysis.lineRisk,
        schedule: analysis.schedule,
        scenarios: analysis.scenarios,
        riskCaps: analysis.riskCaps,
        labSlots: analysis.labSlots,
        hold: analysis.hold,
        delivery: analysis.delivery,
        customerBlockers: analysis.customerBlockers,
        committedImpact: analysis.committedImpact,
      })
      break
    case 'day': {
      const d = Number(positionals[1])
      if (!Number.isInteger(d)) throw new Error('day 需要运行日整数')
      print(analysis.queryByDay(d))
      break
    }
    case 'life':
      print(values.feed
        ? analysis.lotComparison.filter(x => x.feed === values.feed)
        : analysis.lotComparison)
      break
    case 'schedule':
      print(values.window
        ? {
            schedule: analysis.schedule.filter(s => s.window === values.window),
            scenarios: analysis.scenarios.filter(s => s.window === values.window),
            riskCaps: analysis.riskCaps.filter(r => r.window === values.window),
          }
        : { schedule: analysis.schedule, scenarios: analysis.scenarios, riskCaps: analysis.riskCaps })
      break
    case 'delivery':
      print(values.window
        ? {
            hold: analysis.hold.filter(h => h.window === values.window),
            delivery: analysis.delivery.filter(d => d.window === values.window),
            customerBlockers: analysis.customerBlockers.filter(c => c.window === values.window),
            labSlots: analysis.labSlots.filter(l => l.window === values.window),
            committedImpact: analysis.committedImpact.filter(c => c.window === values.window),
          }
        : {
            hold: analysis.hold,
            delivery: analysis.delivery,
            customerBlockers: analysis.customerBlockers,
            labSlots: analysis.labSlots,
            committedImpact: analysis.committedImpact,
          })
      break
    default:
      throw new Error(`未知命令 ${command}`)
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`)
  process.exitCode = 1
})
