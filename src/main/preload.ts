import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, Command, DesktopBridge } from '../shared/types'

const bridge: DesktopBridge = {
  state: () => ipcRenderer.invoke('switcher:state'),
  command: (command: Command) => ipcRenderer.invoke('switcher:command', command),
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state)
    ipcRenderer.on('switcher:state-changed', handler)
    return () => ipcRenderer.removeListener('switcher:state-changed', handler)
  },
}
contextBridge.exposeInMainWorld('desktop', bridge)
