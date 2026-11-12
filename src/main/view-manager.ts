import type { WebContentsView } from 'electron'
import type { ConnectionStatus, Server } from '../shared/types'

export interface RuntimeView {
  server: Server
  view: WebContentsView
  status: ConnectionStatus
  error?: string
  responseCode: number
}

/** Browser storage belongs to the session; only the selected page has a live document. */
export class ViewManager {
  private current: RuntimeView | null = null
  constructor(private detach: (view: WebContentsView) => void) {}
  get(id: string): RuntimeView | undefined { return this.current?.server.id === id ? this.current : undefined }
  owns(view: RuntimeView): boolean { return this.current === view }
  select(id: string | null): void { if (this.current && this.current.server.id !== id) this.close() }
  set(view: RuntimeView): void {
    this.close()
    this.current = view
  }
  close(id?: string): void {
    const current = this.current
    if (!current || id && current.server.id !== id) return
    this.current = null
    this.detach(current.view)
    current.view.webContents.close({ waitForBeforeUnload: false })
  }
}
