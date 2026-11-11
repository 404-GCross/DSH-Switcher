import { spawn } from 'node:child_process'

// The desktop keeps stdin open. EOF also arrives when it crashes or is force-closed.
const [binary, ...args] = process.argv.slice(2)
if (!binary) process.exit(1)
const child = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32', windowsHide: true })
let exited = false
let resolveExit
const closed = new Promise(resolve => { resolveExit = resolve })
child.once('error', () => { exited = true; resolveExit(1) })
child.once('close', code => { exited = true; resolveExit(code ?? 1); void stop(code ?? 1) })
let stopping
function stop(code = 0) {
  return stopping ??= (async () => {
    if (child.pid) {
      if (process.platform === 'win32') {
        if (!exited) await new Promise(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          killer.once('error', resolve)
          killer.once('close', resolve)
        })
      } else {
        const signal = value => { try { process.kill(-child.pid, value) } catch { /* The owned process group may already have exited. */ } }
        signal('SIGTERM')
        let timer
        await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 800) })])
        clearTimeout(timer)
        signal('SIGKILL')
      }
    }
    await closed
    process.exit(code)
  })()
}
process.stdin.resume()
process.stdin.once('end', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
