import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Layers, Monitor, ChevronUp, Plus, Star, ExternalLink, Pencil, Trash2,
  RefreshCw, Sun, Moon, Check, X, Search, Globe, ArrowUp, Folder,
  MessageSquare, PanelLeft, Puzzle, LoaderCircle, CircleAlert, KeyRound,
  Settings2, ArrowRight, Info,
} from 'lucide-react'
import type { AppState, Command, Connection, DesktopBridge, Overlay, Theme } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import { LocalRuntimePanel, localStatus } from './components/LocalRuntimePanel'
import { DesktopSettings } from './components/DesktopSettings'
import { createPreviewBridge } from './preview'
import './styles.css'
import appIcon from '../../build/dsh-windows.png'

const bridge: DesktopBridge = window.desktop ?? createPreviewBridge()
const overlaySurface = new URLSearchParams(location.search).get('surface') === 'overlay'
document.documentElement.classList.toggle('overlay-surface', overlaySurface)

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} className={`icon-button ${props.className ?? ''}`} type="button" aria-label={label} title={label}>{children}</button>
}

const statusLabels: Record<Connection['status'], string> = {
  idle: '尚未打开', loading: '正在加载', ready: '网页已打开',
  'auth-required': '需要登录', forbidden: '访问被拒绝', offline: '无法连接',
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let received = false, alive = true
    const dispose = bridge.subscribe(next => { received = true; if (alive) setState(next) })
    void bridge.state().then(next => { if (alive && !received) setState(next) }, () => { if (alive) setFatal('无法连接到客户端主进程，请重新启动') })
    return () => { alive = false; dispose() }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = state?.dark ? 'dark' : 'light'
  }, [state?.dark])
  const run = useCallback(async (command: Command): Promise<boolean> => {
    try {
      const result = await bridge.command(command)
      if (!result.ok) { setError(result.error); return false }
      setError('')
      return true
    } catch { setError('客户端操作失败，请重试'); return false }
  }, [])
  useEffect(() => { setError('') }, [state?.overlay?.kind, state?.overlay && 'id' in state.overlay ? state.overlay.id : null])
  useEffect(() => {
    if (!state?.notice) return
    const timer = setTimeout(() => { void run({ type: 'dismiss-notice' }) }, 4500)
    return () => clearTimeout(timer)
  }, [state?.notice, run])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state?.overlay) { event.preventDefault(); void run({ type: 'overlay', overlay: null }) }
      if (!window.desktop && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault(); void run({ type: 'overlay', overlay: state?.overlay ? null : { kind: 'instances' } })
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [state?.overlay, run])
  if (fatal) return <div className="fatal" role="alert">{fatal}</div>
  if (!state) return overlaySurface ? null : <div className="loading"><LoaderCircle className="spin" /></div>
  const current = state.servers.find(server => server.id === state.activeId)
  const changeOverlay = (overlay: Overlay) => { void run({ type: 'overlay', overlay }) }
  const canShowOverlay = overlaySurface || state.preview
  return <>
    {!overlaySurface && <div className="shell">
      <section className="web-region">
        {state.preview && current?.status === 'ready'
          ? <DemoPage key={current.id} server={current} />
          : <ConnectionPage server={current} state={state} run={run} changeOverlay={changeOverlay} />}
      </section>
      <footer className="client-footer">
        <button className={`instance-trigger ${state.overlay ? 'selected' : ''}`} onClick={() => changeOverlay(state.overlay ? null : { kind: 'instances' })}
          aria-label="切换服务器" aria-haspopup="dialog" aria-expanded={!!state.overlay} title="切换服务器（Ctrl / ⌘ + Shift + S）">
          <Monitor /><span className={`status-dot ${current?.status ?? 'idle'}`} /><span className="trigger-name">{current?.name ?? '连接服务器'}</span><ChevronUp className="chevron" />
        </button>
        {state.preview && <span className="footer-caption">浏览器预览 · 示例数据</span>}
        <div className="footer-actions">
          {current && <IconButton label="重新加载网页" onClick={() => void run({ type: 'reload', id: current.id })}><RefreshCw /></IconButton>}
          {current?.local && <IconButton label="管理本机 DSH" onClick={() => changeOverlay({ kind: 'local' })}><Settings2 /></IconButton>}
          <IconButton label="切换客户端主题" onClick={() => void run({ type: 'theme', theme: state.dark ? 'light' : 'dark' })}>{state.dark ? <Moon /> : <Sun />}</IconButton>
          <IconButton label="客户端设置" onClick={() => changeOverlay({ kind: 'settings' })}><Settings2 /></IconButton>
          <IconButton label="关于 DSH Switcher" onClick={() => changeOverlay({ kind: 'about' })}><Info /></IconButton>
        </div>
      </footer>
      {(state.notice || error && !state.overlay) && <div className="notice" role="status">{error || state.notice}<IconButton label="关闭提示" onClick={() => { setError(''); void run({ type: 'dismiss-notice' }) }}><X /></IconButton></div>}
    </div>}
    {canShowOverlay && state.overlay && <OverlayContent state={state} run={run} error={error} changeOverlay={changeOverlay} />}
  </>
}

