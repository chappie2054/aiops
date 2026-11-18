#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const problemReasons = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'RunContainerError', 'OOMKilled'])
const namespacePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u

export function findProblems(pods, deployments, now = Date.now()) {
  const results = []
  for (const pod of pods.items ?? []) {
    const namespace = pod.metadata.namespace
    const name = pod.metadata.name
    const age = now - Date.parse(pod.metadata.creationTimestamp ?? 0)
    const statuses = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])]
    const reasons = statuses.flatMap(status => {
      const found = []
      if (problemReasons.has(status.state?.waiting?.reason)) found.push(status.state.waiting.reason)
      if (status.state?.terminated && status.state.terminated.exitCode !== 0) found.push(status.state.terminated.reason || `exit-${status.state.terminated.exitCode}`)
      if (status.lastState?.terminated?.reason === 'OOMKilled') found.push('OOMKilled')
      return found
    })
    if (pod.status.phase === 'Failed') reasons.push('PodFailed')
    if (pod.status.phase === 'Pending' && age >= 120000 && reasons.length === 0) reasons.push('Pending')
    if (!reasons.length) continue
    results.push({ kind: 'Pod', namespace, name, reasons: [...new Set(reasons)], phase: pod.status.phase, node: pod.spec.nodeName ?? null, owners: pod.metadata.ownerReferences?.map(owner => ({ kind: owner.kind, name: owner.name })) ?? [], containerSpecs: [...(pod.spec.initContainers ?? []), ...(pod.spec.containers ?? [])].map(container => ({ name: container.name, image: container.image, command: container.command ?? null, args: container.args ?? null })), containers: statuses.map(status => ({ name: status.name, ready: status.ready, restartCount: status.restartCount, waiting: status.state?.waiting ?? null, terminated: status.state?.terminated ?? null, lastTerminated: status.lastState?.terminated ?? null })) })
  }
  for (const deployment of deployments.items ?? []) {
    const desired = deployment.spec.replicas ?? 1
    const available = deployment.status.availableReplicas ?? 0
    const age = now - Date.parse(deployment.metadata.creationTimestamp ?? 0)
    if (desired > available && age >= 120000) results.push({ kind: 'Deployment', namespace: deployment.metadata.namespace, name: deployment.metadata.name, reasons: ['UnavailableReplicas'], desired, available, images: deployment.spec.template.spec.containers.map(container => container.image) })
  }
  return results.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

function kubectl(args, maxBuffer = 8 * 1024 * 1024) {
  try { return execFileSync('kubectl', args, { encoding: 'utf8', timeout: 30000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) { return { error: error.stderr?.toString().trim() || error.message } }
}

function parseResult(result, label) {
  if (typeof result !== 'string') throw new Error(`${label}: ${result.error}`)
  return JSON.parse(result)
}

function evidenceFor(problem) {
  const namespaceArgs = ['-n', problem.namespace]
  const result = { problem }
  const events = kubectl(['get', 'events', ...namespaceArgs, '--field-selector', `involvedObject.name=${problem.name}`, '-o', 'json'])
  result.events = typeof events === 'string' ? JSON.parse(events).items?.map(event => ({ at: event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp, reason: event.reason, message: event.message, type: event.type })).slice(-30) : events
  if (problem.kind === 'Pod') {
    result.logs = kubectl(['logs', ...namespaceArgs, problem.name, '--all-containers=true', '--tail=100', '--max-log-requests=5'], 256 * 1024)
    result.previousLogs = kubectl(['logs', ...namespaceArgs, problem.name, '--all-containers=true', '--previous', '--tail=100'], 256 * 1024)
  }
  return result
}

export function classify(problem, evidence) {
  const messages = Array.isArray(evidence.events) ? evidence.events.map(event => event.message || '').join('\n') : ''
  if (problem.reasons.includes('ImagePullBackOff') || problem.reasons.includes('ErrImagePull')) {
    const kind = /not found|manifest unknown|pull access denied/i.test(messages) ? 'image_missing_or_denied' : /unauthorized|authentication required|denied/i.test(messages) ? 'registry_authentication' : /timeout|no such host|network is unreachable/i.test(messages) ? 'registry_network' : 'image_pull_unknown'
    return { category: kind, confidence: kind === 'image_pull_unknown' ? 'low' : 'medium', basis: '容器等待原因与 Kubernetes 拉取镜像事件；具体原因以事件原文为准' }
  }
  if (problem.reasons.includes('OOMKilled')) return { category: 'memory_limit', confidence: 'high', basis: '容器终止原因为 OOMKilled' }
  if (problem.reasons.includes('Pending') && /FailedScheduling/i.test(JSON.stringify(evidence.events))) return { category: 'scheduling', confidence: 'medium', basis: 'Pod Pending 与 FailedScheduling 事件' }
  return { category: 'needs_analysis', confidence: 'unknown', basis: '当前只定位到异常症状；需结合日志、事件与上下游状态分析' }
}

async function main() {
  const namespaces = (process.env.AIOPS_RCA_NAMESPACES || 'privatization').split(',').map(value => value.trim())
  if (!namespaces.length || namespaces.some(value => !namespacePattern.test(value))) throw new Error('Invalid AIOPS_RCA_NAMESPACES')
  const pods = { items: [] }, deployments = { items: [] }
  for (const namespace of namespaces) {
    pods.items.push(...parseResult(kubectl(['get', 'pods', '-n', namespace, '-o', 'json']), `${namespace} pods`).items)
    deployments.items.push(...parseResult(kubectl(['get', 'deployments', '-n', namespace, '-o', 'json']), `${namespace} deployments`).items)
  }
  const problems = findProblems(pods, deployments).slice(0, 20)
  const evidence = problems.map(problem => {
    const item = evidenceFor(problem)
    item.initialAssessment = classify(problem, item)
    return item
  })
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), namespaces, status: evidence.length ? 'anomalies_found' : 'healthy', scanned: { pods: pods.items.length, deployments: deployments.items.length }, evidence }
  if (process.env.AIOPS_RCA_OUTPUT_DIR) {
    const outputDir = process.env.AIOPS_RCA_OUTPUT_DIR
    mkdirSync(outputDir, { recursive: true })
    const output = join(outputDir, `scan-${report.generatedAt.replace(/[:.]/gu, '-')}.json`)
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    report.evidenceFile = output
  }
  console.log(JSON.stringify(report))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
