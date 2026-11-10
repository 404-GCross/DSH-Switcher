import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electron from 'electron'
import { buildMain } from './build.mjs'

await buildMain()
const server = await createServer({ server: { host: '127.0.0.1' } })
await server.listen()
const child = spawn(electron, ['.'], {
  stdio: 'inherit', env: { ...process.env, SWITCHER_DEV_URL: 'http://127.0.0.1:5178' },
})
child.on('exit', async code => { await server.close(); process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
