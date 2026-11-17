import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import fs from 'node:fs'

const ip = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
if (!ip) throw new Error('No pod IPv4 address found')
const publicUrl = process.env.PUBLIC_URL
if (!publicUrl) throw new Error('PUBLIC_URL is required')
const authority = new URL(publicUrl).host
const tokenFile = process.env.LAUNCH_TOKEN_FILE || '/run/dsh/launch-token'
const child = spawn('dsh', ['web', '--no-open', '--host', ip, '--port', '3080', '--public-url', publicUrl, '--trusted-host', authority], { stdio: ['inherit', 'pipe', 'inherit'] })
let pending = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  pending += chunk
  while (pending.includes('\n')) {
    const index = pending.indexOf('\n')
    const line = pending.slice(0, index)
    pending = pending.slice(index + 1)
    const match = /^dsh web: .*\?token=([A-Za-z0-9_-]+)/u.exec(line)
    if (match) {
      fs.writeFileSync(tokenFile, match[1], { mode: 0o600 })
      process.stdout.write('dsh web: ready (login gateway enabled)\n')
    } else process.stdout.write(`${line}\n`)
  }
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
