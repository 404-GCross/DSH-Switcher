import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import semver from 'semver'
import { z } from 'zod'
import * as tar from 'tar'
import { extractNodeZip } from './archive'
import type { LocalInstallation, LocalCandidate } from '../../shared/types'
import { RuntimeDownloads } from './download'
import { availableNodes, findNpm, inspectNode, inspectDsh, packageMetadata } from './discovery'
import { DSH_PACKAGE, NPM_REGISTRY, PNPM_VERSION, nodeFiles, platformTarget, runtimeEnvironment } from './platform'
import type { RuntimePaths } from './platform'
import { runProgram } from './process'

export type InstallationProgress = (stage: string, percent?: number | null) => void

/** Prefer the qualified Node 24 LTS line; newer compatible LTS releases remain available for future DSH requirements. */
export function selectNodeRelease(releases: Array<{ version: string; lts: string | false }>, range: string) {
  const compatible = releases.filter(item => item.lts && semver.valid(item.version) && semver.satisfies(item.version, range))
  return compatible.sort((a, b) => {
    const aPreferred = semver.major(a.version) === 24, bPreferred = semver.major(b.version) === 24
    return aPreferred !== bPreferred ? aPreferred ? -1 : 1 : semver.rcompare(a.version, b.version)
  })[0]
}

/** Cross-process installation ownership; a dead owner's lock can be reclaimed. */
export async function acquireInstallLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(directory), { recursive: true })
  try { await mkdir(directory) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    const info = z.object({ pid: z.number().int().positive() }).safeParse(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8').catch(() => '{}')))
    if (!info.success) throw new Error('安装锁不可读取，请在确认没有安装任务后清理 local-runtime/install.lock')
    try { process.kill(info.data.pid, 0); throw new Error('另一个安装任务正在运行') } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause
    }
    const stale = `${directory}.stale-${randomUUID()}`
    await rename(directory, stale)
    await rm(stale, { recursive: true, force: true })
    await mkdir(directory)
  }
  try { await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }) } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return () => rm(directory, { recursive: true, force: true })
}

export class RuntimeInstaller {
  constructor(private paths: RuntimePaths, private downloads: RuntimeDownloads, private supervisor: string) {}
  async metadata(version: string, signal: AbortSignal) {
    if (version !== 'latest' && !semver.valid(version)) throw new Error('请输入有效的官方 DSH 版本号，或选择 latest')
    return packageMetadata.parse(await this.downloads.json(`${NPM_REGISTRY}/@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`, signal))
  }

