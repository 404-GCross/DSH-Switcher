import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LocalInstallation } from '../../shared/types'
import { runtimeEnvironment } from './platform'

export function redactLog(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/((?:authorization|cookie)\s*[:=]).*$/gim, '$1 [redacted]')
    .replace(/([?&](?:token|key|password|secret|access_token)=)[^\s&#"'<>]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:authorization|cookie|api[_-]?key|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
}

/** An owned process group, including installer descendants; no process is selected by its port. */
export class OwnedProcess {
  readonly child: ChildProcess
  readonly closed: Promise<{ code: number | null; error?: Error }>
  private stopping?: Promise<void>
  private exited = false
  constructor(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; onOutput?: (text: string) => void; lease?: boolean }) {
    this.child = spawn(binary, args, {
      env: options.env, cwd: options.cwd, windowsHide: true,
      detached: process.platform !== 'win32', stdio: [options.lease ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let spawnError: Error | undefined
    this.child.once('error', error => { spawnError = error })
    this.child.stdout?.setEncoding('utf8').on('data', (data: string) => options.onOutput?.(data))
    this.child.stderr?.setEncoding('utf8').on('data', (data: string) => options.onOutput?.(data))
    this.closed = new Promise(resolve => this.child.once('close', code => { this.exited = true; resolve({ code, error: spawnError }) }))
  }
  stop(): Promise<void> {
    return this.stopping ??= this.terminate()
  }
  private async terminate(): Promise<void> {
    const pid = this.child.pid
    if (!pid) { await this.closed; return }
    if (this.child.stdin && !this.exited) {
      this.child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000) })]) } finally { clearTimeout(timer) }
      if (this.exited) return
    }
    if (process.platform === 'win32') {
      if (!this.exited) {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => resolve())
          killer.once('close', () => resolve())
        })
      }
      await this.closed
      return
    }
    const signal = (name: NodeJS.Signals) => {
      try { process.kill(-pid, name) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    signal('SIGTERM')
    // The root can exit before its children. Retain the group until the force deadline.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })])
    } finally { clearTimeout(timer) }
    signal('SIGKILL')
    await this.closed
  }
}

export async function runProgram(binary: string, args: string[], options: {
  env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string) => void; supervisor?: string
} = {}): Promise<string> {
  options.signal?.throwIfAborted()
  let output = ''
  const owner = new OwnedProcess(binary, options.supervisor ? [options.supervisor, binary, ...args] : args, { ...options, lease: !!options.supervisor, onOutput: text => {
    output = (output + text).slice(-32768)
    options.onOutput?.(text)
  } })
  let stopError: unknown
  let timedOut = false
  const stop = () => { void owner.stop().catch(error => { stopError = error }) }
  const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs ?? 15_000)
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    const result = await owner.closed
    if (stopError) throw stopError
    options.signal?.throwIfAborted()
    if (timedOut) throw Object.assign(new Error(`程序执行超时：${path.basename(binary)}`), { code: 'PROCESS_TIMEOUT' })
    if (result.error || result.code !== 0) throw new Error(`程序执行失败：${path.basename(binary)}${result.code === null ? '（中止或超时）' : `（退出码 ${result.code}）`}`)
    return output.trim()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    await owner.stop()
  }
}

/** Only the current child's explicit ready line supplies credentials. */
export function parseReadyLine(line: string): { url: string; launchUrl: string } | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '')
  const match = /(?:^|\s)dsh web:\s*(https?:\/\/[^\s"<>]+)/.exec(clean)
  if (!match) return null
  const url = new URL(match[1])
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token')) {
    throw new Error('本机 DSH 返回了无效的就绪地址')
  }
  const launchUrl = url.href
  url.search = ''; url.hash = ''
  return { url: url.href, launchUrl }
}

export async function startDsh(installation: LocalInstallation, home: string, signal: AbortSignal, log: (line: string) => void, supervisor: string) {
  signal.throwIfAborted()
  await mkdir(home, { recursive: true })
  let initialize = false
  try { await stat(path.join(home, 'profiles', 'switcher', 'package.json')) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') initialize = true
    else throw error
  }
  await access(installation.cliPath)
  signal.throwIfAborted()
  const env = runtimeEnvironment(installation.nodePath, [path.dirname(installation.pnpmPath)])
  env.DSH_HOME = home
  const args = [installation.cliPath, '--profile', 'switcher', ...(initialize ? ['--from-default-profile', 'web'] : []), '--host', '127.0.0.1', '--port', '0', '--no-open']
  let resolveReady!: (value: { url: string; launchUrl: string }) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<{ url: string; launchUrl: string }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let buffer = ''
  const owner = new OwnedProcess(installation.nodePath, [supervisor, installation.nodePath, ...args], { env, cwd: home, lease: true, onOutput: text => {
    buffer += text
    let at: number
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      try { const value = parseReadyLine(line); if (value) resolveReady(value) } catch (error) { rejectReady(error instanceof Error ? error : new Error('就绪地址无效')) }
      log(redactLog(line).slice(0, 1500))
    }
    if (buffer.length > 32768) buffer = buffer.slice(-4096)
  } })
  void owner.closed.then(() => rejectReady(new Error('DSH 在就绪前退出，请查看运行日志')))
  const abort = () => { rejectReady(new Error('启动已取消')); void owner.stop().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => rejectReady(new Error('DSH 启动超时，请查看运行日志并重试')), 90_000)
  try {
    const endpoint = await ready
    signal.throwIfAborted()
    return { owner, ...endpoint }
  } catch (error) {
    await owner.stop()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
