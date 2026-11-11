import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, nativeTheme, dialog, Menu } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppState, Command, CommandResult, ConnectionStatus, Overlay, Server } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import type { LocalCommand } from '../shared/types'
import { SettingsStore } from './settings'
import { isWebUrl, isWithinServer, loginUrlFor, parseServerUrl } from './server-url'
import { authenticateSession } from './authenticate'
import { readAuthenticationHeaders } from './auth-transport'
import { LocalRuntimeManager } from './local-runtime/manager'

const FOOTER_HEIGHT = 44
const overlaySchema = z.union([
  z.object({ kind: z.enum(['instances', 'add', 'about', 'local']) }).strict(),
  z.object({ kind: z.enum(['edit', 'login', 'remove']), id: z.uuid() }).strict(),
  z.null(),
])
const commands = z.discriminatedUnion('type', [
  z.object({ type: z.literal('overlay'), overlay: overlaySchema }).strict(),
  ...(['select', 'default', 'remove', 'reload', 'external'] as const).map(type =>
    z.object({ type: z.literal(type), id: z.uuid() }).strict()),
  z.object({ type: z.literal('save'), id: z.uuid().optional(), name: z.string().trim().min(1).max(80), url: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('login'), id: z.uuid(), url: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('theme'), theme: z.enum(['system', 'light', 'dark']) }).strict(),
  z.object({ type: z.literal('dismiss-notice') }).strict(),
  ...(['local.detect', 'local.cancel', 'local.start', 'local.stop', 'local.restart', 'local.check-update', 'local.open-data-directory'] as const).map(type => z.object({ type: z.literal(type) }).strict()),
  z.object({ type: z.literal('local.install'), version: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('local.use-existing'), cliPath: z.string().min(1).max(4096), nodePath: z.string().min(1).max(4096) }).strict(),
])

interface Runtime {
  server: Server
  view: WebContentsView
  status: ConnectionStatus
  error?: string
  responseCode: number
}

class Switcher {
  private window: BrowserWindow
  private overlayView: WebContentsView
  private runtimes = new Map<string, Runtime>()
  private configuredSessions = new Set<string>()
  private activeId: string | null = null
  private overlay: Overlay = null
  private notice: string | null = null
  private attached: WebContentsView | null = null
  private overlayAttached = false
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private local: LocalRuntimeManager
  private closing = false

