import type { AppState, Command, PaletteShortcut } from './types'
import { LOCAL_SERVER_ID } from './types'

export interface ClientAction { id: string; label: string; detail?: string; keywords: string; enabled: boolean; command: Command }
export function clientActions(state: AppState): ClientAction[] {
  const actions: ClientAction[] = []
  const add = (id: string, label: string, command: Command, keywords = '', enabled = true, detail?: string) => actions.push({ id, label, command, keywords, enabled, detail })
  const order = state.recentServerIds ?? []
  const servers = [...state.servers].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id)
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi)
  })
  if (!servers.some(server => server.id === LOCAL_SERVER_ID)) add(`server:${LOCAL_SERVER_ID}`, '本机 DSH', { type: 'select', id: LOCAL_SERVER_ID }, 'local localhost 本地')
  for (const server of servers) add(`server:${server.id}`, `切换到 ${server.name}`, { type: 'select', id: server.id }, `${server.name} ${server.url} server 连接`, true, order.includes(server.id) ? '最近使用' : server.url)
  add('connections', '服务器连接', { type: 'overlay', overlay: { kind: 'instances' } }, 'server switch')
  add('add', '添加服务器', { type: 'overlay', overlay: { kind: 'add' } }, 'add connection')
  if (state.activeId) {
    add('reload', '重新加载当前网页', { type: 'reload', id: state.activeId }, 'reload refresh 刷新')
    add('external', '在系统浏览器打开', { type: 'external', id: state.activeId }, 'browser external', !!state.servers.find(server => server.id === state.activeId)?.url)
  }
  add('devtools', '网页开发者工具', { type: 'desktop.devtools', target: 'page' }, 'F12 inspect console network 开发调试')
  add('shell-devtools', '客户端界面开发者工具', { type: 'desktop.devtools', target: 'shell' }, 'shell inspect 底栏 设置 调试')
  const busy = !!state.local.operation
  const installed = !!state.local.installation && !state.local.home.migrationPending
  add('local-start', '启动本机 DSH', { type: 'local.start' }, 'start local', !busy && installed && state.local.process !== 'running')
  add('local-stop', '停止本机 DSH', { type: 'local.stop' }, 'stop local', !busy && state.local.process === 'running')
  add('local-restart', '重启本机 DSH', { type: 'local.restart' }, 'restart local', !busy && installed)
  add('local-manage', '管理本机运行环境', { type: 'overlay', overlay: { kind: 'local' } }, 'runtime install 安装')
  add('data', '打开本机数据目录', { type: 'local.open-data-directory' }, 'folder home')
  add('updates', '客户端更新中心', { type: 'overlay', overlay: { kind: 'updates' } }, 'update download 升级')
  add('notifications', '任务通知中心', { type: 'overlay', overlay: { kind: 'notifications' } }, 'notification history 消息')
  add('settings', '客户端设置', { type: 'overlay', overlay: { kind: 'settings' } }, 'settings preference')
  add('about', '关于 DSH Switcher', { type: 'overlay', overlay: { kind: 'about' } }, 'about version')
  add('show', '显示主窗口', { type: 'desktop.show' }, 'show window')
  add('quit', '退出客户端', { type: 'desktop.quit' }, 'quit exit')
  return actions
}

export function matchesPaletteShortcut(input: { key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }, shortcut: PaletteShortcut, platform = process.platform): boolean {
  const [, modifier, key] = shortcut.split('+')
  return input.key.toLowerCase() === key && (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)
    && input.alt === (modifier === 'alt') && input.shift === (modifier === 'shift')
}
