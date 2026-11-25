import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parsePaths, parseWork, canMoveTask, windowAvailability, evaluateWindow, planScenarios,
} from '../src/schedule.js'
import { TASK, AUTHORITY } from '../src/constants.js'

const paths = parsePaths([
  { line: 'A', units: 'C1+C3', capacity: '74', backup: 'C4' },
  { line: 'B', units: 'C2', capacity: '55', backup: 'C4' },
])
const maintenance = [
  { window: 'W1', crew_slots: '1', restart: '下一窗口' },
  { window: 'W2', crew_slots: '1', restart: '下一窗口' },
]
const tasks = parseWork([
  { task: 'M1', column: 'C3', period: 'W1', status: '已开工', authority: '不可移位' },
  { task: 'M2', column: 'C1', period: 'W2', status: '已签', authority: '班长' },
  { task: 'M3', column: 'C2', period: 'W1', status: '候选', authority: '计划员' },
])

test('已开工换料计入不可用且不能移位；已签任务按班组权限判定可移动性', () => {
  assert.equal(canMoveTask(tasks[0], '计划员', 'W2').movable, false)
  assert.equal(canMoveTask(tasks[1], '计划员', 'W1').movable, false)
  assert.match(canMoveTask(tasks[1], '计划员', 'W1').reason, /班长/)
  assert.equal(canMoveTask(tasks[1], '班长', 'W1').movable, true)
  assert.equal(canMoveTask(tasks[2], '计划员', 'W2').movable, true)
})

test('串联线路单单元停用由备用柱替代且不增加原线路上限', () => {
  const evalW1 = evaluateWindow({
    windowName: 'W1', paths, tasks, maintenanceRows: maintenance,
    operatorRole: '计划员', labPendingColumns: new Set(),
  })
  const lineA = evalW1.lines.find(l => l.line === 'A')
  assert.equal(lineA.usable, true)
  assert.equal(lineA.capacity, 74)
  assert.equal(lineA.backupUsed, 'C4')
  assert.equal(evalW1.crewFree, 0) // 名额被已开工任务占用
})

test('同一备用柱同窗不能被两条线路各算一次保障', () => {
  const conflictTasks = [
    { task: 'X1', column: 'C3', window: 'W1', status: '已开工', authority: AUTHORITY.IMMOVABLE },
    { task: 'X2', column: 'C2', window: 'W1', status: '已开工', authority: AUTHORITY.IMMOVABLE },
  ]
  const ev = evaluateWindow({
    windowName: 'W1', paths, tasks: conflictTasks, maintenanceRows: maintenance,
    operatorRole: '计划员', labPendingColumns: new Set(),
  })
  const lineB = ev.lines.find(l => l.line === 'B')
  assert.equal(lineB.usable, false)
  assert.equal(lineB.mode, '备用冲突')
  assert.ok(lineB.blockers[0].includes('C4'))
})

test('串联两个单元同时停用时单根备用无法挽救整条线路', () => {
  const ev = evaluateWindow({
    windowName: 'W1',
    paths,
    tasks: [
      { task: 'X1', column: 'C1', window: 'W1', status: '已开工', authority: AUTHORITY.IMMOVABLE },
      { task: 'X2', column: 'C3', window: 'W1', status: '已开工', authority: AUTHORITY.IMMOVABLE },
    ],
    maintenanceRows: maintenance,
    operatorRole: '计划员',
    labPendingColumns: new Set(),
  })
  const lineA = ev.lines.find(l => l.line === 'A')
  assert.equal(lineA.usable, false)
  assert.ok(lineA.blockers.join('').includes('多个单元'))
})

test('三类方案并列比较：名额满时换一根不可行，降负荷与备用方案给真实能力', () => {
  const result = planScenarios({
    windowName: 'W1',
    paths,
    tasks,
    maintenanceRows: maintenance,
    operatorRole: '计划员',
    labPendingColumns: new Set(),
    targetLoad: 90,
    candidateTask: tasks.find(t => t.task === 'M3'),
  })
  const swap = result.scenarios.find(s => s.id === '换一根')
  assert.equal(swap.feasible, false)
  assert.match(swap.blockers.join(), /施工名额已满/)
  const reduce = result.scenarios.find(s => s.id === '降负荷')
  assert.equal(reduce.capacity, 129)
  assert.equal(reduce.meetsLoad, true)
  const backup = result.scenarios.find(s => s.id === '改用备用线路')
  assert.equal(backup.feasible, true)
  assert.deepEqual(backup.backupUsed, [{ line: 'A', backup: 'C4' }])
})

test('已签未开工任务在未获授权确认前锁柱，并给出移位确认条件', () => {
  const { unavailable, movableBlockers } = windowAvailability(tasks, 'W2', '计划员')
  assert.ok(unavailable.has('C1'))
  assert.ok(movableBlockers.some(m => m.column === 'C1' && m.reason.includes('班长')))
  const asLead = windowAvailability(tasks, 'W2', '班长')
  // 班长也仍需对本窗口停用留痕（默认按计划停用），但原因是确认提示而非权限否决
  assert.ok(asLead.movableBlockers.every(m => !m.reason.includes('不能移位')))
})

test('候选任务未签不锁柱', () => {
  const { unavailable } = windowAvailability(tasks, 'W1', '计划员')
  assert.equal(unavailable.has('C2'), false)
  assert.ok(unavailable.has('C3'))
  void TASK
})
