import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MonitorStatus, Server, TaskNotice } from '../shared/types'

type NewNotice = Omit<TaskNotice, 'id' | 'read' | 'createdAt'>
export interface MonitorTransport {
  request: (url: string, body: string, signal: AbortSignal) => Promise<{ status: number; value: unknown }>
  socket: (url: string) => Promise<WebSocket>
}
const summarySchema = z.object({ sessionId: z.string().min(1).max(256), agentAvailable: z.boolean(), running: z.boolean(), origin: z.string().optional(), projections: z.object({ asOfSeq: z.number(), values: z.record(z.string(), z.unknown()) }).optional() })
const eventSchema = z.object({ type: z.string(), seq: z.number().int().nonnegative(), data: z.record(z.string(), z.unknown()) })
export function noticeForEvent(event: unknown): { kind: TaskNotice['kind']; text: string; seq: number } | null {
  const parsed = eventSchema.safeParse(event)
  if (!parsed.success || parsed.data.type !== 'turn/end') return null
  const reason = parsed.data.data.reason as { kind?: unknown } | undefined
  if (reason?.kind === 'completed') return { kind: 'completed', text: '本轮任务已完成', seq: parsed.data.seq }
  if (reason?.kind === 'error' || reason?.kind === 'failed' || reason?.kind === 'blocked') return { kind: 'failed', text: '本轮任务失败或被阻止，请打开会话查看详情', seq: parsed.data.seq }
  return null
}
function titleOf(values: Record<string, unknown> | undefined, id: string): string {
  const title = values?.title
  return ((typeof title === 'string' ? title : title && typeof title === 'object' && 'title' in title && typeof title.title === 'string' ? title.title : '').trim() || `会话 ${id.slice(0, 8)}`).slice(0, 160)
}
interface WatchedSession { title: string; cursor: number; pending: string; stream: string }