type Run = (command: Command) => Promise<boolean>
type ChangeOverlay = (overlay: Overlay) => void

function ConnectionPage({ server, state, run, changeOverlay }: { server?: Connection; state: AppState; run: Run; changeOverlay: ChangeOverlay }) {
  if (!server) return <div className="connection-page welcome-page">
    <div className="app-mark"><img src={appIcon} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div><p className="eyebrow">DSH SWITCHER</p>
    <h1>你的 DSH，随处连接</h1><p className="lead">本机、NAS 或云端服务器。<br />在一个窗口里，打开你熟悉的 DSH。</p>
    <div className="state-actions"><button className="primary" onClick={() => changeOverlay({ kind: 'local' })}><Monitor />使用本机 DSH</button><button className="secondary" onClick={() => changeOverlay({ kind: 'add' })}><Plus />连接远程服务器</button></div>
    <div className="welcome-features"><span>原生网页</span><i />独立登录<i /><span>原生插件</span></div>
  </div>
  if (server.status === 'ready') return <div className="remote-underlay" aria-hidden="true" />
  if (server.local) return <div className="connection-page"><div className="state-icon"><Monitor /></div><p className="eyebrow">本机 DSH</p><h1>{localStatus(state.local)}</h1><p className="lead">{state.local.error ?? (state.local.operation ? '正在准备官方 DSH 运行环境，你可以打开管理面板查看进度。' : state.local.home.migrationPending ? '请先在管理面板确认旧数据环境的迁移方式。' : '本机 DSH 使用所选配置目录，启动后自动登录。')}</p><button className="primary" onClick={() => changeOverlay({ kind: 'local' })}><Settings2 />管理本机 DSH</button><button className="secondary" onClick={() => changeOverlay({ kind: 'instances' })}>切换服务器</button></div>
  const loading = server.status === 'loading'
  const login = server.status === 'auth-required'
  return <div className="connection-page">
    <div className={`state-icon ${loading ? 'loading-icon' : ''}`}>{loading ? <LoaderCircle className="spin" /> : login ? <KeyRound /> : <Globe />}</div>
    <p className="eyebrow">{server.name}</p>
    <h1>{loading ? '正在打开你的工作空间' : login ? '登录这台服务器的 DSH' : server.status === 'forbidden' ? '服务器拒绝了访问' : '暂时无法连接'}</h1>
    <p className="lead">{loading ? '首次加载可能需要一点时间。' : login ? '使用 DSH 启动时提供的登录链接，完成首次认证。' : server.error ?? '请检查服务器地址，以及 DSH Web 服务是否已启动。'}</p>
    <code className="server-address">{server.url}</code>
    <div className="state-actions">
      {!loading && (login ? <button className="primary" onClick={() => changeOverlay({ kind: 'login', id: server.id })}><KeyRound />输入登录链接</button>
        : <button className="primary" onClick={() => void run({ type: 'reload', id: server.id })}><RefreshCw />重新加载</button>)}
      <button className="secondary" onClick={() => changeOverlay({ kind: 'instances' })}>切换服务器</button>
      {!loading && <button className="plain-button" onClick={() => changeOverlay({ kind: 'edit', id: server.id })}>编辑地址</button>}
    </div>
  </div>
}

