import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { directoryHasData } from './dsh-home'

async function canonicalTarget(directory: string): Promise<string> {
  try { return await realpath(directory) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = path.dirname(directory)
    if (parent === directory) throw error
    return path.join(await canonicalTarget(parent), path.basename(directory))
  }
}

/** Retain the old environment and a snapshot; publish only into an absent or empty destination. */
export async function migrateDshHome(options: {
  source: string; destination: string; backups: string; signal: AbortSignal
  progress: (stage: string) => void
  validate: (stage: string) => Promise<void>
}): Promise<{ backupDirectory: string }> {
  const { source, destination, signal } = options
  signal.throwIfAborted()
  const [from, to, backupRoot] = await Promise.all([canonicalTarget(source), canonicalTarget(destination), canonicalTarget(options.backups)])
  if (from === to || to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`)) throw new Error('旧目录与目标目录不能相同或互相包含')
  if ([from, to].some(dir => backupRoot === dir || backupRoot.startsWith(`${dir}${path.sep}`) || dir.startsWith(`${backupRoot}${path.sep}`))) throw new Error('备份目录不能与旧目录或目标目录互相包含')
  if (!await directoryHasData(source)) throw new Error('旧环境中没有可迁移的数据')
  if (await directoryHasData(destination)) throw new Error('目标目录已有数据，请选择使用现有环境；不会自动覆盖或合并')
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('迁移目标不能是符号链接，请选择实际目录')
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const profiles = await readdir(path.join(source, 'profiles'), { encoding: 'utf8' })
  if (profiles.includes('switcher') && profiles.includes('web')) throw new Error('旧环境同时存在 web 和 switcher 配置，请先选择要保留的配置，不自动合并')
  const backup = path.join(options.backups, `dsh-home-${Date.now()}-${randomUUID()}`)
  const stage = path.join(path.dirname(destination), `.dsh-switcher-import-${randomUUID()}`)
  const filter = async (name: string) => {
    signal.throwIfAborted()
    const leaf = path.basename(name)
    if (leaf === 'node_modules') return false
    if ((await lstat(name)).isSymbolicLink()) throw new Error('旧数据目录包含符号链接，请先处理链接，或选择继续使用旧环境')
    return true
  }
  await mkdir(backup, { recursive: true, mode: 0o700 })
  options.progress('备份旧 DSH 配置、凭据与会话')
  await cp(source, backup, { recursive: true, filter, preserveTimestamps: true, verbatimSymlinks: true })
  await chmod(backup, 0o700)
  signal.throwIfAborted()
  await mkdir(stage, { recursive: true, mode: 0o700 })
  let published = false
  try {
    options.progress('准备标准 web profile')
    await cp(backup, stage, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    await chmod(stage, 0o700)
    if (profiles.includes('switcher')) {
      await rename(path.join(stage, 'profiles/switcher'), path.join(stage, 'profiles/web'))
      const filename = path.join(stage, 'profiles/web/package.json')
      const manifest = JSON.parse(await readFile(filename, 'utf8'))
      if (!manifest.dsh?.profile || !Array.isArray(manifest.dsh.profile.bundles)) throw new Error('旧 profile 清单格式无效，已保留备份')
      manifest.name = 'dsh-profile-web'
      await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    signal.throwIfAborted()
    options.progress('恢复插件依赖并验证迁移后的 DSH 配置')
    await options.validate(stage)
    signal.throwIfAborted()
    if (await directoryHasData(destination)) throw new Error('目标目录在迁移期间出现数据，已停止切换并保留备份')
    try { await rmdir(destination) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    await rename(stage, destination)
    published = true
    return { backupDirectory: backup }
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
