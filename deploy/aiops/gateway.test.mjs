import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { networkInterfaces, tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync } from 'node:crypto'

const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address

test('fixed login protects guide and exchanges the current launch token', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aiops-gateway-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'abcdefghijklmnopqrstuvwx')
  const upstream = http.createServer((request, response) => {
    if (request.url?.startsWith('/?token=')) {
      response.writeHead(302, { Location: '/', 'Set-Cookie': 'dsh_session=ok; Path=/' })
    } else if (request.headers.cookie?.includes('dsh_session=ok')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return response.end('<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="app"></div></body></html>')
    } else response.writeHead(401)
    response.end()
  })
  await new Promise(resolve => upstream.listen(0, host, resolve))
  t.after(() => upstream.close())
  const upstreamPort = upstream.address().port
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  const password = 'a strong fixed password'
  const salt = 'test-salt'
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gateway.mjs', import.meta.url))], {
    env: { ...process.env, GATEWAY_PORT: String(port), HARNESS_PORT: String(upstreamPort), LAUNCH_TOKEN_FILE: tokenFile, LOGIN_USERNAME: 'admin', LOGIN_SALT: salt, LOGIN_HASH: scryptSync(password, salt, 64).toString('hex'), LOGIN_SESSION_KEY: 'a'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', code => reject(new Error(`Gateway exited: ${code}`)))
  })
  const base = `http://127.0.0.1:${port}`
  const denied = await fetch(`${base}/guide`)
  assert.equal(denied.status, 200)
  assert.match(await denied.text(), /集群运维工作台/u)
  const wrong = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'wrong' }), redirect: 'manual' })
  assert.equal(wrong.status, 401)
  const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'admin', password }), redirect: 'manual' })
  assert.equal(login.status, 303)
  const session = login.headers.get('set-cookie')?.split(';')[0]
  assert.match(session, /^aiops_session=/u)
  const guide = await fetch(`${base}/`, { headers: { Cookie: session }, redirect: 'manual' })
  assert.equal(guide.status, 302)
  assert.equal(guide.headers.get('location'), '/guide')
  const page = await fetch(`${base}/guide`, { headers: { Cookie: session } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /集群巡检/u)
  const open = await fetch(`${base}/?open=1`, { headers: { Cookie: `${session}; aiops_guide_seen=1` }, redirect: 'manual' })
  assert.equal(open.status, 302)
  assert.equal(open.headers.get('location'), '/?token=abcdefghijklmnopqrstuvwx')
  const exchanged = await fetch(new URL(open.headers.get('location'), base), { headers: { Cookie: session }, redirect: 'manual' })
  assert.equal(exchanged.status, 302)
  assert.match(exchanged.headers.get('set-cookie'), /dsh_session=ok/u)
  const app = await fetch(`${base}/`, { headers: { Cookie: `${session}; dsh_session=ok; aiops_guide_seen=1` } })
  assert.equal(app.status, 200)
  const html = await app.text()
  assert.match(html, /\/aiops\/brand\.css/u)
  assert.match(html, /\/aiops\/brand\.js/u)
  assert.match(html, /退出登录/u)
  const brand = await fetch(`${base}/aiops/brand.js`, { headers: { Cookie: session } })
  assert.equal(brand.status, 200)
  const logout = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: session }, redirect: 'manual' })
  assert.equal(logout.status, 303)
  assert.equal(logout.headers.get('location'), '/login')
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u)

  const forwarded = { 'X-Forwarded-Prefix': '/K7vQ2mT9xR4pL8nC5sH3yW6d' }
  const prefixedLogin = await fetch(`${base}/login`, { headers: forwarded })
  assert.match(await prefixedLogin.text(), /action="\/K7vQ2mT9xR4pL8nC5sH3yW6d\/login"/u)
  const prefixedSessionResponse = await fetch(`${base}/login`, { method: 'POST', headers: forwarded, body: new URLSearchParams({ username: 'admin', password }), redirect: 'manual' })
  assert.equal(prefixedSessionResponse.headers.get('location'), '/K7vQ2mT9xR4pL8nC5sH3yW6d/guide')
  assert.match(prefixedSessionResponse.headers.get('set-cookie'), /Path=\/K7vQ2mT9xR4pL8nC5sH3yW6d\//u)
  const prefixedSession = prefixedSessionResponse.headers.get('set-cookie')?.split(';')[0]
  const prefixedGuide = await fetch(`${base}/guide`, { headers: { ...forwarded, Cookie: prefixedSession } })
  assert.match(await prefixedGuide.text(), /href="\/K7vQ2mT9xR4pL8nC5sH3yW6d\/\?open=1"/u)
  const prefixedOpen = await fetch(`${base}/?open=1`, { headers: { ...forwarded, Cookie: prefixedSession }, redirect: 'manual' })
  assert.equal(prefixedOpen.headers.get('location'), '/K7vQ2mT9xR4pL8nC5sH3yW6d/?token=abcdefghijklmnopqrstuvwx')
  const prefixedExchange = await fetch(new URL(prefixedOpen.headers.get('location').replace('/K7vQ2mT9xR4pL8nC5sH3yW6d', ''), base), { headers: { ...forwarded, Cookie: prefixedSession }, redirect: 'manual' })
  assert.equal(prefixedExchange.headers.get('location'), '/K7vQ2mT9xR4pL8nC5sH3yW6d/')
  assert.match(prefixedExchange.headers.get('set-cookie'), /Path=\/K7vQ2mT9xR4pL8nC5sH3yW6d\//u)
})
