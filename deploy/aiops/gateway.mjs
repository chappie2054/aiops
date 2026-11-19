import http from 'node:http'
import fs from 'node:fs'
import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

const port = Number(process.env.GATEWAY_PORT || 8080)
const upstreamPort = Number(process.env.HARNESS_PORT || 3080)
const upstreamHost = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
if (!upstreamHost) throw new Error('No pod IPv4 address found')
const user = process.env.LOGIN_USERNAME
const salt = process.env.LOGIN_SALT
const expected = process.env.LOGIN_HASH
const sessionKey = process.env.LOGIN_SESSION_KEY
const tokenFile = process.env.LAUNCH_TOKEN_FILE || '/run/dsh/launch-token'
if (!user || !salt || !expected || !sessionKey) throw new Error('Login secret is incomplete')
const expectedBytes = Buffer.from(expected, 'hex')
if (expectedBytes.length !== 64) throw new Error('Invalid login password hash')
const sessionKeyBytes = Buffer.from(sessionKey, 'hex')
if (sessionKeyBytes.length !== 32) throw new Error('Invalid login session key')
const sessionLifetime = 7 * 24 * 60 * 60

function verifyPassword(actualUser, actualPassword) {
  if (actualUser.length > 128 || actualPassword.length > 1024) return false
  const userMatch = timingSafeEqual(createHash('sha256').update(actualUser).digest(), createHash('sha256').update(user).digest())
  const passwordMatch = timingSafeEqual(scryptSync(actualPassword, salt, 64), expectedBytes)
  return userMatch && passwordMatch
}

function signature(host, issued) {
  return createHmac('sha256', sessionKeyBytes).update(`${user}|${host}|${issued}`).digest('hex')
}

function sessionCookie(request) {
  const issued = Math.floor(Date.now() / 1000)
  const value = `v1.${issued}.${signature(request.headers.host, issued)}`
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  return `aiops_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime}${secure}`
}

function authorized(request) {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)aiops_session=(v1\.\d+\.[a-f0-9]{64})(?:;|$)/u)?.[1]
  if (!cookie) return false
  const [, issuedText, actualSignature] = cookie.split('.')
  const issued = Number(issuedText)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(issued) || issued > now || now - issued > sessionLifetime) return false
  return timingSafeEqual(Buffer.from(actualSignature, 'hex'), Buffer.from(signature(request.headers.host, issued), 'hex'))
}

function loginPage(response, error = false) {
  const template = fs.readFileSync(new URL('./login.html', import.meta.url), 'utf8')
  response.writeHead(error ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" })
  response.end(template.replace('{{ERROR}}', error ? '<p class="error">账号或密码错误，请重试。</p>' : ''))
}

async function handleLogin(request, response) {
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) {
    response.writeHead(403); return response.end()
  }
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 4096) { response.writeHead(413); return response.end() }
  }
  const form = new URLSearchParams(body)
  if (!verifyPassword(form.get('username') || '', form.get('password') || '')) return loginPage(response, true)
  response.writeHead(303, { Location: '/guide', 'Set-Cookie': sessionCookie(request), 'Cache-Control': 'no-store' })
  response.end()
}

function launchToken() {
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    return /^[A-Za-z0-9_-]{20,}$/u.test(token) ? token : undefined
  } catch { return undefined }
}

