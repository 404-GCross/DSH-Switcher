import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-local 空间-'))
const version = process.env.SWITCHER_TEST_DSH_VERSION ?? '0.2.2-rc.1'
const localId = '00000000-0000-4000-8000-000000000001'
await mkdir('test-results', { recursive: true })
let client, page
async function launch() {
  const args = process.env.SWITCHER_TEST_EXECUTABLE ? [] : [process.cwd()]
  if (process.env.SWITCHER_TEST_HEADLESS === '1') args.push('--ozone-platform=headless', '--disable-gpu')
  client = await electron.launch({ executablePath: process.env.SWITCHER_TEST_EXECUTABLE, args, env: {
    ...process.env, SWITCHER_USER_DATA: directory, SWITCHER_DEV_URL: '', SWITCHER_TEST_FORCE_NODE_DOWNLOAD: '1',
  }, timeout: 30000 })
  await expect.poll(() => client.windows().some(p => p.url().includes('/renderer/index.html') && !p.url().includes('surface=overlay')), { timeout: 15000 }).toBe(true)
  page = client.windows().find(p => p.url().includes('/renderer/index.html') && !p.url().includes('surface=overlay'))
}
const state = () => page.evaluate(() => window.desktop.state())
async function command(value) {
  const result = await page.evaluate(value => window.desktop.command(value), value)
  assert.equal(result.ok, true, result.ok ? '' : result.error)
}
async function waitForOperation(timeout = 20 * 60_000) {
  let stage = ''
  await expect.poll(async () => {
    const current = await state()
    if (current.local.operation?.stage && current.local.operation.stage !== stage) {
      stage = current.local.operation.stage
      console.log(`Local runtime: ${stage}`)
    }
    return current.local.operation === null
  }, { timeout, intervals: [100, 250, 500, 1000] }).toBe(true)
  return (await state()).local
}
try {
  await launch()
  await command({ type: 'local.install', version })
  await command({ type: 'local.cancel' })
  let local = await waitForOperation(30000)
  assert.equal(local.installation, null)
  assert.match(local.error, /取消/)

  await command({ type: 'local.install', version })
  // The installer is independent of the shell's command queue.
  await command({ type: 'overlay', overlay: { kind: 'instances' } })
  assert.equal((await state()).overlay.kind, 'instances')
  await command({ type: 'overlay', overlay: { kind: 'local' } })
  local = await waitForOperation()
  if (local.error) {
    await writeFile('test-results/local-runtime-error.txt', `${local.error}\n${local.logs.join('\n')}`)
    throw new Error(local.error)
  }
  assert.equal(local.process, 'running')
  assert.equal(local.installation.version, version)
  const nodeRoot = await realpath(path.join(directory, 'local-runtime', 'node'))
  const installedNode = await realpath(local.installation.nodePath)
  assert.ok(installedNode.startsWith(`${nodeRoot}${path.sep}`))
  await expect.poll(async () => (await state()).servers.find(item => item.id === localId)?.status, { timeout: 30000 }).toBe('ready')
  const url = (await state()).servers.find(item => item.id === localId).url
  assert.equal(new URL(url).hostname, '127.0.0.1')
  assert.equal(new URL(url).search, '')
  const config = await readFile(path.join(directory, 'settings.json'), 'utf8')
  assert.equal(config.includes('token='), false)
  assert.equal(JSON.parse(config).version, 2)
  await command({ type: 'overlay', overlay: { kind: 'local' } })
  const panel = client.windows().find(p => p.url().includes('surface=overlay'))
  await expect(panel.getByRole('heading', { name: '本机 DSH' })).toBeVisible()
  await panel.screenshot({ path: 'test-results/local-runtime-installed.png', omitBackground: true })
  await command({ type: 'local.stop' })
  assert.equal((await waitForOperation(15000)).process, 'stopped')

  // Install an ordinary external Cordis bundle through the real official CLI and managed pnpm.
  const plugin = path.join(directory, 'fixture-plugin')
  await mkdir(plugin)
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'switcher-runtime-smoke-plugin', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(path.join(plugin, 'index.js'), 'export const name = "switcher-runtime-smoke"; export function apply() { console.log("SWITCHER_SMOKE_PLUGIN_READY") }\n')
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: switcher-runtime-smoke\n      name: switcher-runtime-smoke-plugin\n')
  const { installation, dataDirectory } = (await state()).local
  const env = { ...process.env, DSH_HOME: dataDirectory }
  const oldPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = [path.dirname(installation.nodePath), path.dirname(installation.pnpmPath), oldPath].join(path.delimiter)
  delete env.NODE_OPTIONS
  const execute = promisify(execFile)
  await execute(installation.nodePath, [installation.cliPath, 'plugin', '--profile', 'switcher', 'add', plugin], { env, cwd: dataDirectory, timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  await command({ type: 'local.start' })
  local = await waitForOperation(120000)
  assert.equal(local.process, 'running', local.error ?? '')
  assert.ok(local.logs.some(line => line.includes('SWITCHER_SMOKE_PLUGIN_READY')))
  const selected = local.installation.cliPath
  await command({ type: 'local.install', version: 'not-a-version' })
  local = await waitForOperation(15000)
  assert.equal(local.installation.cliPath, selected)
  assert.equal(local.process, 'running')
  assert.ok(local.error)

  // Re-select a verified existing CLI; only the plugin tooling is installed by the client.
  await command({ type: 'local.use-existing', cliPath: local.installation.cliPath, nodePath: local.installation.nodePath })
  local = await waitForOperation()
  assert.equal(local.process, 'running', local.error ?? '')
  assert.equal(local.installation.source, 'existing')
  assert.equal(local.installation.cliPath, selected)
  await client.close(); client = undefined

  await launch()
  local = await waitForOperation(120000)
  await expect.poll(async () => (await state()).local.process, { timeout: 120000 }).toBe('running')
  assert.equal((await state()).local.installation.version, version)
  console.log('PASS: cancel, cold Node download, official DSH installation, responsive IPC, auto login, stop/start, plugin install/load, failed update preservation, existing CLI selection and restart')
} catch (error) {
  if (page && !page.isClosed()) {
    const current = await state().catch(() => null)
    if (current) await writeFile('test-results/local-runtime-state.json', JSON.stringify(current.local, null, 2))
  }
  throw error
} finally {
  await client?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
