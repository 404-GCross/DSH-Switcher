import test from 'node:test'
import assert from 'node:assert/strict'
import { parseServerUrl, loginUrlFor, isWithinServer, isWebUrl } from '../src/main/server-url'

test('launch credentials never appear in the stored base URL; mount paths survive', () => {
  const result = parseServerUrl('https://example.com/dsh/?token=private-value#view')
  assert.equal(result.baseUrl, 'https://example.com/dsh/')
  assert.equal(result.launchUrl, 'https://example.com/dsh/?token=private-value')
  assert.equal(parseServerUrl('http://localhost:3080/index.html').baseUrl, 'http://localhost:3080/')
  assert.equal(parseServerUrl('https://example.com/prefix').baseUrl, 'https://example.com/prefix/')
})

test('login cannot send a token to a different authority or mount', () => {
  const base = 'https://example.com/dsh/'
  for (const value of ['https://other.example/dsh/?token=a', 'http://example.com/dsh/?token=a', 'https://example.com/other/?token=a', base]) {
    assert.throws(() => loginUrlFor(base, value))
  }
  assert.equal(loginUrlFor(base, `${base}?token=a`), `${base}?token=a`)
})

test('unsupported protocols and ambiguous credentials are rejected', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://name:secret@example.com/', 'https://example.com/?token=a&token=b', 'https://example.com/?next=https://evil.example']) {
    assert.throws(() => parseServerUrl(value))
  }
  assert.equal(isWebUrl('file:///tmp/file'), false)
  assert.equal(isWebUrl('https://example.com/'), true)
})

test('native page navigation remains under its configured application mount', () => {
  assert.equal(isWithinServer('https://example.com/dsh/', 'https://example.com/dsh/session/1'), true)
  assert.equal(isWithinServer('https://example.com/dsh/', 'https://example.com/dsh-other/'), false)
  assert.equal(isWithinServer('https://example.com/dsh/', 'https://other.example/dsh/'), false)
  assert.equal(isWithinServer('https://example.com/dsh/', 'https://example.com/dsh/../elsewhere'), false)
})
