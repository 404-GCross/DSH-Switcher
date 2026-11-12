import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
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
    env: { ...process.env, DSH_HOME: path.join(directory, 'official-home'), SWITCHER_USER_DATA: directory, SWITCHER_DEV_URL: '' },
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
  await page.getByRole('button', { name: '使用本机 DSH' }).click()
  const localPanel = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(localPanel.getByRole('heading', { name: '本机 DSH' })).toBeVisible()
  await localPanel.getByLabel('DSH 安装版本').fill('invalid-version')
  await localPanel.getByRole('button', { name: '安装官方 DSH 并启动' }).click()
  await expect(localPanel.getByRole('alert')).toContainText('有效的官方 DSH 版本号')
  await localPanel.screenshot({ path: path.join(artifactDir, 'local-setup-light.png'), omitBackground: true })
  await command(page, { type: 'theme', theme: 'dark' })
  await expect(localPanel.locator('html')).toHaveAttribute('data-theme', 'dark')
  await localPanel.screenshot({ path: path.join(artifactDir, 'local-setup-dark.png'), omitBackground: true })
  await localPanel.getByRole('button', { name: '关闭本机管理' }).click()
  await command(page, { type: 'theme', theme: 'light' })
  await command(page, { type: 'save', name: 'Alpha', url: `${a}?token=alpha` })
  await waitStatus(page, 'ready')
  const alphaId = (await state(page)).activeId

  await page.getByRole('button', { name: '开发者工具', exact: true }).click()
  await expect.poll(async () => (await state(page)).desktop.devToolsOpen).toBe(true)
  await expect(page.getByRole('button', { name: '开发者工具', exact: true })).toHaveAttribute('aria-pressed', 'true')
  assert.equal(await client.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).isDevToolsOpened(), a), true)
  await command(page, { type: 'desktop.devtools', target: 'page' })
  await expect.poll(async () => (await state(page)).desktop.devToolsOpen).toBe(false)
  await client.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus(); window.webContents.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
  })
  await expect.poll(async () => (await state(page)).desktop.devToolsOpen).toBe(true)
  await command(page, { type: 'desktop.devtools', target: 'page' })
  await client.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus(); window.webContents.focus()
    const modifiers = process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift']
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers })
  })
  const palette = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(palette.getByRole('heading', { name: '快捷操作' })).toBeVisible()
  await palette.getByRole('combobox', { name: '快捷操作搜索' }).fill('更新')
  await palette.getByRole('combobox', { name: '快捷操作搜索' }).press('Enter')
  await expect(palette.getByRole('heading', { name: '客户端更新中心' })).toBeVisible()
  await palette.screenshot({ path: path.join(artifactDir, 'desktop-updates.png'), animations: 'disabled', omitBackground: true })
  await command(page, { type: 'action', id: 'notifications' })
  await expect(palette.getByRole('heading', { name: '任务通知中心' })).toBeVisible()
  await palette.screenshot({ path: path.join(artifactDir, 'desktop-notifications.png'), animations: 'disabled', omitBackground: true })
  await command(page, { type: 'overlay', overlay: null })

  const native = await client.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    return contents.executeJavaScript(`({text:document.body.textContent,bridge:typeof window.desktop,require:typeof require})`)
  }, a)
  assert.match(native.text, /Native plugin content/)
  assert.equal(native.bridge, 'undefined')
  assert.equal(native.require, 'undefined')

  const oldAlpha = await client.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    await contents.executeJavaScript('document.getElementById("draft").value = "unsaved draft"; window.onbeforeunload = () => false; undefined')
    return contents.id
  }, a)

  await command(page, { type: 'desktop.devtools', target: 'page' })
  await command(page, { type: 'save', name: 'Beta', url: b })
  await waitStatus(page, 'auth-required')
  assert.equal((await state(page)).desktop.devToolsOpen, false)
  assert.equal(await client.evaluate(({ webContents }, id) => !!webContents.fromId(id), oldAlpha), false)
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
  assert.equal(await client.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).executeJavaScript('document.getElementById("draft").value'), a), '')
  const currentAlpha = await client.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url).id, a)
  assert.notEqual(currentAlpha, oldAlpha)
  assert.equal(await client.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => /^http:/.test(item.getURL())).length), 1)

  await command(page, { type: 'overlay', overlay: { kind: 'instances' } })
  const overlayPage = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(overlayPage.getByRole('heading', { name: '服务器连接' })).toBeVisible()
  const views = await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({ url: view.webContents?.getURL(), bounds: view.getBounds() })))
  assert.equal(views.at(-1).url.includes('surface=overlay'), true)
  const remote = views.find(view => view.url === a)
  assert.equal(views.at(-1).bounds.height - remote.bounds.height, 44)
  const screenshot = await client.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
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

  await command(page, { type: 'overlay', overlay: { kind: 'settings' } })
  await expect(overlayPage.getByRole('heading', { name: '客户端设置' })).toBeVisible()
  await overlayPage.screenshot({ path: path.join(artifactDir, 'desktop-settings-light.png'), omitBackground: true })
  await command(page, { type: 'theme', theme: 'dark' })
  await overlayPage.screenshot({ path: path.join(artifactDir, 'desktop-settings-dark.png'), omitBackground: true, animations: 'disabled' })
  await command(page, { type: 'overlay', overlay: null })
  await command(page, { type: 'desktop.check-tray' })
  await command(page, { type: 'desktop.devtools', target: 'page' })
  const tray = (await state(page)).desktop.tray.status
  await client.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  // Xvfb/headless may have no window manager: minimize acknowledgement is not guaranteed there.
  assert.equal(await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  assert.equal(await client.evaluate(({ webContents }, id) => !!webContents.fromId(id), currentAlpha), true)
  if (tray === 'available') await expect.poll(() => client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
  else await expect.poll(async () => (await state(page)).notice).toMatch(/最小化/)
  assert.equal((await state(page)).desktop.devToolsOpen, false)
  await command(page, { type: 'desktop.show' })
  await expect.poll(() => client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)

  const closed = client.waitForEvent('close')
  await command(page, { type: 'desktop.quit' }).catch(error => { assert.match(error.message, /Target page, context or browser has been closed/) })
  await closed
  client = undefined
  page = await launch()
  await waitStatus(page, 'ready')
  assert.equal((await state(page)).activeId, betaId)
  await command(page, { type: 'theme', theme: 'dark' })
  assert.equal((await state(page)).dark, true)
  await command(page, { type: 'remove', id: betaId })
  assert.equal((await state(page)).activeId, alphaId)
  assert.equal((await state(page)).servers.length, 1)

  await client.close()
  client = undefined
  await mkdir(path.join(directory, 'local-dsh'))
  await writeFile(path.join(directory, 'local-dsh', 'legacy-session.json'), '{"preserved":true}')
  const legacy = { version: 2, servers: [], defaultId: '00000000-0000-4000-8000-000000000001', theme: 'light', local: { installation: null } }
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(legacy))
  page = await launch()
  const migrationPanel = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(migrationPanel.getByRole('heading', { name: '选择升级后的 DSH 数据环境' })).toBeVisible()
  assert.equal((await state(page)).local.process, 'stopped')
  await migrationPanel.screenshot({ path: path.join(artifactDir, 'desktop-migration-light.png'), omitBackground: true })
  await command(page, { type: 'theme', theme: 'dark' })
  await migrationPanel.screenshot({ path: path.join(artifactDir, 'desktop-migration-dark.png'), omitBackground: true, animations: 'disabled' })
  await migrationPanel.getByRole('button', { name: '使用官方目录', exact: true }).click()
  await expect.poll(async () => (await state(page)).local.home.migrationPending).toBe(false)
  assert.equal((await state(page)).local.home.profile, 'web')
  assert.equal(await readFile(path.join(directory, 'local-dsh', 'legacy-session.json'), 'utf8'), '{"preserved":true}')
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'settings.json.v2.bak'), 'utf8')), legacy)

  console.log('PASS: native page, isolated cookies, one live page, F12 and toolbar DevTools lifecycle, keyboard palette, update/notification panels, close/restore, explicit exit, restart, settings migration and removal')
} finally {
  if (client) await client.close()
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  await rm(directory, { recursive: true, force: true })
}
