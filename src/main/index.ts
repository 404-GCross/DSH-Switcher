import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, nativeTheme, dialog, Menu, clipboard, powerMonitor, Notification } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppState, Command, CommandResult, ConnectionStatus, Overlay, Server } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import type { LocalCommand } from '../shared/types'
import { SettingsStore, homeSelectionSchema, paletteShortcutSchema, updatePreferencesSchema, notificationPreferencesSchema } from './settings'
import { isWebUrl, isWithinServer, loginUrlFor, parseServerUrl } from './server-url'
import { authenticateSession } from './authenticate'
import { readAuthenticationHeaders } from './auth-transport'
import { LocalRuntimeManager } from './local-runtime/manager'
import { ViewManager } from './view-manager'
import { TrayController } from './tray-controller'
import { WindowLifecycle } from './window-lifecycle'
import { DevToolsController } from './devtools'
import { clientActions, matchesPaletteShortcut } from '../shared/actions'
import { ClientUpdater } from './client-updater'
import { NotificationCenter } from './notification-center'
import { RuntimeDownloads } from './local-runtime/download'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const FOOTER_HEIGHT = 44
const overlaySchema = z.union([
  z.object({ kind: z.enum(['instances', 'add', 'about', 'local', 'settings', 'palette', 'updates', 'notifications']) }).strict(),
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
  ...(['local.detect', 'local.cancel', 'local.start', 'local.stop', 'local.restart', 'local.check-update', 'local.open-data-directory', 'local.copy-data-directory', 'local.migrate-home', 'desktop.show', 'desktop.quit', 'desktop.check-tray'] as const).map(type => z.object({ type: z.literal(type) }).strict()),
  z.object({ type: z.literal('desktop.close-behavior'), value: z.enum(['tray', 'minimize', 'quit']) }).strict(),
  z.object({ type: z.literal('local.configure-home'), selection: homeSelectionSchema }).strict(),
  z.object({ type: z.literal('local.install'), version: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('local.use-existing'), cliPath: z.string().min(1).max(4096), nodePath: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal('desktop.devtools'), target: z.enum(['page', 'shell']) }).strict(),
  z.object({ type: z.literal('desktop.palette-shortcut'), value: paletteShortcutSchema }).strict(),
  z.object({ type: z.literal('action'), id: z.string().min(1).max(100) }).strict(),
  ...(['update.check', 'update.download', 'update.cancel', 'update.open', 'notifications.clear', 'notifications.retry'] as const).map(type => z.object({ type: z.literal(type) }).strict()),
  z.object({ type: z.literal('update.configure'), value: updatePreferencesSchema }).strict(),
  z.object({ type: z.literal('notifications.configure'), value: notificationPreferencesSchema }).strict(),
  z.object({ type: z.literal('notifications.read'), id: z.uuid().optional() }).strict(),
  ...(['notifications.open', 'notifications.copy-session'] as const).map(type => z.object({ type: z.literal(type), id: z.uuid() }).strict()),
])

class Switcher {
  private window: BrowserWindow
  private overlayView: WebContentsView
  private runtimes: ViewManager
  private configuredSessions = new Set<string>()
  private activeId: string | null = null
  private overlay: Overlay = null
  private notice: string | null = null
  private attached: WebContentsView | null = null
  private overlayAttached = false
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private local: LocalRuntimeManager
  private tray: TrayController
  private lifecycle: WindowLifecycle
  private devtools: DevToolsController
  private updater: ClientUpdater
  private notifications: NotificationCenter
  private nativeNotifications = new Set<Notification>()

