import type { AppState, Command, CommandResult, DesktopBridge } from '../shared/types'
import { parseServerUrl, loginUrlFor } from '../main/server-url'

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']

/** Browser-only interaction demo. It never fetches or authenticates to the entered servers. */
export function createPreviewBridge(): DesktopBridge {
  let state: AppState = {
    servers: [
      { id: ids[0], name: '本机 Local', url: 'http://127.0.0.1:3080/', status: 'ready' },
      { id: ids[1], name: '开发工作站', url: 'https://dsh.home.example/', status: 'ready' },
      { id: ids[2], name: '云端开发机', url: 'https://dsh.cloud.example/', status: 'auth-required' },
      { id: ids[3], name: '测试环境', url: 'https://dsh.test.example/', status: 'offline', error: '无法访问此服务器（演示状态）' },
    ],
    activeId: ids[1], defaultId: ids[1], theme: 'light', dark: false,
    overlay: { kind: 'instances' }, notice: null, preview: true, appVersion: '0.1.0',
  }
  const listeners = new Set<(state: AppState) => void>()
  const publish = () => { for (const listener of listeners) listener(structuredClone(state)) }
  const system = matchMedia('(prefers-color-scheme: dark)')
  system.addEventListener('change', () => {
    if (state.theme === 'system') { state.dark = system.matches; publish() }
  })
  async function command(command: Command): Promise<CommandResult> {
    try {
      switch (command.type) {
        case 'overlay': state.overlay = command.overlay; break
        case 'select': state.activeId = command.id; state.overlay = null; break
        case 'default': state.defaultId = command.id; break
        case 'save': {
          const url = parseServerUrl(command.url).baseUrl
          if (!command.name.trim()) throw new Error('请填写连接名称')
          const id = command.id ?? crypto.randomUUID()
          const record = { id, name: command.name.trim(), url, status: 'ready' as const }
          state.servers = command.id ? state.servers.map(server => server.id === id ? record : server) : [...state.servers, record]
          state.defaultId ??= id
          state.activeId = id
          state.overlay = null
          state.notice = '示例连接已保存；浏览器预览不会连接真实服务器'
          break
        }
        case 'remove':
          state.servers = state.servers.filter(server => server.id !== command.id)
          if (state.defaultId === command.id) state.defaultId = state.servers[0]?.id ?? null
          if (state.activeId === command.id) state.activeId = state.defaultId
          state.overlay = null
          break
        case 'login': {
          const server = state.servers.find(server => server.id === command.id)
          if (server) {
            loginUrlFor(server.url, command.url)
            server.status = 'ready'
            server.error = undefined
            state.activeId = server.id
            state.overlay = null
            state.notice = '仅演示登录后的界面，未发起真实认证'
          }
          break
        }
        case 'reload': {
          const server = state.servers.find(server => server.id === command.id)
          if (server) { server.status = 'ready'; server.error = undefined }
          state.notice = '已重新加载示例页面'
          break
        }
        case 'external': state.notice = '正式桌面版会在系统浏览器打开这个地址'; break
        case 'theme': state.theme = command.theme; state.dark = command.theme === 'dark' || command.theme === 'system' && system.matches; break
        case 'dismiss-notice': state.notice = null; break
      }
      state = structuredClone(state)
      publish()
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败' } }
  }
  return {
    state: async () => structuredClone(state), command,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
