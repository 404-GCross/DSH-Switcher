import { useState } from 'react'
import { Download, FolderOpen, LoaderCircle, Monitor, Play, RefreshCw, Search, Square, Terminal, X } from 'lucide-react'
import type { AppState, Command, LocalRuntimeState } from '../../shared/types'
import { DshDataSettings } from './DshDataSettings'

export const localStatus = (state: LocalRuntimeState): string => {
  if (state.operation) return state.operation.stage
  if (!state.installation) return '尚未安装'
  return { stopped: '已安装 · 未运行', starting: '正在启动', running: '本机 DSH 运行中', stopping: '正在停止', failed: '启动失败' }[state.process]
}

export function LocalRuntimePanel({ state, run, close, error }: {
  state: AppState; run: (command: Command) => Promise<boolean>; close: () => void; error: string
}) {
  const [version, setVersion] = useState('latest')
  const [cliPath, setCliPath] = useState('')
  const [nodePath, setNodePath] = useState('')
  const local = state.local, installation = local.installation
  const busy = !!local.operation
  const perform = (command: Command) => { void run(command) }
  return <>
    <header className="modal-heading"><h2 id="dialog-title"><Monitor />本机 DSH</h2><button type="button" className="icon-button" aria-label="关闭本机管理" title="关闭本机管理" onClick={close}><X /></button></header>
    <p className="modal-description">安装官方 DSH，自动启动和登录。程序独立安装，默认使用官方配置目录与 web profile。</p>
    {state.preview && <p className="preview-label">浏览器预览仅演示流程，不会安装程序。</p>}
    <section className="runtime-status" aria-live="polite">
      <span className={`status-dot ${local.process === 'running' ? 'ready' : local.process === 'failed' ? 'offline' : local.operation ? 'loading' : 'idle'}`} />
      <div><strong>{localStatus(local)}</strong>{installation && <small>DSH {installation.version} · {installation.source === 'managed' ? '客户端安装的官方版本' : '使用已有官方安装'}</small>}</div>
    </section>
    {busy && <div className="runtime-progress"><progress aria-label="安装操作进度" max={100} {...(local.operation!.progress === null ? {} : { value: local.operation!.progress })} /><div><span>{local.operation!.progress === null ? '处理中…' : `${local.operation!.progress}%`}</span>{local.operation!.cancellable && <button className="plain-button" onClick={() => perform({ type: 'local.cancel' })}>取消操作</button>}</div></div>}
    {(local.error || error) && <p className="runtime-error" role="alert">{error || local.error}</p>}
    <DshDataSettings local={local} run={run} />
    {installation && <div className="runtime-controls">
      <button className="primary" disabled={busy || local.process === 'running' || local.home.migrationPending} onClick={() => perform({ type: 'local.start' })}><Play />启动</button>
      <button className="secondary" disabled={busy || local.process !== 'running'} onClick={() => perform({ type: 'local.stop' })}><Square />停止</button>
      <button className="secondary" disabled={busy || local.home.migrationPending} onClick={() => perform({ type: 'local.restart' })}><RefreshCw />重启</button>
    </div>}
    <section className="runtime-install">
      <div className="runtime-section-title"><h3>{installation ? '更新官方 DSH' : '一键安装'}</h3><button className="plain-button" disabled={busy} onClick={() => perform({ type: 'local.check-update' })}>检查版本</button></div>
      <p className="field-help">自动检测 Node.js；缺少合适版本时下载官方运行环境。无需 sudo。</p>
      {local.latestVersion && <p className="field-help">最近查询的官方版本：<button className="version-choice" onClick={() => setVersion(local.latestVersion!)}>{local.latestVersion}</button></p>}
      <form onSubmit={event => { event.preventDefault(); perform({ type: 'local.install', version: version.trim() }) }}>
        <label className="field">安装版本<input aria-label="DSH 安装版本" value={version} onChange={event => setVersion(event.target.value)} placeholder="latest 或版本号，例如 0.2.2-rc.1" maxLength={100} disabled={busy} required /></label>
        <button className="primary install-action" type="submit" disabled={busy || !version.trim() || local.home.migrationPending}>{busy && local.operation?.kind === 'install' ? <LoaderCircle className="spin" /> : <Download />}{installation ? '安装所选版本并启动' : '安装官方 DSH 并启动'}</button>
      </form>
      {installation && <p className="field-help">下载与验证完成后会重启本机 DSH，进行中的任务将被中断。旧运行环境保留；不自动降级已迁移的数据。</p>}
    </section>
    <details className="runtime-details"><summary>使用本机已有的 DSH</summary><p className="field-help">复用官方 CLI，使用上方所选的数据目录，并准备插件管理所需的 pnpm。</p><button className="secondary detect-action" disabled={busy} onClick={() => perform({ type: 'local.detect' })}><Search />检测已有安装</button>
      {local.candidates.map(candidate => <div className="runtime-candidate" key={candidate.cliPath}><div><strong>DSH {candidate.version}</strong><small>Node.js {candidate.nodeVersion}</small><code>{candidate.cliPath}</code></div><button className="secondary" disabled={busy} onClick={() => perform({ type: 'local.use-existing', cliPath: candidate.cliPath, nodePath: candidate.nodePath })}>使用</button></div>)}
      <form onSubmit={event => { event.preventDefault(); perform({ type: 'local.use-existing', cliPath: cliPath.trim(), nodePath: nodePath.trim() }) }}><label className="field">DSH CLI 路径<input aria-label="已有 DSH CLI 路径" value={cliPath} onChange={event => setCliPath(event.target.value)} placeholder="dsh 可执行文件或官方包内 lib/bin.js" disabled={busy} required /></label><label className="field">Node.js 路径<input aria-label="已有 Node.js 路径" value={nodePath} onChange={event => setNodePath(event.target.value)} placeholder="Node.js 可执行文件的绝对路径" disabled={busy} required /></label><button className="secondary detect-action" type="submit" disabled={busy || !cliPath.trim() || !nodePath.trim()}>验证并使用</button></form>
    </details>
    <details className="runtime-details"><summary>路径与诊断日志</summary><div className="runtime-paths"><span>DSH 数据目录</span><code>{local.dataDirectory}</code><span>运行环境目录</span><code>{local.runtimeDirectory}</code>{installation && <><span>Node.js</span><code>{installation.nodePath}</code><span>DSH CLI</span><code>{installation.cliPath}</code></>}</div><button className="secondary" onClick={() => perform({ type: 'local.open-data-directory' })}><FolderOpen />打开数据目录</button><div className="log-heading"><Terminal />运行日志（已脱敏）</div><pre className="runtime-log">{local.logs.join('\n') || '还没有运行日志'}</pre></details>
  </>
}
