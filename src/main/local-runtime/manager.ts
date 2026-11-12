import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import semver from 'semver'
import path from 'node:path'
import type { LocalAction, LocalCommand, LocalRuntimeState } from '../../shared/types'
import type { SettingsStore } from '../settings'
import { RuntimeDownloads } from './download'
import { RuntimeInstaller } from './installer'
import { discoverDsh, inspectDsh } from './discovery'
import { runtimePaths, runtimeEnvironment } from './platform'
import { redactLog, startDsh, runProgram } from './process'
import { directoryHasData, officialDshHome, resolveDshHome } from '../dsh-home'
import { migrateDshHome } from '../data-migration'

type RunningDsh = Awaited<ReturnType<typeof startDsh>>
interface Job { kind: LocalAction; controller: AbortController; promise: Promise<void> }

/** Owns one local DSH instance and one cancellable operation, independent of remote connection IPC. */
export class LocalRuntimeManager {
  readonly paths: ReturnType<typeof runtimePaths>
  private installer: RuntimeInstaller
  private downloads: RuntimeDownloads
  private state: Omit<LocalRuntimeState, 'installation'>
  private job: Job | null = null
  private running: RunningDsh | null = null
  private disposed = false
  private disposing?: Promise<void>
  private logQueue: Promise<void> = Promise.resolve()
  constructor(private store: SettingsStore, private userData: string, private supervisor: string, private callbacks: {
    changed: () => void
    ready: (url: string, launchUrl: string, signal: AbortSignal) => Promise<void>
    stopped: () => void
    resolveProxy?: (url: string) => Promise<string>
  }) {
    this.paths = runtimePaths(userData)
    this.downloads = new RuntimeDownloads(callbacks.resolveProxy)
    this.installer = new RuntimeInstaller(this.paths, this.downloads, supervisor)
    this.state = { process: 'stopped', operation: null, candidates: [], latestVersion: null, error: null, logs: [], dataDirectory: this.home.directory, runtimeDirectory: this.paths.root,
      home: { selection: store.snapshot.local.home, profile: this.home.profile, officialDirectory: officialDshHome(), legacyDirectory: this.paths.home, migrationPending: store.snapshot.local.migrationPending, legacyHasData: false, targetHasData: false, backupDirectory: store.snapshot.local.backupDirectory },
    }
  }
  get home() { return resolveDshHome(this.store.snapshot.local.home, this.userData) }
  get snapshot(): LocalRuntimeState {
    const local = this.store.snapshot.local
    return structuredClone({ ...this.state, dataDirectory: this.home.directory, home: { ...this.state.home, selection: local.home, profile: this.home.profile, migrationPending: local.migrationPending, backupDirectory: local.backupDirectory }, installation: local.installation })
  }
  get url(): string | null { return this.running?.url ?? null }

