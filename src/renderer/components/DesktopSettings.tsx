import { useState } from 'react'
import { X, RefreshCw, LogOut } from 'lucide-react'
import type { AppState, CloseBehavior, Command, Theme } from '../../shared/types'

export function DesktopSettings({ state, run, close, error }: { state: AppState; run: (command: Command) => Promise<boolean>; close: () => void; error: string }) {
  const [checking, setChecking] = useState(false)
  return <>
    <header className="modal-heading"><h2 id="dialog-title">客户端设置</h2><button className="icon-button" aria-label="关闭设置" onClick={close}><X /></button></header>
    <div className="settings-row"><span>外观</span><div className="segmented">{(['light', 'dark', 'system'] as Theme[]).map((theme, index) => <button key={theme} aria-pressed={state.theme === theme} onClick={() => void run({ type: 'theme', theme })}>{['浅色', '深色', '系统'][index]}</button>)}</div></div>
    <label className="field">关闭窗口时<select aria-label="关闭窗口时" value={state.desktop.closeBehavior} onChange={event => void run({ type: 'desktop.close-behavior', value: event.target.value as CloseBehavior })}>
      <option value="tray">收起到系统托盘</option><option value="minimize">最小化</option><option value="quit">退出程序</option>
    </select></label>
    <div className="tray-status" role="status"><span className={`status-dot ${state.desktop.tray.status === 'available' ? 'ready' : 'idle'}`} /><div><strong>{state.desktop.tray.status === 'available' ? '系统托盘可用' : state.desktop.tray.status === 'checking' ? '正在检测托盘' : '系统托盘暂不可用'}</strong><p>{state.desktop.tray.detail}</p></div></div>
    <button className="secondary" disabled={checking} onClick={async () => { setChecking(true); try { await run({ type: 'desktop.check-tray' }) } finally { setChecking(false) } }}><RefreshCw />{checking ? '检测中…' : '重新检测托盘'}</button>
    <p className="field-help">收起和最小化会保留当前网页及本机任务。切换服务器会关闭旧网页，未保存的草稿可能丢失。真正退出会停止客户端托管的本机 DSH。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="modal-actions"><button className="plain-button danger" onClick={() => void run({ type: 'desktop.quit' })}><LogOut />退出客户端</button></footer>
  </>
}
