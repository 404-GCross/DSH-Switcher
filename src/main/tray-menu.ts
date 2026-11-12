import type { MenuItemConstructorOptions } from 'electron'
import type { AppState, Command } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'

export function trayMenuTemplate(state: AppState, actions: { show: () => void; run: (command: Command) => void; quit: () => void }): MenuItemConstructorOptions[] {
  const busy = !!state.local.operation
  const canStart = !busy && !!state.local.installation && !state.local.home.migrationPending
  return [
    { id: 'show', label: '显示主窗口', click: actions.show },
    { type: 'separator' },
    { id: 'servers', label: '切换服务器', submenu: [
      { id: LOCAL_SERVER_ID, label: '本机 DSH', type: 'radio', checked: state.activeId === LOCAL_SERVER_ID, click: () => actions.run({ type: 'select', id: LOCAL_SERVER_ID }) },
      ...state.servers.filter(server => !server.local).map(server => ({ id: server.id, label: server.name.replaceAll('&', '&&'), type: 'radio' as const, checked: state.activeId === server.id, click: () => actions.run({ type: 'select', id: server.id }) })),
    ] },
    { id: 'local', label: '本机 DSH', submenu: [
      { id: 'start', label: '启动', enabled: canStart && state.local.process !== 'running', click: () => actions.run({ type: 'local.start' }) },
      { id: 'stop', label: '停止', enabled: !busy && state.local.process === 'running', click: () => actions.run({ type: 'local.stop' }) },
      { id: 'restart', label: '重启', enabled: canStart, click: () => actions.run({ type: 'local.restart' }) },
      { type: 'separator' },
      { label: '管理运行环境', click: () => actions.run({ type: 'overlay', overlay: { kind: 'local' } }) },
    ] },
    { type: 'separator' },
    { id: 'settings', label: '设置', click: () => actions.run({ type: 'overlay', overlay: { kind: 'settings' } }) },
    { id: 'about', label: '关于 DSH Switcher', click: () => actions.run({ type: 'overlay', overlay: { kind: 'about' } }) },
    { type: 'separator' },
    { id: 'quit', label: '退出', click: actions.quit },
  ]
}
