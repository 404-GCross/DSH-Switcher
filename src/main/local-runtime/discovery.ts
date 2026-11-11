import { access, readFile, realpath, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import semver from 'semver'
import { z } from 'zod'
import type { LocalCandidate } from '../../shared/types'
import { systemNodeCandidates, nodeFiles, runtimeEnvironment } from './platform'
import { runProgram } from './process'

export const packageMetadata = z.object({ name: z.literal('@deepseek-ai/dsh'), version: z.string().refine(value => !!semver.valid(value)), engines: z.object({ node: z.string().refine(value => !!semver.validRange(value)) }), bin: z.object({ dsh: z.string().min(1) }) })

export async function inspectNode(nodePath: string, signal: AbortSignal) {
  await access(nodePath)
  const output = await runProgram(nodePath, ['--version'], { signal, timeoutMs: 5000, env: runtimeEnvironment(nodePath) })
  const version = semver.clean(output)
  if (!version) throw new Error('无法识别 Node.js 版本')
  return { path: await realpath(nodePath), version }
}

export async function availableNodes(signal: AbortSignal): Promise<Array<{ path: string; version: string }>> {
  const candidates = systemNodeCandidates()
  for (const directory of [path.join(os.homedir(), '.nvm/versions/node'), path.join(os.homedir(), '.local/share/fnm/node-versions')]) {
    const entries = await readdir(directory).catch(() => [])
    for (const name of entries) candidates.push(path.join(directory, name, directory.includes('fnm') ? 'installation/bin/node' : 'bin/node'))
  }
  const nodes: Array<{ path: string; version: string }> = []
  for (const candidate of [...new Set(candidates)]) {
    signal.throwIfAborted()
    try {
      const node = await inspectNode(candidate, signal)
      if (!nodes.some(item => item.path === node.path)) nodes.push(node)
    } catch { signal.throwIfAborted() }
  }
  return nodes.sort((a, b) => semver.rcompare(a.version, b.version))
}

export async function findNpm(nodePath: string): Promise<string | null> {
  const actual = await realpath(nodePath)
  const candidates = [nodeFiles(path.dirname(path.dirname(actual))).npm, path.join(path.dirname(actual), 'node_modules/npm/bin/npm-cli.js')]
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate } catch { /* This Node distribution may not include npm. */ }
  }
  return null
}

async function findDshEntry(candidate: string): Promise<{ cliPath: string; version: string; engines: string }> {
  let actual = await realpath(candidate)
  if (/\.cmd$/i.test(actual)) actual = path.join(path.dirname(actual), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  let directory = path.dirname(actual)
  for (let i = 0; i < 5; i++) {
    try {
      const meta = packageMetadata.parse(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
      const entry = path.resolve(directory, meta.bin.dsh)
      if (entry !== actual) throw new Error('请选择官方 DSH CLI 入口')
      return { cliPath: actual, version: meta.version, engines: meta.engines.node }
    } catch { /* Walk upward from the npm CLI symlink to its package manifest. */ }
    directory = path.dirname(directory)
  }
  throw new Error('未找到官方 @deepseek-ai/dsh CLI；请选择 dsh 可执行文件或包内 lib/bin.js')
}

export async function inspectDsh(cliPath: string, nodePath: string, signal: AbortSignal): Promise<LocalCandidate> {
  if (!path.isAbsolute(cliPath) || !path.isAbsolute(nodePath)) throw new Error('请选择绝对路径')
  const [entry, node] = await Promise.all([findDshEntry(cliPath), inspectNode(nodePath, signal)])
  if (!semver.satisfies(node.version, entry.engines)) throw new Error(`DSH ${entry.version} 需要 Node.js ${entry.engines}，当前为 ${node.version}`)
  const version = await runProgram(node.path, [entry.cliPath, '--version'], { signal, timeoutMs: 15_000, env: runtimeEnvironment(node.path) })
  if (version.trim() !== entry.version) throw new Error('DSH CLI 版本验证失败')
  return { cliPath: entry.cliPath, nodePath: node.path, version: entry.version, nodeVersion: node.version }
}

export async function discoverDsh(signal: AbortSignal): Promise<LocalCandidate[]> {
  const nodes = await availableNodes(signal)
  const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const dirs = searchPath.split(path.delimiter).filter(Boolean)
  dirs.push(path.join(os.homedir(), '.npm-global/bin'), path.join(os.homedir(), '.local/bin'))
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  const candidates: LocalCandidate[] = []
  for (const dir of [...new Set(dirs)]) {
    const cli = path.join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    try { await access(cli) } catch { continue }
    for (const node of nodes) {
      try {
        const entry = await inspectDsh(cli, node.path, signal)
        if (!candidates.some(item => item.cliPath === entry.cliPath)) candidates.push(entry)
        break
      } catch { signal.throwIfAborted() }
    }
  }
  return candidates
}
