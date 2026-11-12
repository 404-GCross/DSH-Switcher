import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import semver from 'semver'
import { z } from 'zod'
import type { ClientRelease, UpdateFormat, UpdatePreferences, UpdateState } from '../shared/types'
import type { SettingsStore } from './settings'
import { RuntimeDownloads } from './local-runtime/download'

const repository = '404-GCross/DSH-Switcher'
const execute = promisify(execFile)
const fileSchema = z.object({ name: z.string(), bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const manifestSchema = z.object({ version: z.string().max(80).refine(value => !!semver.valid(value)), commit: z.string().regex(/^[a-f0-9]{40}$/), platforms: z.array(z.object({ platform: z.string(), version: z.string(), commit: z.string(), files: z.array(fileSchema) })) })
const releaseSchema = z.object({ tag_name: z.string().regex(/^[a-zA-Z0-9._-]+$/), draft: z.boolean(), prerelease: z.boolean(), body: z.string().nullable(), published_at: z.string().nullable(), assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), size: z.number().int().positive() })) })

export function formatsFor(platform = process.platform): Exclude<UpdateFormat, 'auto'>[] {
  return platform === 'linux' ? ['rpm', 'deb', 'AppImage', 'tar.gz'] : platform === 'darwin' ? ['dmg', 'zip'] : ['zip']
}
export async function detectUpdateFormat(executable: string, platform = process.platform, env = process.env): Promise<Exclude<UpdateFormat, 'auto'>> {
  if (platform === 'darwin') return 'dmg'
  if (platform === 'win32') return 'zip'
  if (env.APPIMAGE) return 'AppImage'
  for (const [binary, args, format] of [
    ['dpkg-query', ['-S', executable], 'deb'], ['rpm', ['-qf', '--qf', '%{NAME}', executable], 'rpm'],
  ] as const) {
    try { if ((await execute(binary, [...args], { timeout: 2000, maxBuffer: 8192 })).stdout.includes('dsh-switcher')) return format } catch { /* Portable builds are not package-owned. */ }
  }
  return 'tar.gz'
}
function assetUrl(value: string, tag: string, filename: string): string {
  const expected = `https://github.com/${repository}/releases/download/${tag}/${filename}`
  if (value !== expected) throw new Error('发布文件地址与官方仓库不一致')
  return value
}
export function selectRelease(releaseValue: unknown, manifestValue: unknown, format: Exclude<UpdateFormat, 'auto'>, platform = process.platform, arch = process.arch): ClientRelease {
  const release = releaseSchema.parse(releaseValue), manifest = manifestSchema.parse(manifestValue)
  if (release.draft || !formatsFor(platform).includes(format) || !['x64', 'arm64'].includes(arch)) throw new Error('此平台没有对应的更新包')
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  const entry = manifest.platforms.find(item => item.platform === `${os}-${arch}`)
  if (!entry || entry.version !== manifest.version || entry.commit !== manifest.commit) throw new Error('更新清单中的平台或版本不匹配')
  const fileArch = platform === 'linux' && arch === 'x64' ? format === 'deb' ? 'amd64' : ['rpm', 'AppImage'].includes(format) ? 'x86_64' : arch : arch
  const filename = `DSH-Switcher-${manifest.version}-${os}-${fileArch}.${format}`
  const files = entry.files.filter(file => file.name === filename), assets = release.assets.filter(asset => asset.name === filename)
  if (files.length !== 1 || assets.length !== 1 || files[0].bytes !== assets[0].size) throw new Error('发布清单缺少匹配且完整的安装包')
  return { version: manifest.version, notes: (release.body ?? '').slice(0, 20000), url: `https://github.com/${repository}/releases/tag/${release.tag_name}`, publishedAt: release.published_at ?? '', filename, bytes: files[0].bytes, sha256: files[0].sha256, downloadUrl: assetUrl(assets[0].browser_download_url, release.tag_name, filename) }
}
async function verifiedFile(filename: string, release: ClientRelease): Promise<boolean> {
  try {
    if ((await stat(filename)).size !== release.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filename)) hash.update(chunk)
    return hash.digest('hex') === release.sha256
  } catch { return false }
}

