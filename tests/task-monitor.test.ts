import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { TaskMonitor, noticeForEvent } from '../src/main/task-monitor'

test('only a successful explicit turn end counts as completion; cancellation and running state do not', () => {
  assert.equal(noticeForEvent({ type: 'turn/end', seq: 7, data: { reason: { kind: 'completed' } } })?.kind, 'completed')
  assert.equal(noticeForEvent({ type: 'turn/end', seq: 8, data: { reason: { kind: 'error' } } })?.kind, 'failed')
  assert.equal(noticeForEvent({ type: 'turn/end', seq: 9, data: { reason: { kind: 'cancelled' } } }), null)
  assert.equal(noticeForEvent({ type: 'status', seq: 10, data: { running: false } }), null)
})
test('a background monitor uses passive streams, ignores its baseline and observes a later task result', { timeout: 10000 }, async () => {
  const http = createServer()
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const wsServer = new WebSocketServer({ server: http })
  const address = http.address() as { port: number }, url = `http://127.0.0.1:${address.port}/`
  const opened: string[] = [], notices: unknown[] = []
  let finish!: () => void
  const delivered = new Promise<void>(resolve => { finish = resolve })
  wsServer.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString())
    opened.push(request.endpoint)
    if (request.endpoint === 'session/control') socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'baseline', value: { projections: {} } } }))
    if (request.endpoint === 'session/observeEvent') {
      socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'ready' } }))
      for (const seq of [5, 8]) socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'event', event: { type: 'turn/end', seq, data: { reason: { kind: 'completed' } } } } }))
    }
  }))
  const monitor = new TaskMonitor({ id: 'server', name: 'Fixture', url }, {
    request: async (_url, body) => {
      const request = JSON.parse(body)
      const value = request.method === 'session/list' ? { items: [{ sessionId: 's', agentAvailable: true, running: true, projections: { asOfSeq: 6, values: { title: 'Fixture task' } } }] } : { records: [] }
      return { status: 200, value: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } }
    },
    socket: async url => new WebSocket(url),
  }, { status: () => {}, notice: item => { notices.push(item); finish() } })
  try {
    monitor.start(); await delivered
    assert.equal(notices.length, 1)
    assert.deepEqual(opened, ['session/control', 'session/observeEvent'])
    assert.equal((notices[0] as { eventKey: string }).eventKey, 'server:s:event:8')
  } finally {
    monitor.dispose(); for (const client of wsServer.clients) client.terminate()
    await new Promise<void>(resolve => wsServer.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  }
})

for (const [code, status] of [[401, 'auth-required'], [404, 'unsupported']] as const) {
  test(`HTTP ${code} is reported without starting a task socket or replaying old events`, async () => {
    let finish!: (status: string) => void
    const result = new Promise<string>(resolve => { finish = resolve })
    const monitor = new TaskMonitor({ id: 'server', name: 'Fixture', url: 'http://127.0.0.1/' }, {
      request: async () => ({ status: code, value: null }), socket: async () => { throw new Error('must not open') },
    }, { status: value => { if (value.status !== 'connecting') finish(value.status) }, notice: () => assert.fail('unexpected notice') })
    try { monitor.start(); assert.equal(await result, status) } finally { monitor.dispose() }
  })
}

test('waiting-for-approval is sampled without registering an answering client', { timeout: 18000 }, async () => {
  const http = createServer(); http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const wsServer = new WebSocketServer({ server: http })
  const address = http.address() as { port: number }
  let finish!: (kind: string) => void
  const result = new Promise<string>(resolve => { finish = resolve })
  const endpoints: string[] = []
  wsServer.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString()); endpoints.push(request.endpoint)
    socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: request.endpoint === 'session/control' ? { type: 'baseline', value: { projections: {} } } : { type: 'ready' } }))
  }))
  const monitor = new TaskMonitor({ id: 'server', name: 'Fixture', url: `http://127.0.0.1:${address.port}/` }, {
    request: async (_url, body) => {
      const request = JSON.parse(body)
      const value = request.method === 'session/list' ? { items: [{ sessionId: 's', agentAvailable: true, running: true }] } : request.method === 'session/state' ? { cursor: 8, pendingInput: ['approval'] } : { records: [] }
      return { status: 200, value: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } }
    }, socket: async url => new WebSocket(url),
  }, { status: () => {}, notice: item => finish(item.kind) })
  try { monitor.start(); assert.equal(await result, 'input-required'); assert.equal(endpoints.includes('$events'), false) }
  finally { monitor.dispose(); for (const client of wsServer.clients) client.terminate(); await new Promise<void>(resolve => wsServer.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())) }
})
