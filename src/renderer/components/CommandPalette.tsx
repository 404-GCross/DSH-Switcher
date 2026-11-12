import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { AppState, Command } from '../../shared/types'
import { clientActions } from '../../shared/actions'

export function CommandPalette({ state, run, close, error }: { state: AppState; run: (command: Command) => Promise<boolean>; close: () => void; error: string }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0)
  const items = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return clientActions(state).filter(item => words.every(word => `${item.label} ${item.keywords} ${item.detail ?? ''}`.toLowerCase().includes(word)))
  }, [state, query])
  useEffect(() => { setSelected(0) }, [query])
  const index = Math.min(selected, Math.max(0, items.length - 1))
  useEffect(() => { document.getElementById(`palette-action-${index}`)?.scrollIntoView({ block: 'nearest' }) }, [index])
  return <>
    <header className="modal-heading"><h2 id="dialog-title">快捷操作</h2><button className="icon-button" aria-label="关闭快捷操作" onClick={close}><X /></button></header>
    <label className="palette-search"><Search /><input autoFocus aria-label="快捷操作搜索" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items.length ? `palette-action-${index}` : undefined} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索服务器、操作或设置…" onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index + 1) % Math.max(items.length, 1)) }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index - 1 + items.length) % Math.max(items.length, 1)) }
      if (event.key === 'Enter' && items[index]?.enabled) { event.preventDefault(); void run({ type: 'action', id: items[index].id }) }
    }} /></label>
    <div className="palette-list" id="palette-list" role="listbox" aria-label="可用操作">{items.map((item, i) => <button key={item.id} id={`palette-action-${i}`} role="option" aria-selected={i === index} aria-disabled={!item.enabled} className={`palette-item ${i === index ? 'selected' : ''}`} disabled={!item.enabled} onMouseEnter={() => setSelected(i)} onClick={() => void run({ type: 'action', id: item.id })}><span>{item.label}<small>{item.enabled ? item.detail : '当前不可用'}</small></span></button>)}</div>
    {!items.length && <p className="field-help">没有匹配的操作</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="field-help">↑↓ 选择 · Enter 执行 · Esc 关闭</p>
  </>
}