  async initialize(): Promise<void> {
    const history = await readFile(this.paths.log, 'utf8').catch(() => '')
    this.state.logs = history.split('\n').filter(Boolean).slice(-100).map(redactLog)
    await this.refreshHome()
  }
  private async refreshHome(): Promise<void> {
    const results = await Promise.allSettled([directoryHasData(this.paths.home), directoryHasData(officialDshHome())])
    const hasData = (result: PromiseSettledResult<boolean>) => result.status === 'fulfilled' ? result.value : true
    this.state.home = { ...this.state.home, legacyHasData: hasData(results[0]), targetHasData: hasData(results[1]) }
    if (results.some(result => result.status === 'rejected')) this.state.error = '无法检查 DSH 数据目录，请在本机管理中检查路径和访问权限'
    this.changed()
  }
  private changed(): void { if (!this.disposed) this.callbacks.changed() }
  private log(message: string): void {
    const clean = redactLog(message.trim()).slice(0, 1500)
    if (!clean) return
    const line = `${new Date().toISOString()} ${clean}`
    this.state.logs = [...this.state.logs, line].slice(-150)
    this.logQueue = this.logQueue.then(async () => {
      await mkdir(this.paths.root, { recursive: true })
      const size = await stat(this.paths.log).then(info => info.size, () => 0)
      if (size > 256 * 1024) await writeFile(this.paths.log, `${this.state.logs.join('\n')}\n`, { mode: 0o600 })
      else await appendFile(this.paths.log, `${line}\n`, { mode: 0o600 })
    }).catch(() => { /* In-memory diagnostics remain available when disk logging fails. */ })
    this.changed()
  }
  private progress(stage: string, progress: number | null = null): void {
    if (!this.state.operation) return
    this.state.operation = { ...this.state.operation, stage, progress }
    this.changed()
  }
  private begin(kind: LocalAction, operation: (signal: AbortSignal) => Promise<void>): void {
    if (this.disposed) throw new Error('本机运行环境已关闭')
    if (this.job) {
      if (this.job.kind === kind || kind === 'start' && this.job.kind === 'install') return
      throw new Error('请等待当前操作完成，或先取消当前操作')
    }
    const controller = new AbortController()
    const job: Job = { kind, controller, promise: Promise.resolve() }
    this.job = job
    this.state.error = null
    this.state.operation = { kind, stage: '准备中', progress: null, cancellable: kind !== 'stop' }
    job.promise = Promise.resolve().then(() => operation(controller.signal)).catch(error => {
      const message = controller.signal.aborted ? '操作已取消' : error instanceof Error ? redactLog(error.message) : '本机操作失败'
      this.state.error = message
      this.log(message)
    }).finally(() => {
      if (this.job === job) { this.job = null; this.state.operation = null; this.changed() }
    })
    this.changed()
  }