  constructor(private store: SettingsStore) {
    nativeTheme.themeSource = store.snapshot.theme
    const preload = path.join(__dirname, 'preload.cjs')
    this.window = new BrowserWindow({
      width: 1240, height: 850, minWidth: 640, minHeight: 500,
      title: 'DSH Switcher', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f5f7fa',
      icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../build/dsh-official.png'),
      autoHideMenuBar: true, show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.overlayView = new WebContentsView({
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.overlayView.setBackgroundColor('#00000000')
    const supervisor = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist/main/supervisor.cjs')
      : path.join(__dirname, 'supervisor.cjs')
    this.local = new LocalRuntimeManager(store, app.getPath('userData'), supervisor, {
      changed: () => this.publish(),
      resolveProxy: url => session.defaultSession.resolveProxy(url),
      stopped: () => this.closeRuntime(LOCAL_SERVER_ID),
      ready: async (url, launchUrl, signal) => {
        const server = { id: LOCAL_SERVER_ID, name: '本机 DSH', url }
        const ses = this.configureSession(server)
        await authenticateSession(url, launchUrl, (request, options) => readAuthenticationHeaders(ses, request, options), signal)
        signal.throwIfAborted()
        if (this.closed) throw new Error('客户端已关闭')
        this.open(server)
        if (this.activeId === LOCAL_SERVER_ID && this.overlay?.kind === 'local') this.overlay = null
        this.publish()
      },
    })
    for (const contents of [this.window.webContents, this.overlayView.webContents]) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', event => event.preventDefault())
      contents.on('did-finish-load', () => this.publish())
      this.installShortcut(contents)
    }
    this.window.on('resize', () => this.layout())
    this.window.on('close', event => {
      if (this.closed) return
      event.preventDefault()
      if (this.closing) return
      this.closing = true
      void this.local.dispose().then(() => {
        this.window.destroy()
      }).catch(() => {
        this.closing = false
        this.notice = '本机进程清理失败，请检查日志后重试退出'
        this.publish()
      })
    })
    this.window.on('closed', () => this.dispose())
    this.window.once('ready-to-show', () => this.window.show())
    nativeTheme.on('updated', this.onTheme)

    ipcMain.handle('switcher:state', event => {
      this.authorize(event)
      return this.snapshot()
    })
    ipcMain.handle('switcher:command', (event, value: unknown): Promise<CommandResult> => {
      this.authorize(event)
      const parsed = commands.safeParse(value)
      if (!parsed.success) return Promise.resolve({ ok: false, error: '操作参数无效' })
      const command = parsed.data as Command
      if (command.type.startsWith('local.')) {
        return this.localCommand(command as LocalCommand).then(() => ({ ok: true }), error => ({ ok: false, error: error instanceof Error ? error.message : '本机操作失败' }))
      }
      const operation = this.queue.then(async (): Promise<CommandResult> => {
        try { await this.command(command); return { ok: true } }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试' } }
      })
      this.queue = operation
      return operation
    })
  }

  async start(): Promise<void> {
    await Promise.all([this.loadShell(this.window.webContents), this.loadShell(this.overlayView.webContents, true)])
    await this.local.initialize()
    const settings = this.store.snapshot
    this.activeId = settings.defaultId ?? settings.servers[0]?.id ?? null
    if (this.activeId === LOCAL_SERVER_ID) this.selectLocal()
    else if (this.activeId) this.open(this.requireServer(this.activeId))
    this.publish()
  }

  private loadShell(contents: Electron.WebContents, overlay = false): Promise<void> {
    if (!app.isPackaged && process.env.SWITCHER_DEV_URL) {
      const url = new URL(process.env.SWITCHER_DEV_URL)
      if (overlay) url.searchParams.set('surface', 'overlay')
      return contents.loadURL(url.href)
    }
    return contents.loadFile(path.join(__dirname, '../renderer/index.html'), { query: overlay ? { surface: 'overlay' } : {} })
  }

  private authorize(event: IpcMainInvokeEvent): void {
    const allowed = [this.window.webContents.id, this.overlayView.webContents.id]
    if (!allowed.includes(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unavailable IPC caller')
    }
  }

  private installShortcut(contents: Electron.WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 's') {
        event.preventDefault()
        this.overlay = this.overlay ? null : { kind: 'instances' }
        this.publish()
      }
    })
  }

  private snapshot(): AppState {
    const settings = this.store.snapshot
    const local = this.local.snapshot
    return {
      servers: [...settings.servers.map(server => {
        const runtime = this.runtimes.get(server.id)
        return { ...server, status: runtime?.status ?? 'idle', error: runtime?.error }
      }), ...(local.installation || this.activeId === LOCAL_SERVER_ID ? [{
        id: LOCAL_SERVER_ID, name: '本机 DSH', url: this.local.url ?? '', local: true,
        status: (local.process === 'running' ? this.runtimes.get(LOCAL_SERVER_ID)?.status ?? 'loading' : local.process === 'starting' ? 'loading' : local.process === 'failed' ? 'offline' : 'idle') as ConnectionStatus,
        error: local.error ?? undefined,
      }] : [])],
      activeId: this.activeId, defaultId: settings.defaultId, theme: settings.theme,
      dark: nativeTheme.shouldUseDarkColors, overlay: this.overlay, notice: this.notice,
      preview: false, appVersion: app.getVersion(),
      local,
    }
  }

  private publish(): void {
    if (this.closed) return
    this.layout()
    const state = this.snapshot()
    for (const contents of [this.window.webContents, this.overlayView.webContents]) {
      if (!contents.isDestroyed()) contents.send('switcher:state-changed', state)
    }
    const name = state.servers.find(server => server.id === this.activeId)?.name
    this.window.setTitle(name ? `${name} — DSH Switcher` : 'DSH Switcher')
  }

  /** Native overlays are above the remote WebContentsView, not behind it in the shell DOM. */
  private layout(): void {
    if (this.closed) return
    const [width, height] = this.window.getContentSize()
    const active = this.activeId ? this.runtimes.get(this.activeId) : undefined
    const desired = active?.status === 'ready' ? active.view : null
    if (this.attached !== desired) {
      if (this.attached) this.window.contentView.removeChildView(this.attached)
      this.attached = desired
      if (desired) {
        this.window.contentView.addChildView(desired)
        if (this.overlayAttached) {
          this.window.contentView.removeChildView(this.overlayView)
          this.window.contentView.addChildView(this.overlayView)
        }
      }
    }
    desired?.setBounds({ x: 0, y: 0, width, height: Math.max(1, height - FOOTER_HEIGHT) })
    if (!!this.overlay !== this.overlayAttached) {
      this.overlayAttached = !!this.overlay
      if (this.overlayAttached) {
        this.window.contentView.addChildView(this.overlayView)
        this.overlayView.webContents.focus()
      } else {
        this.window.contentView.removeChildView(this.overlayView)
        ;(desired?.webContents ?? this.window.webContents).focus()
      }
    }
    this.overlayView.setBounds({ x: 0, y: 0, width, height })
  }

  private requireServer(id: string): Server {
    if (id === LOCAL_SERVER_ID) {
      const url = this.local.url
      if (!url) throw new Error('本机 DSH 尚未启动')
      return { id, name: '本机 DSH', url }
    }
    const server = this.store.snapshot.servers.find(item => item.id === id)
    if (!server) throw new Error('这个服务器连接已被移除')
    return server
  }

  private async command(command: Command): Promise<void> {
    switch (command.type) {
      case 'overlay':
        if (command.overlay && 'id' in command.overlay) this.requireServer(command.overlay.id)
        this.overlay = command.overlay
        break
      case 'select': {
        if (command.id === LOCAL_SERVER_ID) { this.selectLocal(); break }
        const server = this.requireServer(command.id)
        this.activeId = server.id
        this.overlay = null
        if (!this.runtimes.has(server.id)) this.open(server)
        break
      }
      case 'save': {
        if (command.id === LOCAL_SERVER_ID) throw new Error('请通过本机运行环境管理 DSH')
        const parsed = parseServerUrl(command.url)
        const old = command.id ? this.requireServer(command.id) : undefined
        // A changed endpoint gets a fresh persistent cookie partition.
        const id = old && old.url === parsed.baseUrl ? old.id : randomUUID()
        const record: Server = { id, name: command.name.trim(), url: parsed.baseUrl }
        if (parsed.launchUrl !== parsed.baseUrl) {
          const ses = this.configureSession(record)
          await authenticateSession(record.url, parsed.launchUrl, (url, options) => readAuthenticationHeaders(ses, url, options))
        }
        await this.store.update(settings => {
          if (!old && settings.servers.length >= 100) throw new Error('最多保存 100 个服务器连接')
          return {
            ...settings,
            servers: old ? settings.servers.map(item => item.id === old.id ? record : item) : [...settings.servers, record],
            defaultId: !settings.defaultId || settings.defaultId === old?.id ? id : settings.defaultId,
          }
        })
        if (old && old.id !== id) this.closeRuntime(old.id)
        const runtime = this.runtimes.get(id)
        if (runtime) runtime.server = record
        this.activeId = id
        this.overlay = null
        if (!runtime || parsed.launchUrl !== parsed.baseUrl || runtime.status !== 'ready') this.open(record)
        break
      }
      case 'default':
        if (command.id !== LOCAL_SERVER_ID) this.requireServer(command.id)
        await this.store.update(settings => ({ ...settings, defaultId: command.id }))
        break
      case 'remove': {
        if (command.id === LOCAL_SERVER_ID) throw new Error('请通过本机运行环境停止 DSH')
        this.requireServer(command.id)
        const next = await this.store.update(settings => {
          const servers = settings.servers.filter(server => server.id !== command.id)
          return { ...settings, servers, defaultId: settings.defaultId === command.id ? servers[0]?.id ?? null : settings.defaultId }
        })
        this.closeRuntime(command.id)
        this.overlay = null
        if (this.activeId === command.id) {
          this.activeId = next.defaultId ?? next.servers[0]?.id ?? null
          if (this.activeId === LOCAL_SERVER_ID) this.selectLocal()
          else if (this.activeId && !this.runtimes.has(this.activeId)) this.open(this.requireServer(this.activeId))
        }
        break
      }
      case 'login': {
        const server = this.requireServer(command.id)
        const url = loginUrlFor(server.url, command.url)
        const ses = this.configureSession(server)
        await authenticateSession(server.url, url, (request, options) => readAuthenticationHeaders(ses, request, options))
        this.activeId = server.id
        this.overlay = null
        this.open(server)
        break
      }
      case 'reload':
        if (command.id === LOCAL_SERVER_ID && this.local.snapshot.process !== 'running') this.selectLocal()
        else this.open(this.requireServer(command.id))
        break
      case 'external':
        await shell.openExternal(this.requireServer(command.id).url)
        break
      case 'theme':
        await this.store.update(settings => ({ ...settings, theme: command.theme }))
        nativeTheme.themeSource = command.theme
        break
      case 'dismiss-notice': this.notice = null; break
    }
    this.publish()
  }

  private selectLocal(): void {
    this.activeId = LOCAL_SERVER_ID
    if (!this.local.snapshot.installation) this.overlay = { kind: 'local' }
    else {
      this.overlay = null
      this.local.command({ type: 'local.start' })
    }
    this.publish()
  }

  private async localCommand(command: LocalCommand): Promise<void> {
    if (command.type === 'local.open-data-directory') {
      await mkdir(this.local.paths.home, { recursive: true })
      if (await shell.openPath(this.local.paths.home)) throw new Error('无法打开本机 DSH 数据目录')
      return
    }
    this.local.command(command)
    if (['local.install', 'local.use-existing', 'local.start', 'local.restart'].includes(command.type)) {
      this.activeId = LOCAL_SERVER_ID
      if (!this.store.snapshot.defaultId) await this.store.update(settings => ({ ...settings, defaultId: LOCAL_SERVER_ID }))
    }
    this.publish()
  }

  private configureSession(server: Server): Electron.Session {
    const partition = `persist:dsh-${server.id}`
    const ses = session.fromPartition(partition)
    if (this.configuredSessions.has(partition)) return ses
    this.configuredSessions.add(partition)
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      const active = this.activeId ? this.runtimes.get(this.activeId) : undefined
      if (this.closed || active?.view.webContents !== contents || !isWithinServer(active.server.url, contents.getURL())) {
        callback(false)
        return
      }
      const labels: Record<string, string> = {
        media: '麦克风或摄像头', notifications: '桌面通知', 'clipboard-read': '读取剪贴板',
        'clipboard-sanitized-write': '写入剪贴板', fullscreen: '全屏显示',
      }
      if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') { callback(true); return }
      const label = labels[permission]
      if (!label) { callback(false); return }
      void dialog.showMessageBox(this.window, {
        type: 'question', title: '网站权限', message: `${active.server.name} 请求使用${label}`,
        detail: new URL(active.server.url).origin, buttons: ['拒绝', '允许一次'], defaultId: 0, cancelId: 0,
      }).then(result => callback(!contents.isDestroyed() && result.response === 1), () => callback(false))
    })
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存下载文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) })
      item.once('done', (_event, state) => {
        this.notice = state === 'completed' ? '文件已下载' : state === 'cancelled' ? null : '下载中断，请重试'
        this.publish()
      })
    })
    return ses
  }

  private open(server: Server): void {
    let runtime = this.runtimes.get(server.id)
    if (!runtime) {
      const view = new WebContentsView({ webPreferences: {
        session: this.configureSession(server), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true,
      } })
      runtime = { view, server, status: 'idle', responseCode: 0 }
      this.runtimes.set(server.id, runtime)
      const owned = runtime
      const update = (status: ConnectionStatus, error?: string): void => {
        if (this.closed || this.runtimes.get(server.id) !== owned) return
        owned.status = status
        owned.error = error
        this.publish()
      }
      view.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) { owned.responseCode = 0; update('loading') }
      })
      view.webContents.on('did-navigate', (_event, _url, code) => { owned.responseCode = code })
      view.webContents.on('did-finish-load', () => {
        const code = owned.responseCode
        if (code === 401) update('auth-required')
        else if (code === 403) update('forbidden', '服务器拒绝了访问，请检查 DSH 的 trusted-host 配置')
        else if (code >= 400) update('offline', `服务器返回 HTTP ${code}`)
        else if (isWithinServer(server.url, view.webContents.getURL())) update('ready')
      })
      view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) update('offline', `页面加载失败（${code}），请检查地址、网络及服务器状态`)
      })
      view.webContents.on('render-process-gone', () => update('offline', '网页进程已退出，请重新加载'))
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) void shell.openExternal(url).catch(() => { this.notice = '无法打开系统浏览器'; this.publish() })
        return { action: 'deny' }
      })
      view.webContents.on('will-navigate', (event, url) => {
        if (!isWithinServer(server.url, url)) {
          event.preventDefault()
          if (isWebUrl(url)) void shell.openExternal(url).catch(() => { this.notice = '无法打开系统浏览器'; this.publish() })
        }
      })
      view.webContents.on('will-redirect', (event, url) => {
        if (!isWithinServer(server.url, url)) { event.preventDefault(); update('offline', '页面重定向到了其他地址，请检查服务器配置') }
      })
      this.installShortcut(view.webContents)
    }
    runtime.status = 'loading'
    runtime.error = undefined
    runtime.responseCode = 0
    // Login is completed in this view's session before navigating to a credential-free URL.
    void runtime.view.webContents.loadURL(server.url).catch(() => undefined)
    this.publish()
  }

  private closeRuntime(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    if (this.attached === runtime.view) {
      this.window.contentView.removeChildView(runtime.view)
      this.attached = null
    }
    this.runtimes.delete(id)
    runtime.view.webContents.close()
  }

  private onTheme = (): void => { this.publish() }

  private dispose(): void {
    this.closed = true
    nativeTheme.off('updated', this.onTheme)
    ipcMain.removeHandler('switcher:state')
    ipcMain.removeHandler('switcher:command')
    for (const runtime of this.runtimes.values()) runtime.view.webContents.close()
    this.runtimes.clear()
    this.overlayView.webContents.close()
  }
}

if (process.env.SWITCHER_USER_DATA) app.setPath('userData', path.resolve(process.env.SWITCHER_USER_DATA))
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let controller: Switcher | undefined
  let quitting = false
  app.on('before-quit', () => { quitting = true })
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.whenReady().then(async () => {
    const store = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
    await store.load()
    const create = async (): Promise<void> => { controller = new Switcher(store); await controller.start() }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]))
    await create()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void create() })
  }).catch(error => {
    dialog.showErrorBox('DSH Switcher 启动失败', error instanceof Error ? error.message : '无法加载客户端配置')
    app.quit()
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || quitting) app.quit() })
}
