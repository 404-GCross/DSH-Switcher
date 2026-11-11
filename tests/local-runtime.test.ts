import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { platformTarget, nodeFiles, runtimeEnvironment } from '../src/main/local-runtime/platform'
import { parseReadyLine, redactLog, runProgram, OwnedProcess } from '../src/main/local-runtime/process'
import { acquireInstallLock, selectNodeRelease } from '../src/main/local-runtime/installer'

test('platform mapping chooses official archives and platform-specific npm entrypoints', () => {
  assert.equal(platformTarget('win32', 'x64').archive, 'zip')
  assert.equal(platformTarget('darwin', 'arm64').nodePlatform, 'darwin')
  assert.equal(platformTarget('linux', 'x64').archive, 'tar.gz')
  assert.throws(() => platformTarget('freebsd', 'x64'))
  assert.match(nodeFiles('/runtime', 'win32').node, /node\.exe$/)
  assert.match(nodeFiles('/runtime', 'linux').npm, /npm-cli\.js$/)
})

test('Node selection keeps the compatible tested LTS major and respects newer DSH requirements', () => {
  const versions = [{ version: 'v26.13.0', lts: 'Neon' }, { version: 'v24.22.2', lts: 'Krypton' }, { version: 'v24.9.0', lts: 'Krypton' }]
  assert.equal(selectNodeRelease(versions, '>=24.9.0')?.version, 'v24.22.2')
  assert.equal(selectNodeRelease(versions, '>=26.0.0')?.version, 'v26.13.0')
  assert.equal(selectNodeRelease(versions, '>=30.0.0'), undefined)
})

test('only an explicit DSH ready line can provide local authentication', () => {
  const ready = parseReadyLine('dsh web: http://127.0.0.1:45213/?token=secret-value')
  assert.equal(ready?.url, 'http://127.0.0.1:45213/')
  assert.equal(ready?.launchUrl, 'http://127.0.0.1:45213/?token=secret-value')
  assert.equal(parseReadyLine('log: http://127.0.0.1:45213/?token=other'), null)
  assert.throws(() => parseReadyLine('dsh web: https://remote.example/?token=secret'))
  assert.throws(() => parseReadyLine('dsh web: http://127.0.0.1:45213/?token=x&token=y'))
  assert.equal(redactLog('dsh web: http://127.0.0.1:45213/?token=secret-value').includes('secret-value'), false)
  assert.equal(redactLog('https://user:private@registry.example/pkg').includes('private'), false)
  assert.equal(redactLog('Authorization: Bearer private-value').includes('private-value'), false)
})

test('installation lock rejects a second installer without deleting its owner lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'switcher-lock-'))
  try {
    const unlock = await acquireInstallLock(path.join(dir, 'install.lock'))
    await assert.rejects(acquireInstallLock(path.join(dir, 'install.lock')), /正在运行/)
    await unlock()
    await (await acquireInstallLock(path.join(dir, 'install.lock')))()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('program runner handles space/non-ASCII paths and joins process cancellation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'switcher 空间-'))
  try {
    const file = path.join(dir, 'hello world.mjs')
    await writeFile(file, 'console.log("ready");setInterval(()=>{},1000)')
    const controller = new AbortController()
    await assert.rejects(runProgram(process.execPath, [file], {
      signal: controller.signal, env: runtimeEnvironment(process.execPath),
      onOutput: () => controller.abort(),
    }), /abort/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('closing the desktop lease terminates its supervised process', { timeout: 15000 }, async () => {
  let ready!: (pid: number) => void
  const started = new Promise<number>(resolve => { ready = resolve })
  const owner = new OwnedProcess(process.execPath, [path.resolve('src/main/local-runtime/supervisor.mjs'), process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], {
    lease: true, onOutput: text => { const pid = Number(text.trim()); if (Number.isInteger(pid) && pid > 0) ready(pid) },
  })
  try {
    const pid = await started
    owner.child.stdin!.end()
    await owner.closed
    assert.throws(() => process.kill(pid, 0))
  } finally { await owner.stop() }
})

test('a supervisor ending cleanly after a deadline does not make the timed-out operation succeed', { timeout: 15000 }, async () => {
  await assert.rejects(runProgram(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    supervisor: path.resolve('src/main/local-runtime/supervisor.mjs'), timeoutMs: 100,
  }), /执行超时/)
})
