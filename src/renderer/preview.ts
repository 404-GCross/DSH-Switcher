import type { AppState, Command, CommandResult, DesktopBridge } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import { parseServerUrl, loginUrlFor } from '../main/server-url'
import { clientActions } from '../shared/actions'

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
    local: { installation: null, process: 'stopped', operation: null, candidates: [], latestVersion: null, error: null, logs: [], dataDirectory: '/home/demo/.dsh', runtimeDirectory: '用户数据目录/local-runtime', home: { selection: { mode: 'official' }, profile: 'web', officialDirectory: '/home/demo/.dsh', legacyDirectory: '用户数据目录/local-dsh', migrationPending: false, legacyHasData: false, targetHasData: false, backupDirectory: null } },
    desktop: { closeBehavior: 'tray', paletteShortcut: 'mod+shift+p', devToolsOpen: false, tray: { status: 'unavailable', detail: '浏览器预览不提供系统托盘，桌面版会检测实际托盘服务。' } },
    recentServerIds: [ids[1]],
    updates: { channel: 'dev', checkOnStartup: false, format: 'auto', detectedFormat: 'deb', status: 'idle', release: null, error: null, progress: null, downloadedPath: null },
    notifications: { enabled: true, sound: false, quiet: false, serverIds: [], items: [], monitors: [], supported: false },
  }
  const listeners = new Set<(state: AppState) => void>()
  const publish = () => { for (const listener of listeners) listener(structuredClone(state)) }
  let installTimer: ReturnType<typeof setTimeout> | undefined
  const system = matchMedia('(prefers-color-scheme: dark)')
  system.addEventListener('change', () => {
    if (state.theme === 'system') { state.dark = system.matches; publish() }
  })
  async function command(command: Command): Promise<CommandResult> {
    try {
      switch (command.type) {
        case 'action': {
          const item = clientActions(state).find(item => item.id === command.id)
          if (!item?.enabled) throw new Error('此操作当前不可用')
          state.overlay = null
          return await bridgeCommand(item.command)
        }
        case 'overlay': state.overlay = command.overlay; break
        case 'select': state.activeId = command.id; state.overlay = command.id === LOCAL_SERVER_ID && !state.local.installation ? { kind: 'local' } : null; break
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
        case 'local.detect': state.local.candidates = []; state.local.logs.push('示例：没有检测到本机安装，可使用一键安装。'); break
        case 'local.check-update': state.local.latestVersion = '0.2.2-rc.1'; break
        case 'local.open-data-directory': state.notice = '桌面版会打开本机 DSH 数据目录'; break
        case 'local.copy-data-directory': state.notice = '桌面版会复制所选数据目录的路径'; break
        case 'local.configure-home':
          state.local.home.selection = command.selection
          state.local.home.profile = command.selection.mode === 'legacy' ? 'switcher' : 'web'
          state.local.dataDirectory = command.selection.mode === 'custom' ? command.selection.directory : command.selection.mode === 'official' ? state.local.home.officialDirectory : state.local.home.legacyDirectory
          state.local.home.migrationPending = false
          break
        case 'local.migrate-home': state.notice = '桌面版会备份旧数据并验证迁移，此处仅为预览'; break
        case 'desktop.close-behavior': state.desktop.closeBehavior = command.value; break
        case 'desktop.check-tray': state.notice = '浏览器预览没有原生托盘，桌面版会重新检测'; break
        case 'desktop.show': break
        case 'desktop.quit': state.notice = '桌面版将停止托管进程并退出；浏览器预览不会关闭标签页'; break
        case 'desktop.devtools': state.notice = '桌面版会打开当前网页的 Chromium 开发者工具（F12）'; break
        case 'desktop.palette-shortcut': state.desktop.paletteShortcut = command.value; break
        case 'update.configure': Object.assign(state.updates, command.value); break
        case 'update.check': state.updates.status = 'current'; state.notice = '浏览器预览不查询真实发布信息'; break
        case 'update.cancel': state.updates.status = 'idle'; break
        case 'update.download':
        case 'update.open': state.notice = '桌面版提供安装包下载与校验'; break
        case 'notifications.configure': Object.assign(state.notifications, command.value); break
        case 'notifications.read': state.notifications.items = state.notifications.items.map(item => !command.id || item.id === command.id ? { ...item, read: true } : item); break
        case 'notifications.clear': state.notifications.items = []; break
        case 'notifications.retry': state.notice = '浏览器预览不连接任务事件接口'; break
        case 'notifications.open':
        case 'notifications.copy-session': break
        case 'local.cancel': clearTimeout(installTimer); state.local.operation = null; state.local.error = '演示操作已取消'; break
        case 'local.install':
        case 'local.use-existing': {
          if (state.local.operation) throw new Error('请先完成或取消当前操作')
          state.activeId = LOCAL_SERVER_ID
          state.local.error = null
          state.local.operation = { kind: 'install', stage: '下载官方运行环境（演示）', progress: 0, cancellable: true }
          let progress = 0
          const tick = () => {
            progress += 20
            if (progress >= 100) {
              state.local.installation = { source: 'managed', version: '0.2.2-rc.1', nodePath: '/示例/node', cliPath: '/示例/dsh/lib/bin.js', pnpmPath: '/示例/pnpm', root: '/示例/runtime' }
              state.local.operation = null; state.local.process = 'running'
              if (!state.servers.some(item => item.id === LOCAL_SERVER_ID)) state.servers.push({ id: LOCAL_SERVER_ID, local: true, name: '本机 DSH', url: 'http://127.0.0.1:40000/', status: 'ready' })
              state.local.logs.push('示例：DSH 已启动并自动登录，未执行真实安装。')
            } else {
              state.local.operation = { kind: 'install', stage: progress >= 60 ? '验证 DSH 并自动登录（演示）' : '下载官方运行环境（演示）', progress, cancellable: true }
              installTimer = setTimeout(tick, 450)
            }
            state = structuredClone(state); publish()
          }
          installTimer = setTimeout(tick, 450)
          break
        }
        case 'local.stop': state.local.process = 'stopped'; state.servers = state.servers.map(item => item.id === LOCAL_SERVER_ID ? { ...item, status: 'idle' } : item); break
        case 'local.start':
        case 'local.restart':
          if (!state.local.installation) throw new Error('请先安装本机 DSH')
          state.activeId = LOCAL_SERVER_ID; state.local.process = 'running'; state.overlay = null
          state.servers = state.servers.map(item => item.id === LOCAL_SERVER_ID ? { ...item, status: 'ready' } : item)
          break
      }
      state = structuredClone(state)
      publish()
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败' } }
  }
  const bridgeCommand = command
  return {
    state: async () => structuredClone(state), command,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
