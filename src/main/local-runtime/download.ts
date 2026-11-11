import https from 'node:https'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { getProxyForUrl } from 'proxy-from-env'
import { setTimeout as delay } from 'node:timers/promises'

/** Public distribution downloads use the environment proxy or the desktop system proxy. */
export class RuntimeDownloads {
  private agents = new Set<HttpsProxyAgent<string> | SocksProxyAgent>()
  constructor(private systemProxy: (url: string) => Promise<string> = async () => 'DIRECT') {}
  async proxyFor(url: string): Promise<string> {
    if (Object.keys(process.env).some(key => /^(https?|all)_proxy$/i.test(key))) return getProxyForUrl(url)
    const first = (await this.systemProxy(url)).split(';')[0].trim()
    const match = /^(PROXY|HTTPS|SOCKS5?)\s+(.+)$/i.exec(first)
    if (!match) return ''
    return `${match[1].toUpperCase() === 'HTTPS' ? 'https' : match[1].startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}`
  }
  async childProxyEnvironment(): Promise<NodeJS.ProcessEnv> {
    const proxy = await this.proxyFor('https://registry.npmjs.org/')
    return proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy } : {}
  }
  private async response(url: string, signal: AbortSignal, redirects = 0): Promise<import('node:http').IncomingMessage> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || redirects > 5) throw new Error('下载地址或重定向无效')
    signal.throwIfAborted()
    const proxy = await this.proxyFor(url)
    signal.throwIfAborted()
    let response: import('node:http').IncomingMessage | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          const agent = proxy ? proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy) : undefined
          if (agent) this.agents.add(agent)
          const release = () => { if (agent) { this.agents.delete(agent); agent.destroy() } }
          const request = https.get(parsed, { agent, signal, headers: { 'user-agent': 'DSH-Switcher', accept: '*/*' } }, incoming => {
            incoming.once('close', release)
            resolve(incoming)
          })
          request.once('error', error => {
            release()
            const code = 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : ''
            reject(Object.assign(new Error(signal.aborted ? '下载已取消或超时' : `无法连接 ${parsed.hostname}${code ? `（${code}）` : ''}，请检查网络或系统代理`), { code }))
          })
        })
        break
      } catch (error) {
        if (signal.aborted || attempt === 2 || !(error instanceof Error && 'code' in error && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(error.code)))) throw error
        await delay(attempt ? 900 : 300, undefined, { signal })
      }
    }
    if (!response) throw new Error('下载请求未返回响应')
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.destroy()
      return this.response(new URL(response.headers.location, url).href, signal, redirects + 1)
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`${parsed.hostname} 返回 HTTP ${response.statusCode}`) }
    return response
  }
  async text(url: string, signal: AbortSignal, maxBytes = 5 * 1024 * 1024): Promise<string> {
    const response = await this.response(url, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
    let total = 0
    const parts: Buffer[] = []
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk); total += bytes.length
        if (total > maxBytes) throw new Error('远程元数据超过大小限制')
        parts.push(bytes)
      }
      return Buffer.concat(parts).toString('utf8')
    } finally { response.destroy() }
  }
  async json(url: string, signal: AbortSignal): Promise<unknown> {
    try { return JSON.parse(await this.text(url, signal)) } catch (error) {
      if (error instanceof SyntaxError) throw new Error('下载的版本信息不是有效 JSON')
      throw error
    }
  }
  async file(url: string, filename: string, expectedSha256: string, signal: AbortSignal, progress: (percent: number | null) => void): Promise<void> {
    const response = await this.response(url, AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]))
    const hash = createHash('sha256')
    const length = Number(response.headers['content-length'])
    let total = 0, previous = -1
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > 512 * 1024 * 1024) { callback(new Error('运行环境下载超过大小限制')); return }
      hash.update(chunk)
      const percent = length > 0 ? Math.min(100, Math.floor(total / length * 100)) : null
      if (percent !== previous) { progress(percent); previous = percent ?? -1 }
      callback(null, chunk)
    } })
    await pipeline(response, meter, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal })
    if (hash.digest('hex') !== expectedSha256.toLowerCase()) throw new Error('Node.js 下载校验失败，请重试')
  }
  dispose(): void { for (const agent of this.agents) agent.destroy(); this.agents.clear() }
}
