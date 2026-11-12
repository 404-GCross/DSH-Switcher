import { _electron as electron, expect } from '@playwright/test'
import { cp, mkdtemp, mkdir, readFile, writeFile, realpath, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import YAML from 'yaml'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

const directory = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-local 空间-'))
const version = process.env.SWITCHER_TEST_DSH_VERSION ?? '0.2.2-rc.1'
const localId = '00000000-0000-4000-8000-000000000001'
const officialHome = path.join(directory, 'official-home')
let failModel = false
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the synthetic prompt without logging it. */ }
  await new Promise(resolve => setTimeout(resolve, 600))
  if (failModel) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture rejection', type: 'invalid_request_error', code: 'invalid_api_key' } })); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish_reason = null) => ({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })
  response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Fixture task completed.' }))}\n\n`)
  response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
  response.end('data: [DONE]\n\n')
})
modelServer.listen(0, '127.0.0.1')
await once(modelServer, 'listening')
const modelURL = `http://127.0.0.1:${modelServer.address().port}/v1`
await mkdir('test-results', { recursive: true })
let client, page
async function launch() {
  const args = process.env.SWITCHER_TEST_EXECUTABLE ? [] : [process.cwd()]
  if (process.env.SWITCHER_TEST_HEADLESS === '1') args.push('--ozone-platform=headless', '--disable-gpu')
  client = await electron.launch({ executablePath: process.env.SWITCHER_TEST_EXECUTABLE, args, env: {
    ...process.env, DSH_HOME: officialHome, SWITCHER_USER_DATA: directory, SWITCHER_DEV_URL: '', SWITCHER_TEST_FORCE_NODE_DOWNLOAD: '1',
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
  // Same profile patch and credential-reference shape that CC Switch writes. No live API key or model call.
  await mkdir(path.join(officialHome, 'profiles/web'), { recursive: true })
  await writeFile(path.join(officialHome, 'profiles/web/cordis.patch.yml'), YAML.stringify([{ id: 'llm-pi-ai', config: { providers: { 'switcher-cc-fixture': {
    displayName: 'CC Switch fixture', api: 'openai-completions', baseURL: modelURL, apiKeyEnv: 'CC_SWITCH_FIXTURE_KEY',
    models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 32768 }],
  } } } }]))
  await writeFile(path.join(officialHome, '.credentials.yaml'), YAML.stringify({ version: 1, refs: { CC_SWITCH_FIXTURE_KEY: 'fixture-only-not-a-real-key' } }), { mode: 0o600 })
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
  await command({ type: 'save', name: 'Offline remote fixture', url: 'http://127.0.0.1:1/' })
  const remoteId = (await state()).activeId
  await client.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  local = await waitForOperation()
  if (local.error) {
    await writeFile('test-results/local-runtime-error.txt', `${local.error}\n${local.logs.join('\n')}`)
    throw new Error(local.error)
  }
  assert.equal(local.process, 'running')
  await command({ type: 'desktop.show' })
  assert.equal(await realpath(local.dataDirectory), await realpath(officialHome))
  assert.equal(local.home.profile, 'web')
  assert.equal((await state()).activeId, remoteId, 'Late local readiness must not replace the selected remote page')
  await command({ type: 'select', id: localId })
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
  assert.equal(JSON.parse(config).version, 4)
  const localPageId = await client.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).id, url)
  await command({ type: 'select', id: remoteId })
  assert.equal((await state()).local.process, 'running')
  await expect.poll(() => client.evaluate(({ webContents }, id) => !!webContents.fromId(id), localPageId)).toBe(false)
  await command({ type: 'select', id: localId })
  await expect.poll(async () => (await state()).servers.find(item => item.id === localId)?.status, { timeout: 30000 }).toBe('ready')
  assert.equal((await state()).servers.find(item => item.id === localId).url, url, 'Switching pages must not restart local DSH')
  assert.notEqual(await client.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).id, url), localPageId)
  await command({ type: 'default', id: localId })

  // Observe real official DSH turns while its webpage has been destroyed and the window closed.
  await command({ type: 'notifications.configure', value: { enabled: true, quiet: true, sound: false, serverIds: [localId] } })
  await expect.poll(async () => (await state()).notifications.monitors.find(item => item.serverId === localId)?.status, { timeout: 30000 }).toBe('connected')
  async function rpc(endpoint, request) {
    const response = await client.evaluate(async ({ session }, input) => {
      const reply = await session.fromPartition(`persist:dsh-${input.localId}`).fetch(new URL(`api/${input.endpoint}`, input.url).href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: input.rpcId, method: input.endpoint, payload: { args: { request: input.request } } }) })
      return reply.json()
    }, { localId, url, endpoint, request, rpcId: randomUUID() })
    assert.equal(response.result.ok, true, response.result.error?.code)
    return response.result.value
  }
  const { sessionId: taskSession } = await rpc('session/create', { cwd: directory })
  await rpc('session/rename', { sessionId: taskSession, title: 'Notification fixture' })
  await rpc('session/selectModel', { sessionId: taskSession, provider: 'switcher-cc-fixture', model: 'fixture-model' })
  await command({ type: 'select', id: remoteId })
  await client.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await rpc('session/prompt', { sessionId: taskSession, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Reply briefly without tools.' }] })
  await expect.poll(async () => (await state()).notifications.items.some(item => item.sessionId === taskSession && item.kind === 'completed'), { timeout: 60000 }).toBe(true)
  failModel = true
  await rpc('session/prompt', { sessionId: taskSession, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Fixture failure turn.' }] })
  await expect.poll(async () => (await state()).notifications.items.some(item => item.sessionId === taskSession && item.kind === 'failed'), { timeout: 60000 }).toBe(true)
  failModel = false
  await command({ type: 'desktop.show' })
  await command({ type: 'select', id: localId })
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
  await writeFile(path.join(plugin, 'index.js'), `export const name = 'switcher-runtime-smoke';
export const inject = ['llm', 'credentials'];
export function apply(ctx) {
  ctx.effect(() => ctx.get('appReady').onReady(() => {
    void (async () => {
      const models = await ctx.llm.listModels('switcher-cc-fixture');
      const credential = await ctx.credentials.resolve('CC_SWITCH_FIXTURE_KEY');
      if (!models.some(model => model.id === 'fixture-model') || credential?.value !== 'fixture-only-not-a-real-key') throw new Error('fixture mismatch');
      console.log('SWITCHER_CC_CONFIG_READY');
    })().catch(() => console.error('SWITCHER_CC_CONFIG_FAILED'));
  }));
  console.log('SWITCHER_SMOKE_PLUGIN_READY');
}\n`)
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: switcher-runtime-smoke\n      name: switcher-runtime-smoke-plugin\n')
  const { installation, dataDirectory } = (await state()).local
  const env = { ...process.env, DSH_HOME: dataDirectory }
  const oldPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = [path.dirname(installation.nodePath), path.dirname(installation.pnpmPath), oldPath].join(path.delimiter)
  delete env.NODE_OPTIONS
  const execute = promisify(execFile)
  const credentialsBefore = YAML.parse(await readFile(path.join(dataDirectory, '.credentials.yaml'), 'utf8'))
  await execute(installation.nodePath, [installation.cliPath, 'plugin', '--profile', 'web', 'add', plugin], { env, cwd: dataDirectory, timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  await command({ type: 'local.start' })
  local = await waitForOperation(120000)
  assert.equal(local.process, 'running', local.error ?? '')
  assert.ok(local.logs.some(line => line.includes('SWITCHER_SMOKE_PLUGIN_READY')))
  await expect.poll(async () => (await state()).local.logs.some(line => line.includes('SWITCHER_CC_CONFIG_READY')), { timeout: 20000 }).toBe(true)
  assert.equal(local.logs.some(line => line.includes('fixture-only-not-a-real-key')), false)
  const credentialsAfter = YAML.parse(await readFile(path.join(dataDirectory, '.credentials.yaml'), 'utf8'))
  assert.deepEqual(credentialsAfter.records, credentialsBefore.records)
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
  assert.equal(await realpath(local.installation.cliPath), await realpath(selected))

  // Exercise the real legacy-to-web migration, including dependency restore and official CLI validation.
  await command({ type: 'local.stop' })
  await waitForOperation(15000)
  const legacyHome = path.join(directory, 'local-dsh')
  await cp(officialHome, legacyHome, { recursive: true, filter: source => path.basename(source) !== 'node_modules' })
  await rename(path.join(legacyHome, 'profiles/web'), path.join(legacyHome, 'profiles/switcher'))
  await rm(officialHome, { recursive: true })
  await execute(installation.nodePath, [installation.cliPath, 'plugin', '--profile', 'switcher', 'install', '--no-frozen-lockfile'], { env: { ...env, DSH_HOME: legacyHome }, cwd: legacyHome, timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  await command({ type: 'local.configure-home', selection: { mode: 'legacy' } })
  local = await waitForOperation(120000)
  assert.equal(local.process, 'running', local.error ?? '')
  assert.equal(local.home.profile, 'switcher')
  await command({ type: 'local.migrate-home' })
  local = await waitForOperation(240000)
  assert.equal(local.process, 'running', local.error ?? '')
  assert.equal(local.home.profile, 'web')
  assert.equal(await realpath(local.dataDirectory), await realpath(officialHome))
  assert.ok(local.home.backupDirectory)
  assert.equal(await readFile(path.join(legacyHome, 'profiles/switcher/cordis.patch.yml'), 'utf8'), await readFile(path.join(officialHome, 'profiles/web/cordis.patch.yml'), 'utf8'))
  assert.equal(await readFile(path.join(local.home.backupDirectory, '.credentials.yaml'), 'utf8'), await readFile(path.join(legacyHome, '.credentials.yaml'), 'utf8'))
  await expect.poll(async () => (await state()).local.logs.filter(line => line.includes('SWITCHER_CC_CONFIG_READY')).length, { timeout: 20000 }).toBeGreaterThanOrEqual(3)
  const stoppedUrl = (await state()).servers.find(item => item.id === localId).url
  const closed = client.waitForEvent('close')
  await command({ type: 'desktop.quit' }).catch(error => { assert.match(error.message, /Target page, context or browser has been closed/) })
  await closed
  client = undefined
  await assert.rejects(fetch(stoppedUrl, { signal: AbortSignal.timeout(3000) }))

  await launch()
  local = await waitForOperation(120000)
  await expect.poll(async () => (await state()).local.process, { timeout: 120000 }).toBe('running')
  assert.equal((await state()).local.installation.version, version)
  assert.ok((await state()).notifications.items.some(item => item.sessionId === taskSession && item.kind === 'completed'))
  console.log('PASS: cold Node/DSH installation, CC Switch configuration, real success/failure task notifications after page destruction and window close, persistent notification history, background install, plugins, data migration, update preservation, existing CLI and quit/restart')
} catch (error) {
  if (page && !page.isClosed()) {
    const current = await state().catch(() => null)
    if (current) await writeFile('test-results/local-runtime-state.json', JSON.stringify(current.local, null, 2))
  }
  throw error
} finally {
  await client?.close()
  modelServer.closeAllConnections()
  await new Promise(resolve => modelServer.close(resolve))
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