function OverlayContent({ state, run, error, changeOverlay }: { state: AppState; run: Run; error: string; changeOverlay: ChangeOverlay }) {
  const panel = useRef<HTMLDivElement>(null)
  const overlay = state.overlay!
  const isMenu = overlay.kind === 'instances'
  const server = 'id' in overlay ? state.servers.find(item => item.id === overlay.id) : undefined
  useEffect(() => {
    const target = panel.current?.querySelector<HTMLElement>(isMenu ? '[aria-current="true"]' : 'input, button')
    target?.focus({ preventScroll: true })
  }, [overlay.kind, server?.id, isMenu])
  const trap = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]') ?? [])
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className={`overlay-backdrop ${isMenu ? 'menu-backdrop' : 'modal-backdrop'}`} onPointerDown={event => {
    if (event.target === event.currentTarget) changeOverlay(null)
  }}>
    <div className={isMenu ? 'instance-menu' : overlay.kind === 'local' ? 'modal local-modal' : 'modal'} ref={panel} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={trap}>
      {isMenu ? <InstanceMenu state={state} run={run} changeOverlay={changeOverlay} error={error} />
        : overlay.kind === 'local' ? <LocalRuntimePanel state={state} run={run} close={() => changeOverlay(null)} error={error} />
        : overlay.kind === 'settings' ? <DesktopSettings state={state} run={run} close={() => changeOverlay(null)} error={error} />
        : overlay.kind === 'about' ? <About state={state} run={run} close={() => changeOverlay(null)} />
        : overlay.kind === 'remove' && server ? <RemoveServer server={server} run={run} error={error} cancel={() => changeOverlay({ kind: 'edit', id: server.id })} />
        : <ServerForm key={`${overlay.kind}-${server?.id ?? ''}`} kind={overlay.kind as 'add' | 'edit' | 'login'} server={server} run={run} error={error} preview={state.preview} changeOverlay={changeOverlay} />}
    </div>
  </div>
}

