#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const dataHome = process.env.DSH_HOME || '/data/dsh'
const workspaceHome = process.env.AIOPS_WORKSPACE_HOME || '/workspace'
const seedHome = process.env.AIOPS_SEED_HOME || '/opt/aiops/seed/cases'
const casesPath = join(workspaceHome, '运维案例')
const patrolPath = join(workspaceHome, '巡检记录')
const examples = [
  { id: 'session-57824d75-abe2-4969-a153-dea762154963', title: '异常 Pod 排查示例', file: 'incident-guide.md', question: '如何排查异常 Pod，并区分事实和推断？' },
  { id: 'session-94b23a9d-c1ec-4a8f-8a6c-638e82cbbd2a', title: '镜像拉取失败案例', file: 'image-pull.md', question: '镜像拉取失败时如何判断根因？' },
]
const caseIds = examples.map(example => example.id)
const scheduleTitle = '业务服务自动根因巡检'
const schedulePrompt = '每次只读巡检已配置的业务命名空间。运行 node /workspace/aiops-rca/scan.mjs；脚本直接输出完整证据 JSON，不写文件、不需要审批或提权。若 healthy，简短报告扫描时间和数量。若 anomalies_found，合并同一 Deployment 和 Pod，逐项给出已确认事实、带时间的证据、最可能根因、置信度及缺失证据；不能证明具体根因时明确写未知。不要修复或修改集群资源。始终用简体中文。'

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.seed-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function workspaceSeed() {
  const path = join(dataHome, 'storages', 'workspace.json')
  const state = readJson(path, { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } })
  if (state.unit?.name !== 'workspace' || state.unit.version !== 2) throw new Error('Unsupported workspace store')
  const records = state.tables.workspaces
  const now = new Date().toISOString()
  for (const [folder, title, sessionIds] of [[casesPath, '运维案例', caseIds], [patrolPath, '巡检记录', []]]) {
    mkdirSync(folder, { recursive: true })
    const existing = Object.entries(records).find(([, row]) => row.path === folder)
    if (existing) {
      const row = existing[1]
      row.sessionIds = [...sessionIds, ...row.sessionIds.filter(id => !sessionIds.includes(id))]
    } else {
      const id = randomUUID()
      records[id] = { path: folder, title, sessionIds, createdAt: now, updatedAt: now }
      state.global.workspaceIds.push(id)
    }
  }
  writeJson(path, state)
}

function sessionSeed() {
  const encodedCwd = '--workspace-~8FD0~7EF4~6848~4F8B--'
  for (const example of examples) {
    const dest = join(dataHome, 'sessions', encodedCwd, example.id, 'session.v4.jsonl.zstd')
    if (existsSync(dest)) continue
    const answer = readFileSync(join(seedHome, example.file), 'utf8')
    const now = Date.now()
    const event = (type, seq, data, extra = {}) => ({ type, seq, time: now + seq, data, ...extra })
    const lines = [
      { type: 'session', version: 4, id: example.id, createdAt: now, cwd: casesPath, isSeeded: false, delegationDepth: 0 },
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('user/message', 2, { content: [{ type: 'text', text: example.question }], source: { kind: 'user' }, role: 'user', id: randomUUID() }, { surfaceOp: 'append' }),
      event('session/title', 3, { title: example.title, messageSeqs: [2], source: { kind: 'fallback' } }),
      event('assistant/message', 4, { turn: 1, step: 1, stream: [], message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'seed', model: 'example' }, content: [{ type: 'text', text: answer }] } }, { surfaceOp: 'append' }),
      event('step/end', 5, { turn: 1, step: 1 }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    ]
    mkdirSync(join(dest, '..'), { recursive: true })
    const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(lines[0])}\n`))
    const eventsFrame = zstdCompressSync(Buffer.from(lines.slice(1).map(line => JSON.stringify(line)).join('\n') + '\n'))
    writeFileSync(dest, Buffer.concat([headerFrame, eventsFrame]), { mode: 0o600 })
  }
}

function scheduleSeed() {
  const path = join(dataHome, 'storages', 'schedule.json')
  const state = readJson(path, { unit: { name: 'schedule', version: 2 }, global: null, tables: { tasks: {} } })
  if (state.unit?.name !== 'schedule' || state.unit.version !== 2) throw new Error('Unsupported schedule store')
  if (Object.values(state.tables.tasks).some(task => task.record?.title === scheduleTitle)) return
  const id = `schedule-${randomUUID()}`
  const nextMs = Math.ceil((Date.now() + 60000) / 60000) * 60000
  const local = new Date(nextMs + 8 * 3600000)
  const localStamp = `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, '0')}${String(local.getUTCDate()).padStart(2, '0')}T${String(local.getUTCHours()).padStart(2, '0')}${String(local.getUTCMinutes()).padStart(2, '0')}00`
  const now = new Date().toISOString()
  state.tables.tasks[id] = {
    record: { id, kind: 'rrule', title: scheduleTitle, prompt: schedulePrompt, rrule: `DTSTART;TZID=Asia/Shanghai:${localStamp}\nRRULE:FREQ=MINUTELY;INTERVAL=15`, scheduledAt: new Date(nextMs).toISOString() },
    target: { kind: 'new_once', create: { cwd: patrolPath, agentPreset: 'standard' } },
    status: 'active', createdAt: now, updatedAt: now,
  }
  writeJson(path, state)
}

sessionSeed()
workspaceSeed()
scheduleSeed()
console.log('AIOps example sessions and 15-minute RCA patrol are ready')
