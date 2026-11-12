import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { officialDshHome, resolveDshHome, directoryHasData } from '../src/main/dsh-home'
import { migrateDshHome } from '../src/main/data-migration'

test('home precedence is explicit directory, inherited DSH_HOME, then home/.dsh; legacy retains its profile', () => {
  const home = path.resolve('test-home'), custom = path.join(home, 'custom'), inherited = path.join(home, 'inherited')
  assert.equal(officialDshHome({}, home), path.join(home, '.dsh'))
  assert.equal(officialDshHome({ DSH_HOME: '~/shared' }, home), path.join(home, 'shared'))
  assert.deepEqual(resolveDshHome({ mode: 'official' }, home, { DSH_HOME: inherited }), { directory: inherited, profile: 'web' })
  assert.deepEqual(resolveDshHome({ mode: 'custom', directory: custom }, home, { DSH_HOME: inherited }), { directory: custom, profile: 'web' })
  assert.deepEqual(resolveDshHome({ mode: 'legacy' }, home, { DSH_HOME: inherited }), { directory: path.join(home, 'local-dsh'), profile: 'switcher' })
  assert.throws(() => resolveDshHome({ mode: 'custom', directory: 'relative' }, home))
})

async function fixture(run: (options: Parameters<typeof migrateDshHome>[0], root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-migration-'))
  const source = path.join(root, 'legacy'), destination = path.join(root, 'official')
  await mkdir(path.join(source, 'profiles/switcher/node_modules'), { recursive: true })
  await writeFile(path.join(source, 'profiles/switcher/package.json'), JSON.stringify({ name: 'dsh-profile-switcher', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  await writeFile(path.join(source, 'profiles/switcher/cordis.patch.yml'), '- id: llm-pi-ai\n  config: {}\n')
  await writeFile(path.join(source, '.credentials.yaml'), 'version: 1\nrefs: { TEST: fixture-only }\n')
  await writeFile(path.join(source, 'session.json'), '{"conversation":"preserve"}')
  await writeFile(path.join(source, 'user.lock'), 'user file, not a runtime lock')
  await writeFile(path.join(source, 'profiles/switcher/node_modules/excluded'), 'reinstall')
  try { await run({ source, destination, backups: path.join(root, 'backups'), signal: new AbortController().signal, progress: () => {}, validate: async () => {} }, root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('migration preserves source, credentials, sessions and backup; stages web before publishing', () => fixture(async options => {
  await mkdir(options.destination)
  const result = await migrateDshHome({ ...options, validate: async stage => {
    assert.equal(await directoryHasData(options.destination), false)
    const profile = JSON.parse(await readFile(path.join(stage, 'profiles/web/package.json'), 'utf8'))
    assert.equal(profile.name, 'dsh-profile-web')
    assert.equal(profile.dsh.profile.bundles.length, 2)
    assert.deepEqual(await readdir(path.join(stage, 'profiles')), ['web'])
    assert.equal(await directoryHasData(path.join(stage, 'profiles/web/node_modules')), false)
  } })
  for (const file of ['.credentials.yaml', 'session.json', 'user.lock']) {
    assert.equal(await readFile(path.join(options.destination, file), 'utf8'), await readFile(path.join(options.source, file), 'utf8'))
    assert.equal(await readFile(path.join(result.backupDirectory, file), 'utf8'), await readFile(path.join(options.source, file), 'utf8'))
  }
  assert.deepEqual(await readdir(path.join(options.source, 'profiles')), ['switcher'])
}))

for (const failure of ['populated target', 'validation', 'cancelled', 'target changed', 'conflicting profiles'] as const) {
  test(`migration refuses ${failure} without replacing data and cleans its stage`, () => fixture(async (options, root) => {
    const controller = new AbortController()
    const sentinel = path.join(options.destination, 'existing')
    if (failure === 'populated target') { await mkdir(options.destination); await writeFile(sentinel, 'keep') }
    if (failure === 'conflicting profiles') await mkdir(path.join(options.source, 'profiles/web'))
    await assert.rejects(migrateDshHome({ ...options, signal: controller.signal, validate: async () => {
      if (failure === 'validation') throw new Error('invalid config')
      if (failure === 'cancelled') controller.abort()
      if (failure === 'target changed') { await mkdir(options.destination); await writeFile(sentinel, 'keep') }
    } }))
    assert.equal(await readFile(path.join(options.source, 'session.json'), 'utf8'), '{"conversation":"preserve"}')
    if (failure === 'populated target' || failure === 'target changed') assert.equal(await readFile(sentinel, 'utf8'), 'keep')
    else assert.equal(await directoryHasData(options.destination), false)
    assert.equal((await readdir(root)).some(name => name.startsWith('.dsh-switcher-import-')), false)
  }))
}

test('migration rejects equal, nested and aliased paths and recursive backups', () => fixture(async options => {
  for (const destination of [options.source, path.join(options.source, 'nested'), path.dirname(options.source)]) await assert.rejects(migrateDshHome({ ...options, destination }), /互相包含/)
  await assert.rejects(migrateDshHome({ ...options, backups: path.join(options.source, 'backups') }), /备份目录/)
  await symlink(options.source, options.destination, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(migrateDshHome(options), /相同/)
}))

test('external symlinks are not followed or copied into a published home', () => fixture(async (options, root) => {
  const external = path.join(root, 'external')
  await mkdir(external)
  await writeFile(path.join(external, 'important'), 'untouched')
  await symlink(external, path.join(options.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(migrateDshHome(options), /符号链接/)
  assert.equal(await directoryHasData(options.destination), false)
  assert.equal(await readFile(path.join(external, 'important'), 'utf8'), 'untouched')
}))