function InstanceMenu({ state, run, changeOverlay, error }: { state: AppState; run: Run; changeOverlay: ChangeOverlay; error: string }) {
  const [query, setQuery] = useState('')
  const current = state.servers.find(server => server.id === state.activeId)
  const defaultServer = state.defaultId === LOCAL_SERVER_ID ? { name: '本机 DSH' } : state.servers.find(server => server.id === state.defaultId)
  const filtered = state.servers.filter(server => !server.local && `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <header className="menu-heading"><div><h2 id="dialog-title">服务器连接</h2><p>切换到你的另一个工作空间</p></div><IconButton label="关闭服务器菜单" onClick={() => changeOverlay(null)}><X /></IconButton></header>
    <div className="connection-summary"><span>当前</span><strong title={current?.name}>{current?.name ?? '未选择'}</strong><i>·</i><span>默认</span><strong title={defaultServer?.name}>{defaultServer?.name ?? '未设置'}</strong></div>
    {state.servers.length > 5 && <label className="menu-search"><Search /><input aria-label="查找服务器" placeholder="查找服务器…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className="instance-list">
      <div className={`instance-row local-instance ${state.activeId === LOCAL_SERVER_ID ? 'current' : ''}`}><button className="instance-select" aria-current={state.activeId === LOCAL_SERVER_ID} onClick={() => void run({ type: 'select', id: LOCAL_SERVER_ID })}><Monitor /><span className="instance-copy"><span className="instance-name">本机 DSH</span><span className="instance-status">{localStatus(state.local)}</span>{state.local.installation && <span className="instance-url">官方版本 {state.local.installation.version}</span>}</span></button><div className="instance-actions"><IconButton label="将本机 DSH 设为默认" className={state.defaultId === LOCAL_SERVER_ID ? 'favorite' : ''} onClick={() => void run({ type: 'default', id: LOCAL_SERVER_ID })}><Star /></IconButton><IconButton label="管理本机 DSH" onClick={() => changeOverlay({ kind: 'local' })}><Settings2 /></IconButton></div></div>
      {filtered.length === 0 && <div className="list-empty">{state.servers.length ? '没有匹配的服务器' : '添加一个 DSH Web 地址，开始连接。'}</div>}
      {filtered.map(server => <div key={server.id} className={`instance-row ${server.id === state.activeId ? 'current' : ''}`}>
        <button className="instance-select" onClick={() => void run({ type: 'select', id: server.id })} aria-current={server.id === state.activeId}>
          <span className={`status-dot ${server.status}`} /><span className="instance-copy"><span className="instance-name">{server.name}{server.id === state.activeId && <span className="current-badge">当前</span>}</span><span className={`instance-status ${server.status}`}>{statusLabels[server.status]}</span><span className="instance-url" title={server.url}>{server.url}</span></span>
        </button>
        <div className="instance-actions"><IconButton label={`将 ${server.name} 设为默认`} className={server.id === state.defaultId ? 'favorite' : ''} aria-pressed={server.id === state.defaultId} onClick={() => void run({ type: 'default', id: server.id })}><Star /></IconButton>
          <IconButton label={`编辑 ${server.name}`} onClick={() => changeOverlay({ kind: 'edit', id: server.id })}><Pencil /></IconButton>
          <IconButton label={`在浏览器打开 ${server.name}`} onClick={() => void run({ type: 'external', id: server.id })}><ExternalLink /></IconButton></div>
      </div>)}
    </div>
    {error && <p className="form-error menu-error" role="alert">{error}</p>}
    <footer className="menu-footer"><button className="add-instance" onClick={() => changeOverlay({ kind: 'add' })}><Plus />添加服务器</button><span>{state.preview ? '示例数据' : `${state.servers.length} 个连接`}</span></footer>
  </>
}

function ServerForm({ kind, server, run, error, preview, changeOverlay }: { kind: 'add' | 'edit' | 'login'; server?: Connection; run: Run; error: string; preview: boolean; changeOverlay: ChangeOverlay }) {
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(kind === 'login' ? '' : server?.url ?? '')
  const [pending, setPending] = useState(false)
  const title = kind === 'login' ? '登录远程 DSH' : kind === 'edit' ? '编辑服务器' : '添加服务器'
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    try {
      const ok = await run(kind === 'login' && server ? { type: 'login', id: server.id, url } : { type: 'save', id: server?.id, name: name.trim(), url })
      if (ok) setUrl('')
    } finally { setPending(false) }
  }
  return <form onSubmit={event => void submit(event)}>
    <header className="modal-heading"><h2 id="dialog-title">{title}</h2><IconButton label="关闭对话框" onClick={() => changeOverlay(null)} disabled={pending}><X /></IconButton></header>
    <p className="modal-description">{kind === 'login' ? `为 ${server?.name} 完成登录，Cookie 将保存在此连接的独立网页环境中。` : '保存 DSH 网页地址，随时从左下角切换。'}</p>
    {kind === 'login' && server && <p className="field-help">登录目标：<code className="server-address">{server.url}</code></p>}
    {kind !== 'login' && <label className="field">连接名称<input autoComplete="off" aria-label="连接名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的开发工作站" maxLength={80} required disabled={pending} /></label>}
    <label className="field">{kind === 'login' ? 'DSH 启动链接' : 'DSH Web 地址'}<input aria-label={kind === 'login' ? 'DSH 启动链接' : 'DSH Web 地址'} type={kind === 'login' ? 'password' : 'url'} autoComplete="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} placeholder={kind === 'login' ? '粘贴 DSH 启动时显示的完整链接' : 'https://dsh.example.com/'} maxLength={8192} required disabled={pending} /></label>
    <p className="field-help">{preview ? '浏览器预览不会连接服务器，请勿输入真实登录凭据。' : kind === 'login' ? '先验证 token 与登录 Cookie，再打开网页。链接不会保存到连接配置。' : '支持 HTTP / HTTPS 和带路径前缀的地址。启动链接中的 token 仅用于登录，不保存到配置。'}</p>
    <div className="form-error" role="alert">{error}</div>
    {kind === 'edit' && server && <div className="edit-tools"><button type="button" className="plain-button" disabled={pending} onClick={() => changeOverlay({ kind: 'login', id: server.id })}><KeyRound />重新登录</button><button type="button" className="plain-button danger" disabled={pending} onClick={() => changeOverlay({ kind: 'remove', id: server.id })}><Trash2 />移除连接</button></div>}
    <footer className="modal-actions"><button type="button" className="secondary" disabled={pending} onClick={() => changeOverlay({ kind: 'instances' })}>取消</button><button className="primary" disabled={pending || kind !== 'login' && !name.trim()} type="submit">{pending && <LoaderCircle className="spin" />}{pending && kind === 'login' ? '正在验证登录…' : kind === 'login' ? '登录并打开' : kind === 'edit' ? '保存并打开' : '添加并打开'}</button></footer>
  </form>
}

function RemoveServer({ server, run, error, cancel }: { server: Connection; run: Run; error: string; cancel: () => void }) {
  const [pending, setPending] = useState(false)
  return <><header className="modal-heading"><h2 id="dialog-title">移除连接</h2><IconButton label="取消移除" onClick={cancel} disabled={pending}><X /></IconButton></header><p className="modal-description">移除「{server.name}」并关闭它的网页。服务器上的 DSH、会话和文件不受影响。</p><div className="form-error" role="alert">{error}</div><footer className="modal-actions"><button className="secondary" disabled={pending} onClick={cancel}>取消</button><button className="primary danger-button" disabled={pending} onClick={async () => { setPending(true); await run({ type: 'remove', id: server.id }); setPending(false) }}>移除连接</button></footer></>
}

function About({ state, run, close }: { state: AppState; run: Run; close: () => void }) {
  return <><header className="modal-heading"><h2 id="dialog-title">DSH Switcher</h2><IconButton label="关闭关于" onClick={close}><X /></IconButton></header><p className="modal-description">一个客户端，多个 DSH。原生网页、独立登录，服务器无需安装额外插件。</p><div className="settings-row"><span>客户端外观</span><div className="segmented">{(['light', 'dark', 'system'] as Theme[]).map((theme, index) => <button key={theme} aria-pressed={state.theme === theme} onClick={() => void run({ type: 'theme', theme })}>{['浅色', '深色', '系统'][index]}</button>)}</div></div><p className="field-help">切换服务器：Ctrl / ⌘ + Shift + S<br />原生网页的主题由 DSH 自己管理。</p><p className="version-label">版本 {state.appVersion}{state.preview ? ' · 浏览器交互预览' : ' · 桌面预览版'}</p></>
}

/** The browser preview illustrates the native view area; Electron loads the real server instead. */
function DemoPage({ server }: { server: Connection }) {
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  return <div className="demo-page"><aside className="demo-sidebar"><button className="demo-new" onClick={() => { setDraft(''); setMessage('') }}><Plus />新对话</button><div className="demo-tools"><Search /><Puzzle /><Folder /></div><small>今天</small><button className="demo-thread active" onClick={() => setMessage('前端客户端设计')}>前端客户端设计</button><button className="demo-thread" onClick={() => setMessage('梳理项目结构')}>梳理项目结构</button><small>工作区</small><div className="demo-project"><Folder />deepseek-harness</div><button className="demo-thread" onClick={() => setMessage('检查 Docker 配置')}>检查 Docker 配置</button><button className="demo-thread" onClick={() => setMessage('优化文件搜索工具')}>优化文件搜索工具</button><div className="demo-project"><Folder />personal-site</div><button className="demo-thread" onClick={() => setMessage('更新项目文档')}>更新项目文档</button><span className="demo-sidebar-note">DSH 原生侧栏示意</span></aside><main className="demo-main"><header><div><span>{message || '新对话'}</span><small>deepseek-harness</small></div><span className="demo-page-label">原生网页区域示意</span></header><div className="demo-conversation"><div className="demo-welcome"><p><Layers />DeepSeek Harness</p><h1>今天，从哪里开始？</h1><span>在 {server.name} 上，继续你的下一次探索。</span></div>{message && <div className="demo-message">{message}<small>这是界面预览；桌面版将显示真实 DSH 网页。</small></div>}<form className="demo-composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) { setMessage(draft); setDraft('') } }}><textarea aria-label="示例任务输入" value={draft} onChange={event => setDraft(event.target.value)} placeholder="描述任务，或输入 / 查看命令" /><div><Plus /><span>DeepSeek-V4.1-Flash</span><button aria-label="发送示例消息" disabled={!draft.trim()}><ArrowUp /></button></div></form><div className="demo-suggestions"><button onClick={() => setDraft('帮我梳理这个项目的结构')}><Folder />梳理项目结构</button><button onClick={() => setDraft('检查当前工作区的代码变更')}><Settings2 />检查代码变更</button></div><div className="demo-recent"><small>继续最近的对话</small>{['梳理项目结构', '检查 Docker 配置'].map((item, index) => <button key={item} onClick={() => setMessage(item)}><MessageSquare />{item}<time>{index ? '2 小时前' : '刚刚'}</time></button>)}</div><p className="demo-caption">仅浏览器预览使用示意内容 · 桌面版直接打开服务器网页</p></div></main></div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
