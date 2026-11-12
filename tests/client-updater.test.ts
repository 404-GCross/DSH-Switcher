import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ClientUpdater, selectRelease } from '../src/main/client-updater'
import { RuntimeDownloads } from '../src/main/local-runtime/download'
import { SettingsStore } from '../src/main/settings'

const version = '0.2.0-dev.1.1', commit = 'a'.repeat(40), bytes = Buffer.from('verified release fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
function fixtureMetadata(platform = 'linux-x64', extension = 'deb', arch = 'amd64') {
  const os = platform.split('-')[0]
  const name = `DSH-Switcher-${version}-${os}-${arch}.${extension}`
  const url = (name: string) => `https://github.com/404-GCross/DSH-Switcher/releases/download/dev/${name}`
  const release = { tag_name: 'dev', draft: false, prerelease: true, body: 'test', published_at: '2026-11-12T00:00:00Z', assets: [{ name, browser_download_url: url(name), size: bytes.length }, { name: `build-manifest-${version}.json`, browser_download_url: url(`build-manifest-${version}.json`), size: 1000 }] }
  const manifest = { version, commit, platforms: [{ platform, version, commit, files: [{ name, bytes: bytes.length, sha256 }] }] }
  return { release, manifest }
}
test('release selection respects package format, CPU architecture and trusted asset identity', () => {
  const { release, manifest } = fixtureMetadata()
  assert.equal(selectRelease(release, manifest, 'deb', 'linux', 'x64').sha256, sha256)
  assert.throws(() => selectRelease(release, manifest, 'rpm', 'linux', 'x64'))
  assert.throws(() => selectRelease(release, manifest, 'deb', 'linux', 'arm64'))
  const mac = fixtureMetadata('mac-arm64', 'dmg', 'arm64')
  assert.equal(selectRelease(mac.release, mac.manifest, 'dmg', 'darwin', 'arm64').version, version)
  release.assets[0].browser_download_url = 'https://other.example/installer.deb'
  assert.throws(() => selectRelease(release, manifest, 'deb', 'linux', 'x64'), /地址/)
})
test('a mismatched manifest commit, missing package, or wrong byte count cannot become an update', () => {
  const { release, manifest } = fixtureMetadata()
  manifest.platforms[0].commit = 'b'.repeat(40)
  assert.throws(() => selectRelease(release, manifest, 'deb', 'linux', 'x64'), /不匹配/)
  manifest.platforms[0].commit = commit
  release.assets[0].size++
  assert.throws(() => selectRelease(release, manifest, 'deb', 'linux', 'x64'), /完整/)
})
test('updater verifies staged bytes and revalidates downloaded packages before opening', async () => {
  const dir = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-updater-'))
  const format = process.platform === 'linux' ? 'deb' : process.platform === 'darwin' ? 'dmg' : 'zip'
  const metadata = fixtureMetadata(`${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`, format, process.platform === 'linux' ? 'amd64' : process.arch)
  let corrupt = false, changed = () => {}, opened = 0
  class Downloads extends RuntimeDownloads {
    override async json(url: string): Promise<unknown> { return url.includes('/api.github.com/') ? metadata.release : metadata.manifest }
    override async file(_url: string, filename: string): Promise<void> { await writeFile(filename, corrupt ? 'bad bytes' : bytes) }
  }
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  await store.update(value => ({ ...value, updates: { ...value.updates, format } }))
  const updater = new ClientUpdater(store, dir, '0.1.0', { changed: () => changed(), resolveProxy: async () => 'DIRECT', open: async () => { opened++; return '' }, reveal: () => { opened++ } }, new Downloads())
  const settled = (start: () => void) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation did not settle')), 5000)
    changed = () => { if (!['checking', 'downloading'].includes(updater.snapshot.status)) { clearTimeout(timer); resolve() } }
    start()
  })
  try {
    await settled(() => updater.check())
    assert.equal(updater.snapshot.status, 'available')
    corrupt = true
    await settled(() => updater.download())
    assert.equal(updater.snapshot.status, 'error')
    assert.equal(updater.snapshot.downloadedPath, null)
    assert.deepEqual(await readdir(path.join(dir, 'updates', version)), [])
    corrupt = false
    await settled(() => updater.download())
    assert.equal(updater.snapshot.status, 'downloaded')
    const filename = updater.snapshot.downloadedPath!
    assert.deepEqual(await readFile(filename), bytes)
    await updater.open()
    assert.equal(opened, 1)
    await writeFile(filename, 'tampered')
    await assert.rejects(updater.open(), /已更改/)
    assert.equal(opened, 1)
  } finally { await updater.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('cancelling a download removes its partial file and never publishes an installation path', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-update-cancel-'))
  const format = process.platform === 'linux' ? 'deb' : process.platform === 'darwin' ? 'dmg' : 'zip'
  const metadata = fixtureMetadata(`${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`, format, process.platform === 'linux' ? 'amd64' : process.arch)
  let changed = () => {}, started!: () => void
  const downloading = new Promise<void>(resolve => { started = resolve })
  class Downloads extends RuntimeDownloads {
    override async json(url: string): Promise<unknown> { return url.includes('/api.github.com/') ? metadata.release : metadata.manifest }
    override async file(_url: string, filename: string, _hash: string, signal: AbortSignal): Promise<void> {
      await writeFile(filename, 'partial')
      const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      started(); return aborted
    }
  }
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  await store.update(value => ({ ...value, updates: { ...value.updates, format } }))
  const updater = new ClientUpdater(store, dir, '0.1.0', { changed: () => changed(), resolveProxy: async () => 'DIRECT', open: async () => '', reveal: () => {} }, new Downloads())
  try {
    await new Promise<void>(resolve => { changed = () => { if (updater.snapshot.status === 'available') resolve() }; updater.check() })
    const cancelled = new Promise<void>(resolve => { changed = () => { if (updater.snapshot.status === 'error') resolve() } })
    updater.download(); await downloading; updater.cancel(); await cancelled
    assert.match(updater.snapshot.error!, /取消/)
    assert.equal(updater.snapshot.downloadedPath, null)
    assert.deepEqual(await readdir(path.join(dir, 'updates', version)), [])
  } finally { await updater.dispose(); await rm(dir, { recursive: true, force: true }) }
})
