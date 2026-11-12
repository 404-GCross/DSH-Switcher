import { Menu } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

export class DevToolsController {
  private contents = new Set<WebContents>()
  constructor(private window: BrowserWindow, private changed: () => void) {}
  register(contents: WebContents): void {
    this.contents.add(contents)
    contents.on('devtools-opened', () => {
      this.changed()
      contents.devToolsWebContents?.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F12' && !input.isAutoRepeat) { event.preventDefault(); contents.closeDevTools() }
      })
    })
    contents.on('devtools-closed', this.changed)
    contents.once('destroyed', () => { this.contents.delete(contents); this.changed() })
    contents.on('context-menu', (_event, params) => {
      if (contents.isDestroyed()) return
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.isEditable) items.push(
        { label: '剪切', enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: '复制', enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: '粘贴', enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: '全选', click: () => contents.selectAll() },
      )
      else if (params.selectionText) items.push({ label: '复制', click: () => contents.copy() })
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: '检查元素', click: () => {
        if (contents.isDestroyed()) return
        contents.openDevTools({ mode: 'detach' })
        contents.inspectElement(params.x, params.y)
      } })
      Menu.buildFromTemplate(items).popup({ window: this.window })
    })
  }
  toggle(contents: WebContents): void {
    if (contents.isDestroyed()) return
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach' })
  }
  closeAll(): void { for (const contents of this.contents) if (!contents.isDestroyed()) contents.closeDevTools() }
}
