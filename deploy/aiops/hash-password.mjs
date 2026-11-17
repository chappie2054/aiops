import { randomBytes, scryptSync } from 'node:crypto'

let password = ''
for await (const chunk of process.stdin) password += chunk
if (!password) throw new Error('Password must not be empty')
const salt = randomBytes(24).toString('hex')
process.stdout.write(`${salt}\n${scryptSync(password, salt, 64).toString('hex')}\n`)
