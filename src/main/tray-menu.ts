import type { MenuItemConstructorOptions } from 'electron'
import type { AppState, Command } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import { clientActions } from '../shared/actions'

export function trayMenuTemplate(state: AppState, actions: { show: () => void; run: (command: Command) => void; quit: () => void }): MenuItemConstructorOptions[] {
  const registry = clientActions(state)
  const action = (id: string) => registry.find(item => item.id === id)!
  return [
    { id: 'show', label: '显示主窗口', click: actions.show },
    { type: 'separator' },
    { id: 'servers', label: '切换服务器', submenu: [
      { id: LOCAL_SERVER_ID, label: '本机 DSH', type: 'radio', checked: state.activeId === LOCAL_SERVER_ID, click: () => actions.run({ type: 'select', id: LOCAL_SERVER_ID }) },
      ...state.servers.filter(server => !server.local).map(server => ({ id: server.id, label: server.name.replaceAll('&', '&&'), type: 'radio' as const, checked: state.activeId === server.id, click: () => actions.run({ type: 'select', id: server.id }) })),
    ] },
    { id: 'local', label: '本机 DSH', submenu: [
      { id: 'start', label: '启动', enabled: action('local-start').enabled, click: () => actions.run(action('local-start').command) },
      { id: 'stop', label: '停止', enabled: action('local-stop').enabled, click: () => actions.run(action('local-stop').command) },
      { id: 'restart', label: '重启', enabled: action('local-restart').enabled, click: () => actions.run(action('local-restart').command) },
      { type: 'separator' },
      { label: '管理运行环境', click: () => actions.run({ type: 'overlay', overlay: { kind: 'local' } }) },
    ] },
    { type: 'separator' },
    { label: '快捷操作', click: () => actions.run({ type: 'overlay', overlay: { kind: 'palette' } }) },
    { label: '任务通知中心', click: () => actions.run(action('notifications').command) },
    { label: '客户端更新中心', click: () => actions.run(action('updates').command) },
    { label: '网页开发者工具', click: () => actions.run(action('devtools').command) },
    { id: 'settings', label: '设置', click: () => actions.run({ type: 'overlay', overlay: { kind: 'settings' } }) },
    { id: 'about', label: '关于 DSH Switcher', click: () => actions.run({ type: 'overlay', overlay: { kind: 'about' } }) },
    { type: 'separator' },
    { id: 'quit', label: '退出', click: actions.quit },
  ]
}
