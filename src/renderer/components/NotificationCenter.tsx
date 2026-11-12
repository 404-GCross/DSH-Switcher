import { Bell, Copy, ExternalLink, RefreshCw, X } from 'lucide-react'
import type { AppState, Command, NotificationPreferences } from '../../shared/types'
import { LOCAL_SERVER_ID } from '../../shared/types'

export function NotificationCenterPanel({ state, run, close, error }: { state: AppState; run: (command: Command) => Promise<boolean>; close: () => void; error: string }) {
  const notifications = state.notifications
  const configure = (change: Partial<NotificationPreferences>) => void run({ type: 'notifications.configure', value: { enabled: notifications.enabled, sound: notifications.sound, quiet: notifications.quiet, serverIds: notifications.serverIds, ...change } })
  const servers = state.servers.some(server => server.id === LOCAL_SERVER_ID) ? state.servers : [...state.servers, { id: LOCAL_SERVER_ID, name: '本机 DSH' }]
  return <>
    <header className="modal-heading"><h2 id="dialog-title">任务通知中心</h2><button className="icon-button" aria-label="关闭通知中心" onClick={close}><X /></button></header>
    <p className="modal-description">选择要监听的服务器。收起窗口、切换网页后仍可接收任务事件；退出客户端后停止监听。</p>
    <div className="notification-preferences">
      <label className="settings-toggle"><input type="checkbox" checked={notifications.enabled} onChange={event => configure({ enabled: event.target.checked })} />启用任务通知</label>
      <label className="settings-toggle"><input type="checkbox" checked={notifications.sound} onChange={event => configure({ sound: event.target.checked })} />通知声音</label>
      <label className="settings-toggle"><input type="checkbox" checked={notifications.quiet} onChange={event => configure({ quiet: event.target.checked })} />免打扰（仍记录通知）</label>
    </div>
    {!notifications.supported && <p className="field-help">当前环境不支持系统通知，任务消息仍会保留在此列表。</p>}
    <details className="runtime-details" open={!notifications.serverIds.length || undefined}><summary>监听服务器</summary>{servers.map(server => {
      const status = notifications.monitors.find(item => item.serverId === server.id)
      return <div className="monitor-row" key={server.id}><label className="settings-toggle"><input type="checkbox" checked={notifications.serverIds.includes(server.id)} disabled={!notifications.enabled} onChange={event => configure({ serverIds: event.target.checked ? [...notifications.serverIds, server.id] : notifications.serverIds.filter(id => id !== server.id) })} />{server.name}</label><small>{status?.detail ?? (notifications.serverIds.includes(server.id) ? '等待服务器启动或启用通知' : '未监听')}</small></div>
    })}<button className="plain-button" onClick={() => void run({ type: 'notifications.retry' })}><RefreshCw />重新连接通知接口</button></details>
    <div className="runtime-controls"><button className="secondary" disabled={!notifications.items.some(item => !item.read)} onClick={() => void run({ type: 'notifications.read' })}>全部已读</button><button className="plain-button" disabled={!notifications.items.length} onClick={() => void run({ type: 'notifications.clear' })}>清空记录</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="notification-list">{notifications.items.map(item => <article key={item.id} className={`task-notice ${item.read ? 'read' : 'unread'}`}><div><strong>{item.sessionTitle}</strong><span>{item.serverName} · {new Date(item.createdAt).toLocaleString()}</span></div><p className={item.kind === 'failed' ? 'danger' : ''}>{item.text}</p><div className="runtime-controls"><button className="secondary" onClick={() => void run({ type: 'notifications.open', id: item.id })}><ExternalLink />打开服务器</button><button className="plain-button" onClick={() => void run({ type: 'notifications.copy-session', id: item.id })}><Copy />复制会话 ID</button>{!item.read && <button className="plain-button" onClick={() => void run({ type: 'notifications.read', id: item.id })}>已读</button>}</div></article>)}</div>
    {!notifications.items.length && <div className="notification-empty"><Bell /><p>暂无任务通知</p></div>}
    <p className="field-help">使用官方 DSH 会话接口监听，首次连接不会推送旧任务。最多监听 20 台服务器，每台跟踪最近 100 个活跃会话；记录保留最近 200 条。</p>
  </>
}
