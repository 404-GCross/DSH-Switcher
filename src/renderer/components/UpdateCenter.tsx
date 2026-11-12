import { Download, FolderOpen, RefreshCw, X } from 'lucide-react'
import type { AppState, Command, UpdateFormat, UpdatePreferences } from '../../shared/types'

export function UpdateCenter({ state, run, close, error }: { state: AppState; run: (command: Command) => Promise<boolean>; close: () => void; error: string }) {
  const update = state.updates
  const busy = update.status === 'checking' || update.status === 'downloading'
  const configure = (change: Partial<UpdatePreferences>) => void run({ type: 'update.configure', value: { channel: update.channel, checkOnStartup: update.checkOnStartup, format: update.format, ...change } })
  const formats = update.detectedFormat === 'dmg' ? ['dmg', 'zip'] : update.detectedFormat === 'zip' ? ['zip'] : ['rpm', 'deb', 'AppImage', 'tar.gz']
  return <>
    <header className="modal-heading"><h2 id="dialog-title">客户端更新中心</h2><button className="icon-button" aria-label="关闭更新中心" onClick={close}><X /></button></header>
    <p className="modal-description">当前客户端：{state.appVersion}。本机官方 DSH 的版本在“管理本机 DSH”中更新。</p>
    <label className="field">发布渠道<select aria-label="发布渠道" value={update.channel} disabled={busy} onChange={event => configure({ channel: event.target.value as UpdatePreferences['channel'] })}><option value="dev">开发版（dev）</option><option value="stable">稳定版</option></select></label>
    <label className="field">安装包类型<select aria-label="安装包类型" value={update.format} disabled={busy} onChange={event => configure({ format: event.target.value as UpdateFormat })}><option value="auto">自动识别（{update.detectedFormat}）</option>{formats.map(format => <option key={format}>{format}</option>)}</select></label>
    <label className="settings-toggle"><input type="checkbox" checked={update.checkOnStartup} disabled={busy} onChange={event => configure({ checkOnStartup: event.target.checked })} />启动时检查客户端更新</label>
    <div className="runtime-controls"><button className="secondary" disabled={busy} onClick={() => void run({ type: 'update.check' })}><RefreshCw />{update.status === 'checking' ? '检查中…' : '检查更新'}</button>{busy && <button className="plain-button" onClick={() => void run({ type: 'update.cancel' })}>取消</button>}</div>
    {(error || update.error) && <p className="form-error" role="alert">{error || update.error}</p>}
    {update.status === 'current' && <p className="field-help">当前渠道没有比已安装版本更新的发布。</p>}
    {update.release && <section className="release-details"><h3>{update.release.version}</h3><p className="field-help">{update.release.filename} · {(update.release.bytes / 1024 / 1024).toFixed(1)} MB</p><pre className="release-notes">{update.release.notes || '此版本没有提供更新说明。'}</pre>
      {update.status === 'downloading' && <div className="runtime-progress"><progress max="100" value={update.progress ?? undefined} /><span>{update.progress === null ? '正在下载…' : `${Math.round(update.progress)}%`}</span></div>}
      {['available', 'error'].includes(update.status) && <button className="primary" disabled={busy} onClick={() => void run({ type: 'update.download' })}><Download />下载并校验安装包</button>}
      {update.downloadedPath && <><p className="field-help">SHA256 校验通过</p><button className="primary" onClick={() => void run({ type: 'update.open' })}><FolderOpen />打开安装包或所在目录</button></>}
    </section>}
    <p className="field-help">下载完成后使用系统安装工具更新；ZIP、AppImage 和 tar.gz 会定位到下载文件。更新客户端前请结束需要保留的本机任务。</p>
  </>
}