/** Read-only Remote streams; never joins the answering $events stream or activates Agents. */
export class TaskMonitor {
  private controller = new AbortController()
  private ws: WebSocket | null = null
  private timer?: ReturnType<typeof setTimeout>
  private sessions = new Map<string, WatchedSession>()
  private discovering = new Set<string>()
  private ignored = new Set<string>()
  private connected = false
  private refreshing = false
  private reconnecting = false
  private heartbeatAt = 0
  private baseline = false
  private retries = 0
  private revision = 0
  private state: MonitorStatus
  constructor(readonly server: Server, private transport: MonitorTransport, private callbacks: { status: (state: MonitorStatus) => void; notice: (notice: NewNotice) => void }) {
    this.state = { serverId: server.id, status: 'connecting', detail: '正在连接 DSH 任务接口' }
  }
  private status(status: MonitorStatus['status'], detail: string): void { this.state = { ...this.state, status, detail }; if (!this.controller.signal.aborted) this.callbacks.status(this.state) }
  private async rpc(endpoint: string, args: unknown): Promise<unknown> {
    const rpcId = randomUUID()
    const reply = await this.transport.request(new URL(`api/${endpoint}`, this.server.url).href, JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]))
    if (reply.status === 401 || reply.status === 403) throw new Error('auth-required')
    if (reply.status === 404) throw new Error('unsupported')
    if (reply.status !== 200) throw new Error('offline')
    const envelope = z.object({ type: z.literal('server-response'), rpcId: z.literal(rpcId), result: z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.object({ code: z.string() }).optional() }) }).safeParse(reply.value)
    if (!envelope.success) throw new Error('unsupported')
    if (!envelope.data.result.ok) throw new Error(envelope.data.result.error?.code === 'remote-access/denied' ? 'auth-required' : 'unsupported')
    return envelope.data.result.value
  }
  start(): void { void this.connect() }
  private async connect(): Promise<void> {
    if (this.controller.signal.aborted || this.reconnecting) return
    this.reconnecting = true
    const revision = ++this.revision
    this.status('connecting', '正在连接 DSH 任务接口')
    try {
      const rows = z.object({ items: z.array(summarySchema) }).parse(await this.rpc('session/list', { _request: {} })).items
      if (this.controller.signal.aborted || revision !== this.revision) return
      const ws = await this.transport.socket(new URL('api/remote.mux', this.server.url).href.replace(/^http/, 'ws'))
      if (this.controller.signal.aborted || revision !== this.revision) { ws.terminate(); return }
      this.ws = ws; this.baseline = false; this.heartbeatAt = Date.now()
      const fail = () => { if (this.ws === ws) this.disconnect('offline') }
      ws.on('error', fail); ws.on('close', fail)
      ws.on('ping', () => { this.heartbeatAt = Date.now() })
      ws.on('message', data => {
        if (this.ws !== ws || this.controller.signal.aborted) return
        this.heartbeatAt = Date.now()
        try { this.onMessage(JSON.parse(data.toString())) } catch { this.disconnect('unsupported') }
      })
      const open = () => {
        if (this.ws !== ws) return
        ws.send(JSON.stringify({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} } }))
        for (const row of rows.filter(row => row.origin !== 'subagent' && row.agentAvailable).slice(0, 100)) this.watch(row.sessionId, titleOf(row.projections?.values, row.sessionId), row.projections?.asOfSeq ?? 0)
      }
      if (ws.readyState === WebSocket.OPEN) open(); else ws.once('open', open)
      this.schedule()
    } catch (error) { if (revision === this.revision) this.disconnect(error instanceof z.ZodError ? 'unsupported' : error instanceof Error ? error.message : 'offline') }
    finally { this.reconnecting = false }
  }
  private watch(id: string, title: string, cursor: number): void {
    if (!id || id.length > 256 || this.sessions.size >= 100 && !this.sessions.has(id)) return
    const previous = this.sessions.get(id)
    if (previous && previous.stream) { previous.title = title; return }
    const record = previous ?? { title, cursor, pending: '', stream: '' }
    record.title = title; record.stream = randomUUID()
    this.sessions.set(id, record)
    this.ws?.send(JSON.stringify({ type: 'open', streamId: record.stream, endpoint: 'session/observeEvent', payload: { args: { request: { address: { kind: 'session', sessionId: id } } } } }))
    // A read after subscription repairs events committed during discovery/reconnect.
    void this.reconcile(id, record, record.cursor)
  }
  private async reconcile(id: string, record: WatchedSession, floor: number): Promise<void> {
    try {
      const page = await this.rpc('session/events', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 20 } })
      const parsed = z.object({ records: z.array(z.object({ type: z.literal('event'), event: eventSchema.passthrough() })) }).parse(page)
      for (const entry of parsed.records) if (entry.event.seq > floor) this.accept(id, record, entry.event, floor)
    } catch { /* A later stream or poll retries; old/migration-required Sessions remain passive. */ }
  }
  private async discover(id: string, cursor: number): Promise<void> {
    if (this.discovering.has(id) || this.ignored.has(id)) return
    const socket = this.ws
    this.discovering.add(id)
    try {
      const rows = z.object({ items: z.array(summarySchema) }).parse(await this.rpc('session/list', { _request: {} })).items
      if (socket !== this.ws || this.controller.signal.aborted) return
      const row = rows.find(row => row.sessionId === id)
      if (row?.origin === 'subagent') { this.ignored.add(id); if (this.ignored.size > 1000) this.ignored.delete(this.ignored.values().next().value!); return }
      if (row?.agentAvailable) this.watch(id, titleOf(row.projections?.values, id), cursor)
    } catch { /* The regular list refresh discovers sessions after transient failures. */ }
    finally { this.discovering.delete(id) }
  }
  private accept(id: string, record: WatchedSession, value: unknown, floor = record.cursor): void {
    const event = eventSchema.passthrough().parse(value)
    const newer = event.seq > floor
    record.cursor = Math.max(record.cursor, event.seq)
    if (!newer) return
    const notice = noticeForEvent(event)
    if (notice) this.emit(id, record, `event:${event.seq}`, notice.kind, notice.text)
  }
  private emit(id: string, record: WatchedSession, key: string, kind: TaskNotice['kind'], text: string): void {
    if (this.controller.signal.aborted) return
    this.callbacks.notice({ serverId: this.server.id, serverName: this.server.name, sessionId: id, sessionTitle: record.title, kind, text, eventKey: `${this.server.id}:${id}:${key}` })
  }
  private onMessage(value: unknown): void {
    const frame = z.object({ type: z.enum(['item', 'error', 'end']), streamId: z.string(), value: z.unknown().optional(), error: z.object({ code: z.string() }).optional() }).parse(value)
    if (frame.type !== 'item') {
      if (frame.streamId === 'control' || frame.type === 'error' && frame.error?.code.startsWith('gateway/')) this.disconnect(frame.type === 'error' ? 'unsupported' : 'offline')
      else for (const [id, record] of this.sessions) if (record.stream === frame.streamId) this.sessions.delete(id)
      return
    }
    if (frame.streamId === 'control') {
      const control = z.object({ type: z.enum(['baseline', 'projection']), sessionId: z.string().optional(), seq: z.number().optional(), changes: z.array(z.object({ key: z.string(), val: z.unknown() })).optional() }).parse(frame.value)
      if (control.type === 'baseline') {
        this.baseline = true; this.connected = true; this.retries = 0
        this.status('connected', '任务事件已连接；每 10 秒检查新会话和等待输入状态')
      } else if (control.sessionId) {
        if (!this.sessions.has(control.sessionId)) void this.discover(control.sessionId, Math.max(0, (control.seq ?? 1) - 1))
        const record = this.sessions.get(control.sessionId), title = control.changes?.find(change => change.key === 'title')
        if (record && title) record.title = titleOf({ title: title.val }, control.sessionId)
      }
      return
    }
    const match = [...this.sessions].find(([, record]) => record.stream === frame.streamId)
    if (!match) return
    const message = z.object({ type: z.enum(['ready', 'event']), event: z.unknown().optional() }).parse(frame.value)
    if (message.type === 'event') this.accept(match[0], match[1], message.event)
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (this.controller.signal.aborted) return
    this.timer = setTimeout(() => { void this.refresh() }, 10000)
    this.timer.unref()
  }
  private async refresh(): Promise<void> {
    if (this.controller.signal.aborted || this.refreshing) return
    if (!this.baseline || Date.now() - this.heartbeatAt > 45000) { this.disconnect('offline'); return }
    this.refreshing = true
    const socket = this.ws
    try {
      const rows = z.object({ items: z.array(summarySchema) }).parse(await this.rpc('session/list', { _request: {} })).items
      if (socket !== this.ws || this.controller.signal.aborted) return
      const live = rows.filter(row => row.agentAvailable && row.origin !== 'subagent').slice(0, 100)
      const ids = new Set(live.map(row => row.sessionId))
      for (const [id, record] of this.sessions) if (!ids.has(id)) {
        if (record.stream && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', streamId: record.stream }))
        this.sessions.delete(id)
      }
      for (const row of live) {
        this.watch(row.sessionId, titleOf(row.projections?.values, row.sessionId), row.projections?.asOfSeq ?? 0)
        const record = this.sessions.get(row.sessionId)
        if (!record) continue
        const state = z.object({ cursor: z.number(), pendingInput: z.array(z.enum(['approval', 'question', 'other'])) }).parse(await this.rpc('session/state', { request: { sessionId: row.sessionId } }))
        if (socket !== this.ws || this.controller.signal.aborted) return
        const pending = state.pendingInput.join(',')
        if (pending && pending !== record.pending) this.emit(row.sessionId, record, `pending:${state.cursor}:${pending}`, 'input-required', pending.includes('approval') ? '任务正在等待审批' : '任务正在等待你的回答')
        record.pending = pending
      }
    } catch (error) { if (socket === this.ws) this.disconnect(error instanceof z.ZodError ? 'unsupported' : error instanceof Error ? error.message : 'offline') }
    finally { this.refreshing = false; if (this.connected && socket === this.ws) this.schedule() }
  }
  private disconnect(reason: string): void {
    this.revision++
    this.connected = false
    clearTimeout(this.timer)
    const ws = this.ws; this.ws = null; ws?.terminate()
    for (const record of this.sessions.values()) record.stream = ''
    if (this.controller.signal.aborted) return
    const status = reason === 'auth-required' ? 'auth-required' : reason === 'unsupported' ? 'unsupported' : 'offline'
    this.status(status, status === 'auth-required' ? '需要重新登录此服务器后重试通知连接' : status === 'unsupported' ? '此 DSH 版本暂不支持所需任务接口' : '任务连接中断，正在等待重连')
    if (status === 'offline') {
      this.timer = setTimeout(() => { void this.connect() }, Math.min(60000, 2000 * 2 ** Math.min(this.retries++, 5)))
      this.timer.unref()
    }
  }
  dispose(): void { this.controller.abort(); clearTimeout(this.timer); const ws = this.ws; this.ws = null; ws?.terminate(); this.sessions.clear() }
}
