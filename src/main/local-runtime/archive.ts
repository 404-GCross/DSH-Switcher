import { open, type ZipFile, type Entry } from 'yauzl'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Official Windows Node archives contain regular files and directories, not symlinks. */
export async function extractNodeZip(filename: string, directory: string, signal: AbortSignal): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => open(filename, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result!)))
  return new Promise<void>((resolve, reject) => {
    let total = 0
    let current: Promise<void> = Promise.resolve()
    let finishing = false
    const finish = (error?: Error) => {
      if (finishing) return
      finishing = true
      signal.removeEventListener('abort', abort)
      zip.close()
      void current.catch(() => undefined).then(() => error ? reject(error) : resolve())
    }
    const abort = () => finish(new Error('解压已取消'))
    signal.addEventListener('abort', abort, { once: true })
    zip.once('error', finish)
    zip.once('end', () => finish())
    zip.on('entry', (entry: Entry) => {
      current = (async () => {
        signal.throwIfAborted()
        const target = path.resolve(directory, entry.fileName)
        if (!target.startsWith(`${path.resolve(directory)}${path.sep}`) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Node.js 压缩包包含无效路径或链接')
        total += entry.uncompressedSize
        if (total > 1024 * 1024 * 1024) throw new Error('Node.js 解压大小超过限制')
        if (entry.fileName.endsWith('/')) await mkdir(target, { recursive: true })
        else {
          await mkdir(path.dirname(target), { recursive: true })
          const stream = await new Promise<import('node:stream').Readable>((ok, no) => zip.openReadStream(entry, (error, result) => error ? no(error) : ok(result!)))
          await pipeline(stream, createWriteStream(target, { flags: 'wx' }), { signal })
        }
      })()
      void current.then(() => {
        if (!finishing) {
          try { zip.readEntry() } catch { finish(new Error('解压失败')) }
        }
      }, error => finish(error instanceof Error ? error : new Error('解压失败')))
    })
    if (signal.aborted) abort()
    else zip.readEntry()
  })
}
