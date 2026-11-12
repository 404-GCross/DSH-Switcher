import path from 'node:path'
import os from 'node:os'
import { readdir } from 'node:fs/promises'
import type { DshHomeSelection } from '../shared/types'

export function officialDshHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const value = env.DSH_HOME?.trim()
  if (!value) return path.join(home, '.dsh')
  if (value === '~') return home
  if (/^~[/\\]/.test(value)) return path.resolve(home, value.slice(2))
  return path.resolve(value)
}

export function resolveDshHome(selection: DshHomeSelection, userData: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (selection.mode === 'legacy') return { directory: path.join(userData, 'local-dsh'), profile: 'switcher' as const }
  if (selection.mode === 'custom') {
    if (!path.isAbsolute(selection.directory)) throw new Error('DSH 数据目录必须是绝对路径')
    return { directory: path.resolve(selection.directory), profile: 'web' as const }
  }
  return { directory: officialDshHome(env, home), profile: 'web' as const }
}

export async function directoryHasData(directory: string): Promise<boolean> {
  try { return (await readdir(directory)).length > 0 } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('无法检查 DSH 数据目录，请检查路径和访问权限')
  }
}
