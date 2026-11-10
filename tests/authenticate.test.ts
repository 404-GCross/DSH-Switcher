import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateSession } from '../src/main/authenticate'

const base = 'http://10.10.10.101:3080/'
const launch = `${base}?token=private-test-value`

test('authentication verifies cookie access without navigating or following token redirects', async () => {
  const requests: string[] = []
  await authenticateSession(base, launch, async (url, options) => {
    requests.push(url)
    assert.equal(options.credentials, 'include')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    return requests.length === 1
      ? new Response(null, { status: 303, headers: { location: './', 'set-cookie': 'private-cookie' } })
      : new Response('DSH', { status: 200 })
  })
  assert.deepEqual(requests, [launch, base])
})

test('token rejection is distinct from rejection of the issued cookie', async () => {
  await assert.rejects(authenticateSession(base, launch, async () => new Response(null, { status: 401 })), /拒绝了此 token.*401/)
  let count = 0
  await assert.rejects(authenticateSession(base, launch, async () => ++count === 1
    ? new Response(null, { status: 303, headers: { location: './', 'set-cookie': 'private-cookie' } })
    : new Response(null, { status: 401 })), /Cookie 验证仍为 HTTP 401/)
})

test('host denial and missing cookie are reported without including credentials', async () => {
  await assert.rejects(authenticateSession(base, launch, async () => new Response(null, { status: 403 })), /trusted-host/)
  let count = 0
  await assert.rejects(authenticateSession(base, launch, async () => ++count === 1
    ? new Response(null, { status: 303, headers: { location: './' } })
    : new Response(null, { status: 401 })), /Cookie 验证仍为 HTTP 401/)
  await assert.rejects(authenticateSession(base, launch, async () => { throw new Error(`Network error fetching ${launch}`) }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /连接失败/)
    assert.equal(error.message.includes('private-test-value'), false)
    return true
  })
})

test('an off-site login or unexpected redirect cannot forward the token', async () => {
  let count = 0
  await assert.rejects(authenticateSession(base, 'http://other.example/?token=test', async () => { count++; return new Response() }), /同一个 DSH 地址/)
  assert.equal(count, 0)
  await assert.rejects(authenticateSession(base, launch, async () => {
    count++
    return new Response(null, { status: 303, headers: { location: 'https://other.example/' } })
  }), /跳转的地址/)
  assert.equal(count, 1)
})
