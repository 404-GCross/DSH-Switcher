import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Settings } from '../shared/types'
import { parseServerUrl } from './server-url'

const schema = z.object({
  version: z.literal(1),
  servers: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(80),
    url: z.string().refine(value => {
      try { return parseServerUrl(value).baseUrl === value } catch { return false }
    }),
  }).strict()).max(100),
  defaultId: z.uuid().nullable(),
  theme: z.enum(['system', 'light', 'dark']),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.servers.map(server => server.id))
  if (ids.size !== value.servers.length) context.addIssue({ code: 'custom', message: 'Duplicate server identity' })
  if (value.defaultId && !ids.has(value.defaultId)) context.addIssue({ code: 'custom', message: 'Unknown default server' })
})

export const emptySettings = (): Settings => ({ version: 1, servers: [], defaultId: null, theme: 'system' })

/** Serialized, atomic settings writes; a failed write does not publish the proposed value. */
export class SettingsStore {
  private value: Settings = emptySettings()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly filename: string) {}

  async load(): Promise<void> {
    let data: string
    try { data = await readFile(this.filename, 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const parsed = schema.safeParse(JSON.parse(data))
    if (!parsed.success) throw new Error('连接配置格式无效。原文件已保留，请检查 settings.json')
    this.value = parsed.data
  }

  get snapshot(): Settings { return structuredClone(this.value) }

  update(change: (settings: Settings) => Settings): Promise<Settings> {
    const operation = this.queue.then(async () => {
      const next = schema.parse(change(this.snapshot))
      await mkdir(path.dirname(this.filename), { recursive: true })
      const temporary = `${this.filename}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, this.filename)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      this.value = next
      return this.snapshot
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
