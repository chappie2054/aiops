import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, findProblems } from './scan.mjs'

const old = '2026-01-01T00:00:00Z'
const now = Date.parse('2026-01-01T00:10:00Z')

test('finds actionable failures and ignores young Pending pods', () => {
  const pods = { items: [
    { metadata: { namespace: 'lab', name: 'bad-image', creationTimestamp: old }, spec: {}, status: { phase: 'Pending', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }] } },
    { metadata: { namespace: 'lab', name: 'new-pod', creationTimestamp: '2026-01-01T00:09:30Z' }, spec: {}, status: { phase: 'Pending' } },
  ] }
  const deployments = { items: [{ metadata: { namespace: 'lab', name: 'api', creationTimestamp: old }, spec: { replicas: 2, template: { spec: { containers: [{ image: 'example/api:v2' }] } } }, status: { availableReplicas: 1 } }] }
  const found = findProblems(pods, deployments, now)
  assert.deepEqual(found.map(item => item.name), ['api', 'bad-image'])
  assert.deepEqual(found[1].reasons, ['ImagePullBackOff'])
})

test('classifies image pull only with supporting event', () => {
  const problem = { reasons: ['ImagePullBackOff'] }
  assert.equal(classify(problem, { events: [{ message: 'manifest unknown' }] }).category, 'image_missing_or_denied')
  assert.equal(classify(problem, { events: [] }).confidence, 'low')
})

test('preserves startup command as evidence and detects unschedulable pods', () => {
  const pods = { items: [
    { metadata: { namespace: 'privatization', name: 'crash', creationTimestamp: old }, spec: { containers: [{ name: 'app', image: 'example/app:v1', command: ['/bin/sh', '-c', 'exit 42'] }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
    { metadata: { namespace: 'privatization', name: 'pending', creationTimestamp: old }, spec: { containers: [{ name: 'app', image: 'example/app:v1' }] }, status: { phase: 'Pending' } },
  ] }
  const found = findProblems(pods, { items: [] }, now)
  assert.deepEqual(found.map(item => item.name), ['crash', 'pending'])
  assert.deepEqual(found[0].containerSpecs[0].command, ['/bin/sh', '-c', 'exit 42'])
  assert.equal(classify(found[1], { events: [{ reason: 'FailedScheduling', message: 'node selector mismatch' }] }).category, 'scheduling')
})
