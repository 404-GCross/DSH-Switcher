import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const artifactDir = path.resolve('test-results')
await mkdir(artifactDir, { recursive: true })
const directory = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-desktop-'))
const servers = []
const bindHost = process.env.SWITCHER_TEST_HOST ?? '127.0.0.1'
let client

async function host(name, { rejectCookie = false } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    response.setHeader('cache-control', 'no-store')
    if (url.searchParams.get('token') === name) {
      response.writeHead(303, { 'set-cookie': `owner=${name}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`, location: './' })
      response.end()
      return
    }
    if (rejectCookie || request.headers.cookie !== `owner=${name}`) {
      response.writeHead(401, { 'content-type': 'text/html' })
      response.end('<h1>Authentication required</h1>')
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#fafbfc"><h1>${name} native server page</h1><p>This page refuses iframe embedding.</p><input id="draft" aria-label="Native draft" placeholder="Persistent draft"><input id="file" type="file"><div id="plugin">Native plugin content</div></body></html>`)
  })
  server.listen(0, bindHost)
  await once(server, 'listening')
  servers.push(server)
  return `http://${bindHost}:${server.address().port}/`
}

async function launch() {
  const extra = []
  if (process.env.SWITCHER_TEST_HEADLESS === '1') extra.push('--ozone-platform=headless', '--disable-gpu')
  if (process.env.SWITCHER_TEST_NO_SANDBOX === '1') extra.push('--no-sandbox')
  client = await electron.launch({
    executablePath: process.env.SWITCHER_TEST_EXECUTABLE,
    args: [...(process.env.SWITCHER_TEST_EXECUTABLE ? [] : [process.cwd()]), ...extra],
    env: { ...process.env, SWITCHER_USER_DATA: directory, SWITCHER_DEV_URL: '' },
    timeout: 30000,
  })
  if (process.env.SWITCHER_EXPECT_ARCH) assert.equal(await client.evaluate(() => process.arch), process.env.SWITCHER_EXPECT_ARCH)
  await expect.poll(() => client.windows().some(page => page.url().includes('/renderer/index.html') && !page.url().includes('surface=overlay')), { timeout: 15000 }).toBe(true)
  const page = client.windows().find(page => page.url().includes('/renderer/index.html') && !page.url().includes('surface=overlay'))
  await page.waitForFunction(() => !!window.desktop)
  return page
}

async function command(page, value) {
  const result = await page.evaluate(value => window.desktop.command(value), value)
  assert.equal(result.ok, true, result.ok ? undefined : result.error)
}
async function state(page) { return page.evaluate(() => window.desktop.state()) }
async function waitStatus(page, status) {
  await expect.poll(async () => {
    const value = await state(page)
    return value.servers.find(server => server.id === value.activeId)?.status
  }, { timeout: 20000 }).toBe(status)
}

try {
  const a = await host('alpha')
  const b = await host('beta')
  let page = await launch()
  await expect(page.getByRole('heading', { name: '你的 DSH，随处连接' })).toBeVisible()
  await command(page, { type: 'save', name: 'Alpha', url: `${a}?token=alpha` })
  await waitStatus(page, 'ready')
  const alphaId = (await state(page)).activeId

  const native = await client.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    return contents.executeJavaScript(`({text:document.body.textContent,bridge:typeof window.desktop,require:typeof require})`)
  }, a)
  assert.match(native.text, /Native plugin content/)
  assert.equal(native.bridge, 'undefined')
  assert.equal(native.require, 'undefined')

  await client.evaluate(async ({ webContents }, url) => {
    await webContents.getAllWebContents().find(item => item.getURL() === url).executeJavaScript('document.getElementById("draft").value = "retained draft"')
  }, a)

  await command(page, { type: 'save', name: 'Beta', url: b })
  await waitStatus(page, 'auth-required')
  const betaId = (await state(page)).activeId
  await page.getByRole('button', { name: '输入登录链接' }).click()
  const loginPage = client.windows().find(item => item.url().includes('surface=overlay'))
  await loginPage.getByLabel('DSH 启动链接').fill(`${b}?token=incorrect`)
  await loginPage.getByRole('button', { name: '登录并打开' }).click()
  await expect(loginPage.getByRole('alert')).toContainText('服务器拒绝了此 token（HTTP 401）')
  await loginPage.screenshot({ path: path.join(artifactDir, 'desktop-login-error.png'), omitBackground: true })
  assert.equal((await state(page)).servers.find(server => server.id === betaId).status, 'auth-required')
  await loginPage.getByLabel('DSH 启动链接').fill(`${b}?token=beta`)
  await loginPage.getByRole('button', { name: '登录并打开' }).click()
  await waitStatus(page, 'ready')
  const cookies = await client.evaluate(async ({ session }, ids) => Promise.all(ids.map(id => session.fromPartition(`persist:dsh-${id}`).cookies.get({ name: 'owner' }))), [alphaId, betaId])
  assert.deepEqual(cookies.map(items => items.map(item => item.value)), [['alpha'], ['beta']])

  await command(page, { type: 'select', id: alphaId })
  await waitStatus(page, 'ready')
  assert.equal(await client.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).executeJavaScript('document.getElementById("draft").value'), a), 'retained draft')

  await command(page, { type: 'overlay', overlay: { kind: 'instances' } })
  const overlayPage = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(overlayPage.getByRole('heading', { name: '服务器连接' })).toBeVisible()
  const views = await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({ url: view.webContents?.getURL(), bounds: view.getBounds() })))
  assert.equal(views.at(-1).url.includes('surface=overlay'), true)
  const remote = views.find(view => view.url === a)
  assert.equal(views.at(-1).bounds.height - remote.bounds.height, 44)
  const screenshot = await client.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(artifactDir, 'desktop-instance-menu.png'), Buffer.from(screenshot, 'base64'))
  await overlayPage.screenshot({ path: path.join(artifactDir, 'desktop-overlay.png'), omitBackground: true })
  await command(page, { type: 'default', id: betaId })
  const config = await readFile(path.join(directory, 'settings.json'), 'utf8')
  assert.equal(config.includes('token='), false)

  // A successful exchange alone must not report login success if the cookie is refused.
  const broken = await host('broken', { rejectCookie: true })
  const rejected = await page.evaluate(url => window.desktop.command({ type: 'save', name: 'Broken cookie', url }), `${broken}?token=broken`)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /Cookie 验证仍为 HTTP 401/)
  assert.equal((await state(page)).servers.length, 2)

  await client.close()
  client = undefined
  page = await launch()
  await waitStatus(page, 'ready')
  assert.equal((await state(page)).activeId, betaId)
  await command(page, { type: 'theme', theme: 'dark' })
  assert.equal((await state(page)).dark, true)
  await command(page, { type: 'remove', id: betaId })
  assert.equal((await state(page)).activeId, alphaId)
  assert.equal((await state(page)).servers.length, 1)

  console.log('PASS: native page, plugin content, isolated cookies, retained draft, native overlay, credential-free config, restart, theme, removal')
} finally {
  if (client) await client.close()
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  await rm(directory, { recursive: true, force: true })
}
