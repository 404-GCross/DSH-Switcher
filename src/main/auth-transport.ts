import { net } from 'electron'
import type { Session } from 'electron'

/** Read response headers without following redirects; Chromium owns cookie storage in this session. */
export function readAuthenticationHeaders(session: Session, url: string, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      session, url, method: 'GET', credentials: 'include', redirect: 'manual',
      cache: 'no-store', referrerPolicy: 'no-referrer',
    })
    let settled = false
    const signal = options.signal
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
    const abort = () => { fail(new Error('Authentication request cancelled')); request.abort() }
    const accept = (status: number, input: Record<string, string | string[]>) => {
      if (settled) return
      const headers = new Headers()
      for (const [name, values] of Object.entries(input)) {
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value)
      }
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve(new Response(null, { status, headers }))
      request.abort()
    }
    request.on('error', fail)
    request.on('login', (_info, callback) => callback())
    // Electron fetch rejects manual redirects; ClientRequest exposes their headers before cancellation.
    request.on('redirect', (status, _method, _url, headers) => accept(status, headers))
    request.on('response', response => accept(response.statusCode, response.headers))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    try { request.end() } catch (error) { fail(error instanceof Error ? error : new Error('Authentication request failed')) }
  })
}
