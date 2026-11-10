/** Parse a DSH application URL without retaining its launch credential in settings. */
export function parseServerUrl(input: string): { baseUrl: string; launchUrl: string } {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 地址') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 和 HTTPS 地址')
  if (url.username || url.password) throw new Error('地址中不能包含用户名或密码')
  if ([...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length > 1) {
    throw new Error('请使用 DSH 首页地址或带 token 的启动链接')
  }
  url.hash = ''
  url.pathname = url.pathname.replace(/\/index\.html$/, '/')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  const launchUrl = url.href
  url.search = ''
  return { baseUrl: url.href, launchUrl }
}

export function loginUrlFor(baseUrl: string, input: string): string {
  const parsed = parseServerUrl(input)
  if (parsed.baseUrl !== baseUrl) throw new Error('登录链接必须属于当前服务器的同一个 DSH 地址')
  if (!new URL(parsed.launchUrl).searchParams.get('token')) throw new Error('请输入 DSH 启动时提供的完整登录链接')
  return parsed.launchUrl
}

export function isWebUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

export function isWithinServer(base: string, destination: string): boolean {
  try {
    const a = new URL(base), b = new URL(destination)
    return a.origin === b.origin && b.pathname.startsWith(a.pathname)
  } catch { return false }
}
