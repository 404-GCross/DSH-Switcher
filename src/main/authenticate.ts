import { loginUrlFor } from './server-url'

type SessionFetch = (url: string, options: RequestInit) => Promise<Response>

/** Exchange a launch token in the native view's cookie jar, then verify access without the token. */
export async function authenticateSession(baseUrl: string, input: string, fetch: SessionFetch, parentSignal?: AbortSignal): Promise<void> {
  const launchUrl = loginUrlFor(baseUrl, input)
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parentSignal ? [parentSignal] : [])])

  async function request(url: string, stage: string) {
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', credentials: 'include', redirect: 'manual', cache: 'no-store', signal })
    } catch {
      // Network exceptions may embed the credential-bearing URL; expose only the stage.
      throw new Error(signal.aborted ? `${stage}超时，请检查网络后重试` : `${stage}连接失败，请检查客户端代理、网络和服务器证书`)
    }
    const result = { status: response.status, location: response.headers.get('location') }
    try { await response.body?.cancel() } catch { /* Only response headers are needed; an interrupted body is not consumed. */ }
    return result
  }

  const exchange = await request(launchUrl, '登录验证')
  if (exchange.status === 401) throw new Error('服务器拒绝了此 token（HTTP 401）。请使用当前运行的 DSH 实例最新的启动链接')
  if (exchange.status === 403) throw new Error('服务器拒绝登录请求（HTTP 403）。请检查 DSH 的 trusted-host 和转发配置')
  if (exchange.status === 303) {
    let target: URL
    try { target = new URL(exchange.location ?? '', launchUrl) } catch { throw new Error('服务器返回了无效的登录重定向地址') }
    if (target.href !== baseUrl) throw new Error('服务器登录后跳转的地址与保存地址不同，请检查反向代理的路径配置')
  } else if (exchange.status !== 200) {
    throw new Error(`服务器未完成 DSH 登录交换（HTTP ${exchange.status}）`)
  }

  const verification = await request(baseUrl, '登录 Cookie 验证')
  if (verification.status === 401) {
    throw new Error('登录交换后 Cookie 验证仍为 HTTP 401。请检查代理的 Cookie 处理和服务端是否切换了实例')
  }
  if (verification.status !== 200) throw new Error(`登录后的首页验证失败（HTTP ${verification.status}），请检查服务器和转发配置`)
}
