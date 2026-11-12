import { useEffect, useState } from 'react'
import { Copy, FolderOpen } from 'lucide-react'
import type { Command, DshHomeSelection, LocalRuntimeState } from '../../shared/types'

export function DshDataSettings({ local, run }: { local: LocalRuntimeState; run: (command: Command) => Promise<boolean> }) {
  const selected = local.home.selection
  const [mode, setMode] = useState(selected.mode)
  const [directory, setDirectory] = useState(selected.mode === 'custom' ? selected.directory : '')
  useEffect(() => {
    setMode(selected.mode)
    setDirectory(selected.mode === 'custom' ? selected.directory : '')
  }, [selected.mode, selected.mode === 'custom' ? selected.directory : ''])
  const busy = !!local.operation
  const configure = (selection: DshHomeSelection) => { void run({ type: 'local.configure-home', selection }) }
  return <section className="data-settings">
    {local.home.migrationPending && <div className="migration-notice">
      <h3>选择升级后的 DSH 数据环境</h3>
      <p>旧版本使用独立目录和 switcher profile。标准 web profile 可以与 CC Switch 共享配置。</p>
      <p>官方目录：<code>{local.home.officialDirectory}</code></p>
      <p>{local.home.targetHasData ? '官方目录已有数据，可直接使用；旧环境会保留，不自动覆盖或合并。' : '目标目录为空，可以备份并迁移旧数据，再切换到 web profile。'}</p>
      {!local.installation && <p>迁移需要官方 CLI 验证。可先选择继续旧环境完成安装，再进行迁移。</p>}
      <div className="runtime-controls">
        <button className="primary" disabled={busy || local.home.targetHasData || !local.home.legacyHasData || !local.installation} onClick={() => void run({ type: 'local.migrate-home' })}>备份迁移并启动</button>
        <button className="secondary" disabled={busy} onClick={() => configure({ mode: 'official' })}>使用官方目录</button>
        <button className="plain-button" disabled={busy} onClick={() => configure({ mode: 'legacy' })}>继续旧环境</button>
      </div>
    </div>}
    <details className="runtime-details" open={local.home.migrationPending || undefined}>
      <summary>数据目录与 CC Switch 兼容</summary>
      <p className="field-help">当前 profile：<strong>{local.home.profile}</strong>。CC Switch 需要指向相同的数据目录，并管理 web profile。</p>
      <code className="data-path">{local.dataDirectory}</code>
      <div className="runtime-controls"><button className="secondary" onClick={() => void run({ type: 'local.copy-data-directory' })}><Copy />复制路径</button><button className="secondary" onClick={() => void run({ type: 'local.open-data-directory' })}><FolderOpen />打开目录</button></div>
      <form onSubmit={event => {
        event.preventDefault()
        configure(mode === 'custom' ? { mode, directory: directory.trim() } : { mode })
      }}>
        <label className="field">数据环境<select aria-label="DSH 数据环境" value={mode} onChange={event => setMode(event.target.value as DshHomeSelection['mode'])} disabled={busy}>
          <option value="official">官方默认：DSH_HOME 或 ~/.dsh（web）</option>
          <option value="custom">自定义数据目录（web）</option>
          {(local.home.legacyHasData || selected.mode === 'legacy') && <option value="legacy">旧独立环境（switcher）</option>}
        </select></label>
        {mode === 'custom' && <label className="field">目录的绝对路径<input aria-label="DSH 数据目录" value={directory} onChange={event => setDirectory(event.target.value)} required disabled={busy} placeholder="例如 /home/you/.dsh" /></label>}
        <p className="field-help">应用后会停止本机 DSH 并使用所选目录重新启动。选择已有目录不会合并或删除其他环境的数据。</p>
        <button className="secondary detect-action" type="submit" disabled={busy || mode === 'custom' && !directory.trim()}>应用数据环境</button>
      </form>
      {local.home.legacyHasData && !local.home.migrationPending && <button className="plain-button detect-action" disabled={busy || local.home.targetHasData || !local.installation} onClick={() => void run({ type: 'local.migrate-home' })}>备份旧环境并迁移到官方目录</button>}
      {local.home.backupDirectory && <p className="field-help">迁移备份：<code className="data-path">{local.home.backupDirectory}</code></p>}
    </details>
  </section>
}