export class ClientUpdater {
  private state: UpdateState = { status: 'idle', release: null, progress: null, error: null, detectedFormat: process.platform === 'darwin' ? 'dmg' : process.platform === 'win32' ? 'zip' : 'tar.gz', downloadedPath: null }
  private job: { controller: AbortController; promise: Promise<void> } | null = null
  private disposed = false
  private downloads: RuntimeDownloads
  constructor(private store: SettingsStore, private directory: string, private version: string, private callbacks: { changed: () => void; resolveProxy: (url: string) => Promise<string>; open: (file: string) => Promise<string>; reveal: (file: string) => void }, downloads?: RuntimeDownloads) {
    this.downloads = downloads ?? new RuntimeDownloads(callbacks.resolveProxy)
  }
  get snapshot(): UpdateState { return structuredClone(this.state) }
  async initialize(executable: string): Promise<void> { this.state.detectedFormat = await detectUpdateFormat(executable); if (!this.disposed) { this.callbacks.changed(); if (this.store.snapshot.updates.checkOnStartup) this.check() } }
  private publish(): void { if (!this.disposed) this.callbacks.changed() }
  private begin(status: 'checking' | 'downloading', operation: (signal: AbortSignal) => Promise<void>): void {
    if (this.disposed) throw new Error('更新管理已关闭')
    if (this.job) throw new Error('请等待当前更新操作完成，或先取消')
    const controller = new AbortController()
    this.state = { ...this.state, status, error: null, progress: null }
    const job = { controller, promise: Promise.resolve() }
    this.job = job
    job.promise = Promise.resolve().then(() => operation(controller.signal)).catch(() => {
      this.state.status = 'error'
      this.state.error = controller.signal.aborted ? '更新操作已取消' : status === 'checking' ? '检查更新失败，请检查网络、代理或发布渠道；稳定版可能尚未发布' : '下载失败或校验未通过，请重试'
    }).finally(() => { if (this.job === job) this.job = null; this.publish() })
    this.publish()
  }
  check(): void {
    this.begin('checking', async signal => {
      this.state.release = null; this.state.downloadedPath = null
      const prefs = this.store.snapshot.updates
      const release = releaseSchema.parse(await this.downloads.json(`https://api.github.com/repos/${repository}/releases/${prefs.channel === 'dev' ? 'tags/dev' : 'latest'}`, signal))
      if (release.draft || prefs.channel === 'stable' && release.prerelease) throw new Error('Unexpected release channel')
      const manifests = release.assets.filter(asset => /^build-manifest-[0-9a-zA-Z.+-]+\.json$/.test(asset.name))
      if (manifests.length !== 1) throw new Error('Missing unique manifest')
      const metadata = await this.downloads.json(assetUrl(manifests[0].browser_download_url, release.tag_name, manifests[0].name), signal)
      const format = prefs.format === 'auto' ? this.state.detectedFormat : prefs.format
      const selected = selectRelease(release, metadata, format)
      signal.throwIfAborted()
      this.state.release = selected
      this.state.status = semver.gt(selected.version, this.version) ? 'available' : 'current'
    })
  }
  async configure(value: UpdatePreferences): Promise<void> {
    if (this.job) throw new Error('请先完成或取消更新操作')
    if (value.format !== 'auto' && !formatsFor().includes(value.format)) throw new Error('安装包类型不适用于当前系统')
    await this.store.update(settings => ({ ...settings, updates: value }))
    this.state = { ...this.state, status: 'idle', release: null, downloadedPath: null, error: null, progress: null }
    this.publish()
  }
  download(): void {
    const release = this.state.release
    if (!release || !semver.gt(release.version, this.version)) throw new Error('请先检查可用的新版本')
    this.begin('downloading', async signal => {
      const folder = path.join(this.directory, 'updates', release.version)
      const filename = path.join(folder, release.filename), partial = `${filename}.part`
      this.state.downloadedPath = null
      await mkdir(folder, { recursive: true, mode: 0o700 })
      try {
        if (!await verifiedFile(filename, release)) {
          await rm(partial, { force: true })
          await this.downloads.file(release.downloadUrl, partial, release.sha256, signal, progress => { this.state.progress = progress; this.publish() })
          signal.throwIfAborted()
          if (!await verifiedFile(partial, release)) throw new Error('Size mismatch')
          await rename(partial, filename)
        }
        signal.throwIfAborted()
        this.state.downloadedPath = filename; this.state.status = 'downloaded'; this.state.progress = 100
      } finally { await rm(partial, { force: true }) }
    })
  }
  cancel(): void { this.job?.controller.abort() }
  async open(): Promise<void> {
    const { downloadedPath: file, release } = this.state
    if (!file || !release || !await verifiedFile(file, release)) throw new Error('下载文件缺失或已更改，请重新下载')
    if (/\.(rpm|deb|dmg)$/.test(file)) {
      const error = await this.callbacks.open(file)
      if (error) { this.callbacks.reveal(file); throw new Error('无法打开系统安装工具，已定位下载文件') }
    } else this.callbacks.reveal(file)
  }
  async dispose(): Promise<void> { this.disposed = true; this.cancel(); await this.job?.promise; this.downloads.dispose() }
}
