import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SettingsStore } from '../src/main/settings'
import { LOCAL_SERVER_ID } from '../src/shared/types'

async function fixture(run: (directory: string) => Promise<void>) {
  const root = process.env.SWITCHER_TEST_TMP ?? os.tmpdir()
  const dir = await mkdtemp(path.join(root, 'dsh-switcher-test-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('concurrent settings operations do not lose each other and survive restart', () => fixture(async directory => {
  const filename = path.join(directory, 'settings.json')
  const store = new SettingsStore(filename)
  await store.load()
  const ids = [randomUUID(), randomUUID()]
  await Promise.all(ids.map((id, index) => store.update(settings => ({ ...settings, servers: [...settings.servers, { id, name: `Server ${index}`, url: `https://server${index}.example/` }] }))))
  await store.update(settings => ({ ...settings, defaultId: ids[1], theme: 'dark' }))
  const restarted = new SettingsStore(filename)
  await restarted.load()
  assert.deepEqual(restarted.snapshot, store.snapshot)
  assert.equal(restarted.snapshot.servers.length, 2)
}))

test('configuration containing credentials or an unknown default is rejected and preserved', () => fixture(async directory => {
  const filename = path.join(directory, 'settings.json')
  const source = JSON.stringify({ version: 1, servers: [{ id: randomUUID(), name: 'Server', url: 'https://example.com/?token=secret' }], defaultId: null, theme: 'light' })
  await writeFile(filename, source)
  await assert.rejects(new SettingsStore(filename).load())
  assert.equal(await readFile(filename, 'utf8'), source)
  const store = new SettingsStore(path.join(directory, 'new.json'))
  await assert.rejects(store.update(settings => ({ ...settings, defaultId: randomUUID() })))
}))

test('failed filesystem write leaves the previous in-memory settings usable', () => fixture(async directory => {
  const filename = path.join(directory, 'blocked.json')
  const store = new SettingsStore(filename)
  await mkdir(filename)
  await assert.rejects(store.update(settings => ({ ...settings, theme: 'dark' })))
  assert.equal(store.snapshot.theme, 'system')
  await rm(filename, { recursive: true })
  await store.update(settings => ({ ...settings, theme: 'light' }))
  assert.equal(store.snapshot.theme, 'light')
}))

test('v1 settings migrate with a backup while keeping remote identities and default selection', () => fixture(async directory => {
  const filename = path.join(directory, 'settings.json')
  const id = randomUUID()
  const original = JSON.stringify({ version: 1, servers: [{ id, name: 'NAS', url: 'http://10.10.10.101:3080/' }], defaultId: id, theme: 'dark' })
  await writeFile(filename, original)
  const store = new SettingsStore(filename)
  await store.load()
  assert.equal(store.snapshot.version, 3)
  assert.equal(store.snapshot.defaultId, id)
  assert.equal(store.snapshot.local.installation, null)
  assert.deepEqual(store.snapshot.local.home, { mode: 'official' })
  assert.equal(store.snapshot.local.migrationPending, false)
  assert.equal(store.snapshot.desktop.closeBehavior, 'tray')
  assert.equal(await readFile(`${filename}.v1.bak`, 'utf8'), original)
  await store.update(settings => ({ ...settings, defaultId: LOCAL_SERVER_ID }))
  assert.equal(store.snapshot.defaultId, LOCAL_SERVER_ID)
}))

test('v2 legacy data requires a decision and keeps a byte-identical backup across restarts', () => fixture(async directory => {
  const filename = path.join(directory, 'settings.json')
  const original = JSON.stringify({ version: 2, servers: [], defaultId: LOCAL_SERVER_ID, theme: 'system', local: { installation: null } })
  await mkdir(path.join(directory, 'local-dsh'))
  await writeFile(path.join(directory, 'local-dsh', 'session.json'), 'preserve-me')
  await writeFile(filename, original)
  const store = new SettingsStore(filename)
  await store.load()
  assert.equal(store.snapshot.local.migrationPending, true)
  assert.deepEqual(store.snapshot.local.home, { mode: 'legacy' })
  await store.update(settings => ({ ...settings, local: { ...settings.local, migrationPending: false, home: { mode: 'official' } } }))
  const restarted = new SettingsStore(filename)
  await restarted.load()
  assert.equal(restarted.snapshot.local.migrationPending, false)
  assert.equal(await readFile(`${filename}.v2.bak`, 'utf8'), original)
  assert.equal(await readFile(path.join(directory, 'local-dsh', 'session.json'), 'utf8'), 'preserve-me')
}))