  constructor(private store: SettingsStore, finishQuit: () => void) {
    nativeTheme.themeSource = store.snapshot.theme
    const preload = path.join(__dirname, 'preload.cjs')
    this.window = new BrowserWindow({
      width: 1240, height: 850, minWidth: 640, minHeight: 500,
      title: 'DSH Switcher', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f5f7fa',
      icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../build/dsh-windows.png'),
      autoHideMenuBar: true, show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.devtools = new DevToolsController(this.window, () => this.publish())
    this.runtimes = new ViewManager(view => {
      if (!view.webContents.isDestroyed()) view.webContents.closeDevTools()
      if (this.attached === view) { this.window.contentView.removeChildView(view); this.attached = null }
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
      stopped: () => { this.closeRuntime(LOCAL_SERVER_ID); this.syncNotifications() },
      ready: async (url, launchUrl, signal) => {
        const server = { id: LOCAL_SERVER_ID, name: '本机 DSH', url }
        const ses = this.configureSession(server)
        await authenticateSession(url, launchUrl, (request, options) => readAuthenticationHeaders(ses, request, options), signal)
        signal.throwIfAborted()
        if (this.closed || this.lifecycle.isQuitting) throw new Error('客户端已关闭')
        if (this.activeId === LOCAL_SERVER_ID) this.open(server)
        if (this.activeId === LOCAL_SERVER_ID && this.overlay?.kind === 'local') this.overlay = null
        this.syncNotifications(true)
        this.publish()
      },
    })
    this.updater = new ClientUpdater(store, app.getPath('userData'), app.getVersion(), {
      changed: () => this.publish(), resolveProxy: url => session.defaultSession.resolveProxy(url), open: file => shell.openPath(file), reveal: file => shell.showItemInFolder(file),
    })
    this.notifications = new NotificationCenter(store, app.getPath('userData'), Notification.isSupported(), {
      changed: () => this.publish(),
      transport: server => {
        const ses = this.configureSession(server)
        return {
          request: async (url, body, signal) => {
            const response = await ses.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal, redirect: 'error' })
            if (response.status !== 200) return { status: response.status, value: null }
            const reader = response.body?.getReader()
            if (!reader) throw new Error('Missing response')
            const chunks: Uint8Array[] = []; let size = 0
            try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 8 * 1024 * 1024) throw new Error('Response too large'); chunks.push(chunk.value) } }
            finally { await reader.cancel().catch(() => undefined) }
            return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          },
          socket: async url => {
            const cookie = (await ses.cookies.get({ url: server.url })).map(item => `${item.name}=${item.value}`).join('; ')
            const proxy = await new RuntimeDownloads(value => ses.resolveProxy(value)).proxyFor(server.url)
            const agent = proxy ? proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy) : undefined
            const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: new URL(server.url).origin }, agent, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024, followRedirects: false })
            socket.on('error', () => {}); socket.once('close', () => agent?.destroy())
            return socket
          },
        }
      },
      notify: (item, silent) => {
        const notification = new Notification({ title: `${item.serverName} · ${item.sessionTitle}`, body: item.text, silent })
        this.nativeNotifications.add(notification)
        if (this.nativeNotifications.size > 50) { const oldest = this.nativeNotifications.values().next().value!; this.nativeNotifications.delete(oldest); oldest.close() }
        notification.once('click', () => { this.show(); void this.dispatch({ type: 'notifications.open', id: item.id }) })
        notification.once('close', () => this.nativeNotifications.delete(notification))
        notification.once('failed', () => this.nativeNotifications.delete(notification))
        notification.show()
      },
    })
    this.tray = new TrayController(app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../build/dsh-windows.png'), {
      show: () => this.show(), quit: () => app.quit(), changed: () => this.publish(),
      lost: () => {
        if (!this.window.isVisible()) { this.show(); this.notice = '系统托盘服务已不可用，窗口已恢复'; this.publish() }
      },
      run: command => {
        this.show()
        void this.dispatch(command).then(result => { if (!result.ok) { this.notice = result.error; this.publish() } })
      },
    })
    this.lifecycle = new WindowLifecycle({
      behavior: () => this.store.snapshot.desktop.closeBehavior,
      tray: () => this.tray.check(),
      hide: () => { this.devtools.closeAll(); this.window.hide() },
      minimize: () => { this.devtools.closeAll(); this.window.show(); this.window.minimize() },
      show: () => { if (this.window.isMinimized()) this.window.restore(); this.window.show(); this.window.focus() },
      notice: message => { this.notice = message; this.publish() },
      cleanup: async () => { await Promise.all([this.local.dispose(), this.queue, this.updater.dispose(), this.notifications.dispose()]); this.dispose() },
      exit: finishQuit,
    })
    for (const contents of [this.window.webContents, this.overlayView.webContents]) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', event => event.preventDefault())
      contents.on('did-finish-load', () => this.publish())
      this.installShortcut(contents)
      this.devtools.register(contents)
    }
    this.window.on('resize', () => this.layout())
    this.window.on('close', event => {
      if (this.closed) return
      event.preventDefault()
      void this.lifecycle.closeWindow().catch(() => this.reportQuitFailure())
    })
    this.window.on('session-end', () => { this.requestQuit() })
    this.window.on('query-session-end', event => { event.preventDefault(); this.requestQuit() })
    this.window.on('closed', () => this.dispose())
    this.window.once('ready-to-show', () => { if (!this.lifecycle.isQuitting) this.window.show() })
    nativeTheme.on('updated', this.onTheme)

    ipcMain.handle('switcher:state', event => {
      this.authorize(event)
      return this.snapshot()
    })
    ipcMain.handle('switcher:command', (event, value: unknown): Promise<CommandResult> => {
      this.authorize(event)
      const parsed = commands.safeParse(value)
      if (!parsed.success) return Promise.resolve({ ok: false, error: '操作参数无效' })
      return this.dispatch(parsed.data as Command)
    })
  }

  private dispatch(command: Command): Promise<CommandResult> {
    if (this.lifecycle.isQuitting || this.closed) return Promise.resolve({ ok: false, error: '客户端正在退出' })
    if (command.type === 'desktop.quit') { setImmediate(() => app.quit()); return Promise.resolve({ ok: true }) }
    if (command.type === 'desktop.show') { this.show(); return Promise.resolve({ ok: true }) }
    if (command.type === 'action') {
      const action = clientActions(this.snapshot()).find(item => item.id === command.id)
      if (!action?.enabled) return Promise.resolve({ ok: false, error: '此操作当前不可用' })
      if (this.overlay?.kind === 'palette') this.overlay = null
      return this.dispatch(action.command)
    }
    if (command.type.startsWith('local.')) {
      return this.localCommand(command as LocalCommand).then(() => ({ ok: true }), error => ({ ok: false, error: error instanceof Error ? error.message : '本机操作失败' }))
    }
    const operation = this.queue.then(async (): Promise<CommandResult> => {
      try { await this.command(command); return { ok: true } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试' } }
    })
    this.queue = operation
    return operation
  }
  show(): void { this.lifecycle.show() }
  runAction(id: string): void { void this.dispatch({ type: 'action', id }).then(result => { if (!result.ok) { this.notice = result.error; this.publish() } }) }
  togglePalette(): void { this.overlay = this.overlay?.kind === 'palette' ? null : { kind: 'palette' }; this.publish() }
  private pageContents(): Electron.WebContents { return (this.activeId ? this.runtimes.get(this.activeId)?.view.webContents : undefined) ?? this.window.webContents }
  private syncNotifications(retry = false): void {
    const servers = [...this.store.snapshot.servers, ...(this.local.url ? [{ id: LOCAL_SERVER_ID, name: '本机 DSH', url: this.local.url }] : [])]
    this.notifications.sync(servers, retry)
  }
  requestQuit(): void { void this.lifecycle.requestQuit().catch(() => this.reportQuitFailure()) }
  private reportQuitFailure(): void { this.notice = '本机进程清理失败，请检查日志后重试退出'; this.publish() }

  async start(): Promise<void> {
    await Promise.all([this.loadShell(this.window.webContents), this.loadShell(this.overlayView.webContents, true)])
    await this.local.initialize()
    await this.notifications.initialize()
    if (this.lifecycle.isQuitting || this.closed) return
    const settings = this.store.snapshot
    this.setActive(settings.defaultId ?? settings.servers[0]?.id ?? null)
    if (this.activeId === LOCAL_SERVER_ID) this.selectLocal()
    else if (this.activeId) this.open(this.requireServer(this.activeId))
    this.publish()
    this.tray.start()
    this.syncNotifications()
    void this.updater.initialize(app.getPath('exe'))
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
      if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || this.lifecycle.isQuitting) return
      const devtools = input.key === 'F12' || input.key.toLowerCase() === 'i' && (process.platform === 'darwin' ? input.meta && input.alt && !input.control && !input.shift : input.control && input.shift && !input.meta && !input.alt)
      if (devtools) { event.preventDefault(); this.devtools.toggle(this.pageContents()); return }
      if (matchesPaletteShortcut(input, this.store.snapshot.desktop.paletteShortcut)) { event.preventDefault(); this.togglePalette(); return }
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
        status: (local.process === 'running' ? this.runtimes.get(LOCAL_SERVER_ID)?.status ?? 'idle' : local.process === 'starting' ? 'loading' : local.process === 'failed' ? 'offline' : 'idle') as ConnectionStatus,
        error: local.error ?? undefined,
      }] : [])],
      activeId: this.activeId, defaultId: settings.defaultId, theme: settings.theme,
      dark: nativeTheme.shouldUseDarkColors, overlay: this.overlay, notice: this.notice,
      preview: false, appVersion: app.getVersion(),
      local,
      desktop: { ...settings.desktop, tray: this.tray.snapshot, devToolsOpen: this.pageContents().isDevToolsOpened() },
      recentServerIds: settings.recentServerIds,
      updates: { ...settings.updates, ...this.updater.snapshot },
      notifications: { ...settings.notifications, ...this.notifications.snapshot },
    }
  }

  private publish(): void {
    if (this.closed) return
    this.layout()
    const state = this.snapshot()
    this.tray.update(state)
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
        if (command.id === LOCAL_SERVER_ID) { this.selectLocal(); await this.remember(command.id); break }
        const server = this.requireServer(command.id)
        this.setActive(server.id)
        this.overlay = null
        if (!this.runtimes.get(server.id)) this.open(server)
        await this.remember(server.id)
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
        this.setActive(id)
        this.overlay = null
        if (!runtime || parsed.launchUrl !== parsed.baseUrl || runtime.status !== 'ready') this.open(record)
        await this.remember(id)
        this.syncNotifications(true)
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
          return { ...settings, servers, defaultId: settings.defaultId === command.id ? servers[0]?.id ?? null : settings.defaultId, recentServerIds: settings.recentServerIds.filter(id => id !== command.id), notifications: { ...settings.notifications, serverIds: settings.notifications.serverIds.filter(id => id !== command.id) } }
        })
        this.closeRuntime(command.id)
        this.syncNotifications()
        this.overlay = null
        if (this.activeId === command.id) {
          this.setActive(next.defaultId ?? next.servers[0]?.id ?? null)
          if (this.activeId === LOCAL_SERVER_ID) this.selectLocal()
          else if (this.activeId && !this.runtimes.get(this.activeId)) this.open(this.requireServer(this.activeId))
        }
        break
      }
      case 'login': {
        const server = this.requireServer(command.id)
        const url = loginUrlFor(server.url, command.url)
        const ses = this.configureSession(server)
        await authenticateSession(server.url, url, (request, options) => readAuthenticationHeaders(ses, request, options))
        this.setActive(server.id)
        this.overlay = null
        this.open(server)
        this.syncNotifications(true)
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
      case 'desktop.close-behavior':
        await this.store.update(settings => ({ ...settings, desktop: { ...settings.desktop, closeBehavior: command.value } }))
        break
      case 'desktop.check-tray': await this.tray.check(); break
      case 'desktop.devtools': this.devtools.toggle(command.target === 'page' ? this.pageContents() : this.overlay ? this.overlayView.webContents : this.window.webContents); break
      case 'desktop.palette-shortcut': await this.store.update(settings => ({ ...settings, desktop: { ...settings.desktop, paletteShortcut: command.value } })); break
      case 'update.configure': await this.updater.configure(command.value); break
      case 'update.check': this.updater.check(); break
      case 'update.download': this.updater.download(); break
      case 'update.cancel': this.updater.cancel(); break
      case 'update.open': await this.updater.open(); break
      case 'notifications.configure':
        if (command.value.serverIds.some(id => id !== LOCAL_SERVER_ID && !this.store.snapshot.servers.some(server => server.id === id))) throw new Error('通知服务器连接不存在')
        await this.store.update(settings => ({ ...settings, notifications: { ...command.value, serverIds: [...new Set(command.value.serverIds)] } })); this.syncNotifications(); break
      case 'notifications.retry': this.syncNotifications(true); break
      case 'notifications.read': this.notifications.read(command.id); break
      case 'notifications.clear': this.notifications.clear(); break
      case 'notifications.copy-session': {
        const item = this.notifications.find(command.id)
        if (item) clipboard.writeText(item.sessionId)
        break
      }
      case 'notifications.open': {
        const item = this.notifications.find(command.id)
        if (!item) throw new Error('通知已被清除')
        this.show()
        await this.command({ type: 'select', id: item.serverId })
        this.notifications.read(item.id)
        this.notice = `已打开 ${item.serverName}，请在 DSH 侧栏选择「${item.sessionTitle}」`
        break
      }
    }
    this.publish()
  }

  private setActive(id: string | null): void {
    if (this.activeId !== id) this.devtools.closeAll()
    this.runtimes.select(id)
    this.activeId = id
  }
  private remember(id: string): Promise<unknown> { return this.store.update(settings => ({ ...settings, recentServerIds: [id, ...settings.recentServerIds.filter(item => item !== id)].slice(0, 20) })) }

  private selectLocal(): void {
    this.setActive(LOCAL_SERVER_ID)
    if (!this.local.snapshot.installation || this.local.snapshot.home.migrationPending) this.overlay = { kind: 'local' }
    else {
      this.overlay = null
      if (this.local.snapshot.process === 'running') {
        if (!this.runtimes.get(LOCAL_SERVER_ID)) this.open(this.requireServer(LOCAL_SERVER_ID))
      } else this.local.command({ type: 'local.start' })
    }
    this.publish()
  }

  private async localCommand(command: LocalCommand): Promise<void> {
    if (command.type === 'local.open-data-directory') {
      await mkdir(this.local.home.directory, { recursive: true })
      if (await shell.openPath(this.local.home.directory)) throw new Error('无法打开本机 DSH 数据目录')
      return
    }
    if (command.type === 'local.copy-data-directory') { clipboard.writeText(this.local.home.directory); return }
    this.local.command(command)
    if (['local.install', 'local.use-existing', 'local.start', 'local.restart'].includes(command.type)) {
      this.setActive(LOCAL_SERVER_ID)
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
    if (this.activeId !== server.id || this.lifecycle.isQuitting || this.closed) return
    let runtime = this.runtimes.get(server.id)
    if (!runtime) {
      const view = new WebContentsView({ webPreferences: {
        session: this.configureSession(server), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true,
      } })
      runtime = { view, server, status: 'idle', responseCode: 0 }
      this.runtimes.set(runtime)
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
        if (!this.runtimes.owns(owned) || this.closed) return
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
      this.devtools.register(view.webContents)
    }
    runtime.status = 'loading'
    runtime.error = undefined
    runtime.responseCode = 0
    // Login is completed in this view's session before navigating to a credential-free URL.
    void runtime.view.webContents.loadURL(server.url).catch(() => undefined)
    this.publish()
  }

  private closeRuntime(id: string): void {
    this.runtimes.close(id)
  }

  private onTheme = (): void => { this.publish() }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    this.devtools.closeAll()
    for (const notification of this.nativeNotifications) notification.close()
    this.nativeNotifications.clear()
    this.tray.dispose()
    nativeTheme.off('updated', this.onTheme)
    ipcMain.removeHandler('switcher:state')
    ipcMain.removeHandler('switcher:command')
    this.runtimes.close()
    this.overlayView.webContents.close()
  }
}