  command(command: LocalCommand): void {
    switch (command.type) {
      case 'local.cancel':
        this.job?.controller.abort()
        break
      case 'local.detect':
        this.begin('detect', async signal => {
          this.progress('检测本机已有 DSH 与 Node.js')
          this.state.candidates = await discoverDsh(signal)
          this.log(`检测完成：找到 ${this.state.candidates.length} 个可用 DSH 安装`)
        })
        break
      case 'local.check-update':
        this.begin('check-update', async signal => {
          this.progress('查询官方 npm 版本')
          this.state.latestVersion = (await this.installer.metadata('latest', signal)).version
          this.log(`官方 npm 当前版本：${this.state.latestVersion}`)
        })
        break
      case 'local.install':
      case 'local.use-existing':
        this.begin(command.type === 'local.install' ? 'install' : 'use-existing', async signal => {
          if (this.store.snapshot.local.migrationPending) throw new Error('请先选择使用官方数据目录、迁移旧数据，或继续旧环境')
          const existing = command.type === 'local.use-existing' ? await inspectDsh(command.cliPath, command.nodePath, signal) : undefined
          const metadata = await this.installer.metadata(command.type === 'local.install' ? command.version : existing!.version, signal)
          const previous = this.store.snapshot.local.installation
          if (previous && semver.lt(metadata.version, previous.version)) throw new Error('当前数据已使用较新 DSH，暂不支持自动降级运行环境')
          this.state.latestVersion = metadata.version
          this.log(`准备${existing ? '使用已有' : '安装官方'} DSH ${metadata.version}`)
          const installation = await this.installer.install(metadata.version, signal, (stage, value) => this.progress(stage, value), existing)
          signal.throwIfAborted()
          this.progress('停止旧进程并启用已验证的运行环境')
          await this.stop()
          signal.throwIfAborted()
          await this.store.update(settings => ({ ...settings, local: { ...settings.local, installation } }))
          this.log(`已选择 ${installation.source === 'managed' ? '托管' : '已有'} DSH ${installation.version}`)
          await this.start(signal)
        })
        break
      case 'local.start': this.begin('start', signal => this.start(signal)); break
      case 'local.stop': this.begin('stop', async () => { this.progress('停止本机 DSH'); await this.stop() }); break
      case 'local.restart': this.begin('restart', async signal => { await this.stop(); signal.throwIfAborted(); await this.start(signal) }); break
      case 'local.configure-home':
        this.begin('configure-home', async signal => {
          const target = resolveDshHome(command.selection, this.userData)
          const programRoot = path.resolve(this.paths.root)
          if (target.directory === programRoot || target.directory.startsWith(`${programRoot}${path.sep}`)) throw new Error('数据目录不能放在程序运行环境目录内')
          await directoryHasData(target.directory)
          this.progress('停止本机 DSH 并切换数据目录')
          await this.stop()
          signal.throwIfAborted()
          await this.store.update(settings => ({ ...settings, local: { ...settings.local, home: command.selection, migrationPending: false } }))
          await this.refreshHome()
          this.log(`数据目录已选择：${target.directory}；profile：${target.profile}`)
          if (this.store.snapshot.local.installation) await this.start(signal)
        })
        break
      case 'local.migrate-home':
        this.begin('migrate-home', async signal => {
          const installation = this.store.snapshot.local.installation
          if (!installation) throw new Error('需要已有 DSH 运行环境才能验证迁移，请先选择继续旧环境并完成安装')
          await this.stop()
          const result = await migrateDshHome({
            source: this.paths.home, destination: officialDshHome(), backups: path.join(this.userData, 'backups'), signal,
            progress: stage => this.progress(stage),
            validate: async stage => {
              const env = runtimeEnvironment(installation.nodePath, [path.dirname(installation.pnpmPath)])
              env.DSH_HOME = stage
              const profileDir = path.join(stage, 'profiles/web')
              const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
              if (manifest.dependencies && Object.keys(manifest.dependencies).length) {
                await runProgram(installation.nodePath, [path.join(installation.root, 'node_modules/pnpm/bin/pnpm.mjs'), 'install', '--dir', profileDir], { env, cwd: stage, signal, timeoutMs: 10 * 60_000, supervisor: this.supervisor })
              }
              await runProgram(installation.nodePath, [installation.cliPath, '--profile', 'web', '--dump-config'], { env, cwd: stage, signal, timeoutMs: 60_000, supervisor: this.supervisor })
            },
          })
          await this.store.update(settings => ({ ...settings, local: { ...settings.local, home: { mode: 'official' }, migrationPending: false, backupDirectory: result.backupDirectory } }))
          await this.refreshHome()
          this.log(`数据迁移完成，旧环境和备份保留：${result.backupDirectory}`)
          await this.start(signal)
        })
        break
      case 'local.open-data-directory':
      case 'local.copy-data-directory': break
    }
  }
  private async start(signal: AbortSignal): Promise<void> {
    if (this.running && this.state.process === 'running') return
    if (this.store.snapshot.local.migrationPending) throw new Error('请先确认旧环境的数据目录迁移选项')
    const installation = this.store.snapshot.local.installation
    if (!installation) throw new Error('请先安装或选择本机 DSH')
    this.progress('验证本机 DSH')
    await inspectDsh(installation.cliPath, installation.nodePath, signal)
    this.state.process = 'starting'
    this.progress('启动本机 DSH，等待服务就绪')
    const home = this.home
    this.log(`启动 DSH ${installation.version}（${home.profile} profile，系统分配端口）`)
    try {
      const running = await startDsh(installation, home.directory, signal, line => this.log(line), this.supervisor, home.profile)
      this.running = running
      void running.owner.closed.then(() => {
        if (this.running !== running) return
        this.running = null
        this.state.process = 'failed'
        this.state.error = '本机 DSH 进程已退出，可查看日志后重新启动'
        this.callbacks.stopped()
        this.log(this.state.error)
      })
      this.progress('服务已就绪，正在自动登录')
      await this.callbacks.ready(running.url, running.launchUrl, signal)
      signal.throwIfAborted()
      if (this.running !== running || running.owner.child.exitCode !== null) throw new Error('DSH 在登录时退出')
      this.state.process = 'running'
      await this.refreshHome()
      this.log(`本机 DSH 已就绪：${running.url}`)
    } catch (error) {
      await this.stop()
      this.state.process = signal.aborted ? 'stopped' : 'failed'
      throw error
    }
  }
  private async stop(): Promise<void> {
    const running = this.running
    this.running = null
    if (running) {
      this.state.process = 'stopping'
      this.callbacks.stopped()
      this.changed()
      await running.owner.stop()
      this.log('本机 DSH 已停止')
    }
    this.state.process = 'stopped'
    this.changed()
  }
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.disposed = true
      this.job?.controller.abort()
      await this.job?.promise
      await this.stop()
      await this.logQueue
      this.downloads.dispose()
    })()
  }
}