function proxy(request, response) {
  const headers = { ...request.headers }
  delete headers.authorization
  headers['accept-encoding'] = 'identity'
  const upstream = http.request({ hostname: upstreamHost, port: upstreamPort, method: request.method, path: request.url, headers }, upstreamResponse => {
    if (request.method === 'GET' && request.url === '/' && upstreamResponse.statusCode === 401) {
      upstreamResponse.resume()
      const token = launchToken()
      if (token) {
        response.writeHead(302, { Location: `/?token=${token}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
        response.end()
        return
      }
    }
    const html = request.method === 'GET' && upstreamResponse.statusCode === 200 && String(upstreamResponse.headers['content-type'] || '').includes('text/html') && !upstreamResponse.headers['content-encoding']
    if (!html) {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
      return
    }
    const chunks = []
    upstreamResponse.on('data', chunk => chunks.push(chunk))
    upstreamResponse.on('end', () => {
      let page = Buffer.concat(chunks).toString('utf8')
      const head = '<link rel="icon" type="image/svg+xml" href="/aiops/favicon.svg"><link rel="stylesheet" href="/aiops/brand.css"><script defer src="/aiops/brand.js"></script>'
      page = page.includes('</head>') ? page.replace('</head>', `${head}</head>`) : `${head}${page}`
      const form = '<form id="aiops-logout" method="post" action="/logout"><button type="submit">退出登录</button></form>'
      page = page.includes('</body>') ? page.replace('</body>', `${form}</body>`) : `${page}${form}`
      const responseHeaders = { ...upstreamResponse.headers, 'cache-control': 'no-store' }
      delete responseHeaders['content-length']
      delete responseHeaders.etag
      response.writeHead(200, responseHeaders)
      response.end(page)
    })
  })
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end('Harness is starting') })
  request.pipe(upstream)
}

function guide(response) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'aiops_guide_seen=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'" })
  response.end(fs.readFileSync(new URL('./guide.html', import.meta.url)))
}

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/login') {
    handleLogin(request, response).catch(() => { if (!response.headersSent) response.writeHead(400); response.end() })
    return
  }
  if (request.method === 'GET' && request.url === '/login') return loginPage(response)
  if (request.method === 'GET' && request.url === '/aiops/favicon.svg') {
    response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
    return response.end(fs.readFileSync(new URL('./favicon.svg', import.meta.url)))
  }
  if (!authorized(request)) {
    if (request.method === 'GET' && (request.url === '/' || request.url === '/guide')) return loginPage(response)
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end('请先登录集群管理工作台。')
  }
  if (request.method === 'GET' && request.url?.startsWith('/aiops/')) {
    const files = { '/aiops/brand.css': ['brand.css', 'text/css'], '/aiops/brand.js': ['brand.js', 'text/javascript'], '/aiops/favicon.svg': ['favicon.svg', 'image/svg+xml'] }
    const asset = files[request.url]
    if (!asset) { response.writeHead(404); return response.end() }
    response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'public, max-age=3600' })
    return response.end(fs.readFileSync(new URL(`./${asset[0]}`, import.meta.url)))
  }
  if (request.method === 'POST' && request.url === '/logout') {
    response.writeHead(303, { Location: '/login', 'Set-Cookie': 'aiops_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'Cache-Control': 'no-store' })
    return response.end()
  }
  if (request.method === 'GET' && request.url === '/manifest.webmanifest') {
    response.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ name: 'AIOps 运维平台', short_name: 'AIOps', start_url: '/', display: 'standalone', icons: [{ src: '/aiops/favicon.svg', sizes: 'any', type: 'image/svg+xml' }] }))
  }
  if (request.url === '/guide') return guide(response)
  if (request.url === '/' && !request.headers.cookie?.includes('aiops_guide_seen=1')) {
    response.writeHead(302, { Location: '/guide', 'Cache-Control': 'no-store' })
    return response.end()
  }
  if (request.url === '/?open=1') {
    const token = launchToken()
    if (!token) { response.writeHead(503); return response.end('Harness is starting') }
    response.writeHead(302, { Location: `/?token=${token}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    return response.end()
  }
  proxy(request, response)
})

server.on('upgrade', (request, socket, head) => {
  if (!authorized(request)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const upstream = connect(upstreamPort, upstreamHost)
  upstream.on('connect', () => {
    const headers = Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== 'authorization').map(([key, value]) => `${key}: ${value}`).join('\r\n')
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(port, '0.0.0.0', () => process.stdout.write(`AIOps gateway listening on ${port}\n`))
