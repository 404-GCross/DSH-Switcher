import { mkdir, readFile, rename, writeFile, unlink, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Settings } from '../shared/types'
import { LOCAL_SERVER_ID } from '../shared/types'
import { parseServerUrl } from './server-url'

const fields = {
  servers: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(80),
    url: z.string().refine(value => {
      try { return parseServerUrl(value).baseUrl === value } catch { return false }
    }),
  }).strict()).max(100),
  defaultId: z.uuid().nullable(),
  theme: z.enum(['system', 'light', 'dark']),
}
const installation = z.object({
  source: z.enum(['managed', 'existing']), version: z.string().min(1),
  nodePath: z.string().refine(path.isAbsolute), cliPath: z.string().refine(path.isAbsolute),
  pnpmPath: z.string().refine(path.isAbsolute), root: z.string().refine(path.isAbsolute),
}).strict()
const schema = z.object({ ...fields, version: z.literal(2), local: z.object({ installation: installation.nullable() }).strict() }).strict().superRefine((value, context) => {
  const ids = new Set(value.servers.map(server => server.id))
  if (ids.size !== value.servers.length) context.addIssue({ code: 'custom', message: 'Duplicate server identity' })
  if (ids.has(LOCAL_SERVER_ID)) context.addIssue({ code: 'custom', message: 'Reserved local identity' })
  if (value.defaultId && value.defaultId !== LOCAL_SERVER_ID && !ids.has(value.defaultId)) context.addIssue({ code: 'custom', message: 'Unknown default server' })
})

export const emptySettings = (): Settings => ({ version: 2, servers: [], defaultId: null, theme: 'system', local: { installation: null } })

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
    let candidate: unknown = JSON.parse(data)
    const legacy = z.object({ ...fields, version: z.literal(1) }).strict().safeParse(candidate)
    if (legacy.success) candidate = { ...legacy.data, version: 2, local: { installation: null } }
    const parsed = schema.safeParse(candidate)
    if (!parsed.success) throw new Error('连接配置格式无效。原文件已保留，请检查 settings.json')
    this.value = parsed.data
    if (legacy.success) {
      try { await copyFile(this.filename, `${this.filename}.v1.bak`, constants.COPYFILE_EXCL) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      await this.update(settings => settings)
    }
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
