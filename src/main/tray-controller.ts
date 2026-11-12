import { Menu, Tray, nativeImage } from 'electron'
import type { AppState, Command, TrayState } from '../shared/types'
import { probeTraySupport } from './tray-availability'
import { trayMenuTemplate } from './tray-menu'

export class TrayController {
  private tray: Tray | null = null
  private disposed = false
  private checking: Promise<TrayState> | null = null
  private timer?: ReturnType<typeof setInterval>
  private menuKey = ''
  private latest: AppState | null = null
  private state: TrayState = { status: 'checking', detail: '正在检测系统托盘' }
  constructor(private icon: string, private actions: {
    show: () => void; run: (command: Command) => void; quit: () => void
    changed: () => void; lost: () => void
  }) {}
  get snapshot(): TrayState { return { ...this.state } }
  start(): void {
    void this.check()
    this.timer = setInterval(() => { void this.check() }, 15_000)
    this.timer.unref()
  }
  check(): Promise<TrayState> {
    if (this.checking) return this.checking
    if (this.disposed) return Promise.resolve({ status: 'unavailable', detail: '托盘已关闭' })
    this.checking = (async () => {
      let next = await probeTraySupport()
      if (this.disposed) return this.snapshot
      if (next.status === 'available' && !this.tray) {
        try {
          const image = nativeImage.createFromPath(this.icon).resize({ width: process.platform === 'darwin' ? 18 : 24, height: process.platform === 'darwin' ? 18 : 24 })
          if (image.isEmpty()) throw new Error('Missing tray image')
          this.tray = new Tray(image)
          this.tray.setToolTip('DSH Switcher')
          this.tray.on('click', this.actions.show)
          this.tray.on('double-click', this.actions.show)
          this.menuKey = ''
          if (this.latest) this.update(this.latest)
        } catch { next = { status: 'unavailable', detail: '无法创建系统托盘；关闭窗口将最小化' } }
      }
      const lost = this.state.status === 'available' && next.status !== 'available'
      if (next.status !== 'available' && this.tray) { this.tray.destroy(); this.tray = null; this.menuKey = '' }
      const changed = next.status !== this.state.status || next.detail !== this.state.detail
      this.state = next
      if (lost) this.actions.lost()
      if (changed) this.actions.changed()
      return this.snapshot
    })().finally(() => { this.checking = null })
    return this.checking
  }
  update(state: AppState): void {
    this.latest = state
    const key = JSON.stringify([state.activeId, state.servers.map(server => [server.id, server.name]), !!state.local.installation, state.local.process, !!state.local.operation, state.local.home.migrationPending])
    if (!this.tray || key === this.menuKey) return
    this.menuKey = key
    this.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, this.actions)))
  }
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.tray?.destroy()
    this.tray = null
    this.latest = null
  }
}
