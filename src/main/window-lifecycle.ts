import type { CloseBehavior, TrayState } from '../shared/types'

export class WindowLifecycle {
  private closing: Promise<void> | null = null
  private quitting: Promise<void> | null = null
  private quitRequested = false
  private visibilityRevision = 0
  constructor(private operations: {
    behavior: () => CloseBehavior
    tray: () => Promise<TrayState>
    hide: () => void
    minimize: () => void
    show: () => void
    notice: (message: string) => void
    cleanup: () => Promise<void>
    exit: () => void
  }) {}
  get isQuitting(): boolean { return this.quitRequested }
  closeWindow(): Promise<void> {
    if (this.quitRequested) return this.quitting ?? Promise.resolve()
    if (this.closing) return this.closing
    const revision = this.visibilityRevision
    this.closing = (async () => {
      const behavior = this.operations.behavior()
      if (behavior === 'quit') { await this.requestQuit(); return }
      if (behavior === 'tray') {
        const tray = await this.operations.tray()
        if (this.quitRequested || revision !== this.visibilityRevision) return
        if (tray.status === 'available') { this.operations.hide(); return }
        this.operations.notice(tray.detail)
      }
      if (!this.quitRequested) this.operations.minimize()
    })().finally(() => { this.closing = null })
    return this.closing
  }
  show(): void { this.visibilityRevision++; if (!this.quitRequested) this.operations.show() }
  requestQuit(): Promise<void> {
    if (this.quitting) return this.quitting
    this.quitRequested = true
    this.quitting = Promise.resolve().then(() => this.operations.cleanup()).then(() => this.operations.exit()).catch(error => {
      this.quitting = null
      this.quitRequested = false
      this.operations.show()
      throw error
    })
    return this.quitting
  }
}
