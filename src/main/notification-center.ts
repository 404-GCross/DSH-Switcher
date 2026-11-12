import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { NotificationState, Server, TaskNotice } from '../shared/types'
import type { SettingsStore } from './settings'
import { TaskMonitor, type MonitorTransport } from './task-monitor'

const noticeSchema = z.object({ id: z.uuid(), eventKey: z.string().max(1024), serverId: z.uuid(), serverName: z.string().max(80), sessionId: z.string().max(256), sessionTitle: z.string().max(160), kind: z.enum(['completed', 'failed', 'input-required']), text: z.string().max(500), createdAt: z.number(), read: z.boolean() })
export class NotificationCenter {
  private state: NotificationState
  private monitors = new Map<string, TaskMonitor>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private seen = new Set<string>()
  constructor(private store: SettingsStore, private directory: string, supported: boolean, private callbacks: {
    changed: () => void; transport: (server: Server) => MonitorTransport; notify: (notice: TaskNotice, silent: boolean) => void
  }) { this.state = { items: [], monitors: [], supported } }
  get snapshot(): NotificationState { return structuredClone(this.state) }
  async initialize(): Promise<void> {
    try { this.state.items = z.array(noticeSchema).max(200).parse(JSON.parse(await readFile(path.join(this.directory, 'notifications.json'), 'utf8'))); this.seen = new Set(this.state.items.map(item => item.eventKey)) } catch { /* Malformed history is not needed to operate the client. */ }
  }
  private publish(): void { if (!this.disposed) this.callbacks.changed() }
  private save(): void {
    const data = JSON.stringify(this.state.items)
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const filename = path.join(this.directory, 'notifications.json'), temporary = `${filename}.tmp`
      await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, filename)
    }).catch(() => { /* The current run retains its in-memory history. */ })
    this.publish()
  }
  sync(servers: Server[], retry = false): void {
    if (this.disposed) return
    const prefs = this.store.snapshot.notifications
    const desired = new Map(servers.filter(server => server.url && prefs.enabled && prefs.serverIds.includes(server.id)).map(server => [server.id, server]))
    for (const [id, monitor] of this.monitors) if (!desired.has(id) || desired.get(id)!.url !== monitor.server.url || retry) {
      monitor.dispose(); this.monitors.delete(id); this.state.monitors = this.state.monitors.filter(item => item.serverId !== id)
    }
    for (const [id, server] of desired) if (!this.monitors.has(id)) {
      const monitor = new TaskMonitor(server, this.callbacks.transport(server), {
        status: state => { this.state.monitors = [...this.state.monitors.filter(item => item.serverId !== id), state]; this.publish() },
        notice: notice => {
          if (this.seen.has(notice.eventKey)) return
          this.seen.add(notice.eventKey)
          if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
          const item: TaskNotice = { ...notice, id: randomUUID(), createdAt: Date.now(), read: false }
          this.state.items = [item, ...this.state.items].slice(0, 200)
          this.save()
          const settings = this.store.snapshot.notifications
          if (!settings.quiet && this.state.supported) { try { this.callbacks.notify(item, !settings.sound) } catch { /* A desktop notification failure cannot disconnect the task stream. */ } }
        },
      })
      this.monitors.set(id, monitor); monitor.start()
    }
    this.publish()
  }
  read(id?: string): void { this.state.items = this.state.items.map(item => !id || item.id === id ? { ...item, read: true } : item); this.save() }
  clear(): void { this.state.items = []; this.save() }
  find(id: string): TaskNotice | undefined { return this.state.items.find(item => item.id === id) }
  async dispose(): Promise<void> { this.disposed = true; for (const monitor of this.monitors.values()) monitor.dispose(); this.monitors.clear(); await this.queue }
}
