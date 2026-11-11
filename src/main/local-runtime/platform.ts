import path from 'node:path'
import os from 'node:os'

export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const PNPM_VERSION = '11.28.5'

export function platformTarget(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`暂不支持 ${platform}/${arch} 的本机安装`)
  return { platform, arch, nodePlatform: platform === 'win32' ? 'win' : platform, archive: platform === 'win32' ? 'zip' : 'tar.gz' }
}

export function runtimePaths(userData: string) {
  const root = path.join(userData, 'local-runtime')
  return {
    root, nodes: path.join(root, 'node'), installs: path.join(root, 'installs'),
    staging: path.join(root, 'staging'), lock: path.join(root, 'install.lock'),
    home: path.join(userData, 'local-dsh'), log: path.join(root, 'runtime.log'),
  }
}
export type RuntimePaths = ReturnType<typeof runtimePaths>

export function nodeFiles(root: string, platform = process.platform) {
  return platform === 'win32'
    ? { node: path.join(root, 'node.exe'), npm: path.join(root, 'node_modules/npm/bin/npm-cli.js') }
    : { node: path.join(root, 'bin/node'), npm: path.join(root, 'lib/node_modules/npm/bin/npm-cli.js') }
}

export function runtimeEnvironment(nodePath: string, bins: string[] = []): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const previous = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  // The selected official Node owns native-module ABI and npm lifecycle commands.
  delete env.npm_config_runtime
  delete env.npm_config_target
  env.PATH = [path.dirname(nodePath), ...bins, previous].filter(Boolean).join(path.delimiter)
  return env
}

export function systemNodeCandidates(env = process.env, platform = process.platform): string[] {
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const paths = searchPath.split(platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => path.join(dir, name))
  if (platform === 'win32') paths.push(path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', name))
  else paths.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node', path.join(os.homedir(), '.volta/bin/node'))
  return [...new Set(paths)]
}