if (process.env.SWITCHER_USER_DATA) app.setPath('userData', path.resolve(process.env.SWITCHER_USER_DATA))
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let controller: Switcher | undefined
  let allowQuit = false
  app.on('before-quit', event => {
    if (allowQuit || !controller) return
    event.preventDefault()
    controller.requestQuit()
  })
  app.on('second-instance', () => {
    controller?.show()
  })
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('io.gcross.dsh-switcher')
    const store = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
    await store.load()
    controller = new Switcher(store, () => { allowQuit = true; app.quit() })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      ...(process.platform !== 'darwin' ? [{ label: '应用', submenu: [{ label: '显示窗口', click: () => controller?.show() }, { type: 'separator' as const }, { label: '退出', role: 'quit' as const }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ label: '快捷操作', click: () => controller?.togglePalette() }, { type: 'separator' }, { label: '网页开发者工具（F12）', click: () => controller?.runAction('devtools') }, { label: '客户端界面开发者工具', click: () => controller?.runAction('shell-devtools') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '工具', submenu: [{ label: '客户端更新中心', click: () => controller?.runAction('updates') }, { label: '任务通知中心', click: () => controller?.runAction('notifications') }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]))
    await controller.start()
    app.on('activate', () => controller?.show())
    // Electron's shutdown typings omit the documented event argument.
    powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => { event?.preventDefault(); app.quit() })
  }).catch(error => {
    dialog.showErrorBox('DSH Switcher 启动失败', error instanceof Error ? error.message : '无法加载客户端配置')
    app.quit()
  })
  app.on('window-all-closed', () => { app.quit() })
}