  private async ensureNode(range: string, signal: AbortSignal, progress: InstallationProgress): Promise<{ node: string; npm: string }> {
    progress('检测 Node.js 运行环境')
    if (process.env.SWITCHER_TEST_FORCE_NODE_DOWNLOAD !== '1') {
      for (const candidate of await availableNodes(signal)) {
        if (semver.satisfies(candidate.version, range)) {
          const npm = await findNpm(candidate.path)
          if (npm) return { node: candidate.path, npm }
        }
      }
    }
    const target = platformTarget()
    const releases = z.array(z.object({ version: z.string(), lts: z.union([z.string(), z.literal(false)]) })).parse(await this.downloads.json('https://nodejs.org/dist/index.json', signal))
    const release = selectNodeRelease(releases, range)
    if (!release) throw new Error(`未找到满足 ${range} 的官方 Node.js LTS 版本`)
    const name = `node-${release.version}-${target.nodePlatform}-${target.arch}`
    const filename = `${name}.${target.archive}`
    const final = path.join(this.paths.nodes, name)
    const files = nodeFiles(final)
    try {
      if ((await inspectNode(files.node, signal)).version === semver.clean(release.version)) { await access(files.npm); return files }
    } catch { signal.throwIfAborted() }
    const stage = path.join(this.paths.staging, `node-${randomUUID()}`)
    await mkdir(stage, { recursive: true })
    try {
      const sums = await this.downloads.text(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`, signal)
      const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === filename)?.[0]
      if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) throw new Error('官方 Node.js 校验清单缺少对应平台文件')
      const archive = path.join(stage, filename)
      await this.downloads.file(`https://nodejs.org/dist/${release.version}/${filename}`, archive, expected, signal, value => progress(`下载 Node.js ${release.version}`, value))
      signal.throwIfAborted()
      progress('解压并验证 Node.js')
      if (target.archive === 'zip') await extractNodeZip(archive, stage, signal)
      else await tar.x({ file: archive, cwd: stage, strict: true, preservePaths: false })
      signal.throwIfAborted()
      const staged = nodeFiles(path.join(stage, name))
      if (process.platform !== 'win32') await chmod(staged.node, 0o755)
      if ((await inspectNode(staged.node, signal)).version !== semver.clean(release.version)) throw new Error('Node.js 版本不匹配')
      await access(staged.npm)
      await mkdir(this.paths.nodes, { recursive: true })
      // A damaged cached runtime is replaced only after the complete replacement verifies.
      const old = `${final}.old-${randomUUID()}`
      let hadOld = false
      try { await rename(final, old); hadOld = true } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      try { await rename(path.join(stage, name), final) } catch (error) {
        if (hadOld) await rename(old, final)
        throw error
      }
      if (hadOld) await rm(old, { recursive: true, force: true })
      return files
    } finally { await rm(stage, { recursive: true, force: true }) }
  }

  private async installPackages(stage: string, node: string, npm: string, packages: string[], signal: AbortSignal, progress: InstallationProgress): Promise<void> {
    const env = { ...runtimeEnvironment(node), ...await this.downloads.childProxyEnvironment(), npm_config_update_notifier: 'false' }
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'dsh-switcher-managed-runtime', private: true, version: '1.0.0' }))
    progress('安装官方 npm 包与平台依赖（首次安装可能需要数分钟）')
    // Raw npm output can include registry credentials. Only fixed progress labels leave this process.
    let failureCode = ''
    let lifecycle = ''
    let outputLine = ''
    try {
      await runProgram(node, [npm, 'install', '--prefix', stage, '--registry', NPM_REGISTRY, '--no-audit', '--no-fund', '--loglevel=info', '--save-exact', ...packages], {
        env, cwd: stage, signal, timeoutMs: 15 * 60_000, supervisor: this.supervisor,
        onOutput: text => {
          outputLine += text
          let end: number
          while ((end = outputLine.indexOf('\n')) !== -1) {
            const line = outputLine.slice(0, end); outputLine = outputLine.slice(end + 1)
            const code = /npm (?:error|ERR!) code ([A-Z0-9_]{1,40})\b/.exec(line)
            if (code) failureCode = code[1]
            const phase = /npm info run ((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][0-9A-Za-z.+-]*) (preinstall|install|postinstall|prepare)\b/.exec(line)
            if (phase) { lifecycle = `${phase[1]} ${phase[2]}`; progress(`安装依赖：${lifecycle}`) }
          }
          if (outputLine.length > 32768) outputLine = ''
        },
      })
    } catch (error) {
      signal.throwIfAborted()
      const timeout = error instanceof Error && 'code' in error && error.code === 'PROCESS_TIMEOUT'
      throw new Error(`官方 npm 包安装${timeout ? '超时' : '失败'}${failureCode ? `（${failureCode}）` : ''}${lifecycle ? `，最近阶段：${lifecycle}` : ''}，请检查网络、目录权限和运行依赖后重试`)
    }
    signal.throwIfAborted()
  }

  /** Publish a verified directory; the manager atomically selects it in settings afterwards. */
  async install(version: string, signal: AbortSignal, progress: InstallationProgress, existing?: LocalCandidate): Promise<LocalInstallation> {
    platformTarget()
    const unlock = await acquireInstallLock(this.paths.lock)
    const stage = path.join(this.paths.staging, `install-${randomUUID()}`)
    try {
      progress('读取官方 DSH 版本信息')
      const meta = await this.metadata(existing?.version ?? version, signal)
      const tools = await this.ensureNode(meta.engines.node, signal, progress)
      // An existing CLI must keep a compatible Node; npm may come from the selected official distribution.
      const node = existing?.nodePath ?? tools.node
      await mkdir(stage, { recursive: true })
      await this.installPackages(stage, tools.node, tools.npm, [...(existing ? [] : [`${DSH_PACKAGE}@${meta.version}`]), `pnpm@${PNPM_VERSION}`], signal, progress)
      const cliPath = existing?.cliPath ?? path.join(stage, 'node_modules/@deepseek-ai/dsh', meta.bin.dsh)
      progress('验证 DSH 和插件包管理器')
      const pnpmScript = path.join(stage, 'node_modules/pnpm/bin/pnpm.mjs')
      const pnpmOutput = await runProgram(node, [pnpmScript, '--version'], { signal, env: runtimeEnvironment(node) })
      if (pnpmOutput !== PNPM_VERSION) throw new Error('pnpm 版本验证失败')
      const info = await inspectDsh(cliPath, node, signal)
      if (info.version !== meta.version) throw new Error('安装结果与所选 DSH 版本不一致')
      signal.throwIfAborted()
      await mkdir(this.paths.installs, { recursive: true })
      const final = path.join(this.paths.installs, `${meta.version}-${randomUUID()}`)
      await rename(stage, final)
      return {
        source: existing ? 'existing' : 'managed', version: meta.version, nodePath: info.nodePath,
        cliPath: existing ? info.cliPath : path.join(final, path.relative(stage, cliPath)),
        pnpmPath: path.join(final, 'node_modules/.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), root: final,
      }
    } finally {
      try { await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } finally { await unlock() }
    }
  }
}
