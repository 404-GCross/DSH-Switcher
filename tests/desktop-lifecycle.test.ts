import test from 'node:test'
import assert from 'node:assert/strict'
import type { MenuItemConstructorOptions, WebContentsView } from 'electron'
import type { AppState, CloseBehavior, Command, TrayState } from '../src/shared/types'
import { LOCAL_SERVER_ID } from '../src/shared/types'
import { WindowLifecycle } from '../src/main/window-lifecycle'
import { probeTraySupport } from '../src/main/tray-availability'
import { trayMenuTemplate } from '../src/main/tray-menu'
import { ViewManager, type RuntimeView } from '../src/main/view-manager'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function lifecycle(behavior: CloseBehavior = 'tray', available = true) {
  const calls: string[] = []
  const operations = {
    behavior: () => behavior, tray: async (): Promise<TrayState> => ({ status: available ? 'available' : 'unavailable', detail: 'fallback' }),
    hide: () => { calls.push('hide') }, minimize: () => { calls.push('minimize') }, show: () => { calls.push('show') }, notice: () => { calls.push('notice') },
    cleanup: async () => { calls.push('cleanup') }, exit: () => { calls.push('exit') },
  }
  return { calls, operations, controller: new WindowLifecycle(operations) }
}

test('closing hides with a tray and minimizes without one; neither stops owned tasks', async () => {
  for (const available of [true, false]) {
    const { calls, controller } = lifecycle('tray', available)
    await controller.closeWindow()
    assert.deepEqual(calls, available ? ['hide'] : ['notice', 'minimize'])
    controller.show()
    assert.equal(calls.at(-1), 'show')
  }
  const minimized = lifecycle('minimize')
  await minimized.controller.closeWindow()
  assert.deepEqual(minimized.calls, ['minimize'])
})

test('simultaneous close/quit paths share one cleanup, then exit', async () => {
  const { calls, operations, controller } = lifecycle('quit')
  const gate = deferred<void>()
  operations.cleanup = async () => { calls.push('cleanup'); await gate.promise }
  const close = controller.closeWindow(), quit = controller.requestQuit()
  assert.equal(controller.requestQuit(), quit)
  await Promise.resolve()
  assert.deepEqual(calls, ['cleanup'])
  gate.resolve()
  await Promise.all([close, quit])
  assert.deepEqual(calls, ['cleanup', 'exit'])
})

test('a pending tray probe cannot hide a window restored later or a quitting window', async () => {
  for (const action of ['show', 'quit']) {
    const { calls, operations, controller } = lifecycle()
    const gate = deferred<TrayState>()
    operations.tray = () => gate.promise
    const close = controller.closeWindow()
    if (action === 'show') controller.show()
    else await controller.requestQuit()
    gate.resolve({ status: 'available', detail: '' })
    await close
    assert.equal(calls.includes('hide'), false)
  }
})

test('failed cleanup restores a recoverable window and allows explicit retry', async () => {
  const { calls, operations, controller } = lifecycle()
  operations.cleanup = () => { throw new Error('cannot stop') }
  await assert.rejects(controller.requestQuit(), /cannot stop/)
  assert.equal(controller.isQuitting, false)
  assert.deepEqual(calls, ['show'])
  operations.cleanup = async () => { calls.push('cleanup') }
  await controller.requestQuit()
  assert.deepEqual(calls, ['show', 'cleanup', 'exit'])
})

test('Linux tray detection requires an actual registered panel host, supports gdbus and degrades on probe failure', async () => {
  assert.equal((await probeTraySupport('linux', async () => 'b true')).status, 'available')
  assert.equal((await probeTraySupport('linux', async (binary, args) => {
    if (binary === 'busctl') throw new Error('missing')
    return args.includes('org.freedesktop.DBus.Properties.Get') ? '(<true>,)' : '(true,)'
  })).status, 'available')
  assert.equal((await probeTraySupport('linux', async (_, args) => args.includes('NameHasOwner') ? 'b true' : 'b false')).status, 'unavailable')
  assert.equal((await probeTraySupport('linux', async () => { throw new Error('no session bus') })).status, 'unavailable')
  for (const platform of ['win32', 'darwin'] as const) assert.equal((await probeTraySupport(platform, async () => { throw new Error('must not probe DBus') })).status, 'available')
})

test('single-view ownership drops before destruction, so stale page completions cannot take over', () => {
  const events: string[] = []
  const manager = new ViewManager(() => { events.push('detach') })
  const runtime = (id: string): RuntimeView => ({ server: { id, name: id, url: `https://${id}.example/` }, status: 'loading', responseCode: 0,
    view: { webContents: { close: (options: unknown) => { assert.equal(manager.get(id), undefined); assert.deepEqual(options, { waitForBeforeUnload: false }); events.push(`close:${id}`) } } } as WebContentsView,
  })
  const a = runtime('a'), b = runtime('b')
  manager.set(a)
  manager.select('a')
  assert.deepEqual(events, [])
  manager.select('b')
  manager.set(b)
  assert.equal(manager.owns(a), false)
  manager.close('a')
  assert.equal(manager.owns(b), true)
  manager.close()
  assert.deepEqual(events, ['detach', 'close:a', 'detach', 'close:b'])
})

test('tray menu reflects selection, busy/migration gates, and routes settings and exit', () => {
  const commands: Command[] = [], clicks: string[] = []
  const actions = { show: () => { clicks.push('show') }, quit: () => { clicks.push('quit') }, run: (command: Command) => { commands.push(command) } }
  const state = { activeId: 'remote', servers: [{ id: 'remote', name: 'A & B' }], local: { installation: {}, operation: null, process: 'running', home: { migrationPending: false } } } as AppState
  const menu = trayMenuTemplate(state, actions)
  const sub = (id: string) => menu.find(item => item.id === id)!.submenu as MenuItemConstructorOptions[]
  assert.equal(sub('servers').find(item => item.id === 'remote')!.checked, true)
  assert.equal(sub('servers')[0].id, LOCAL_SERVER_ID)
  assert.equal(sub('local').find(item => item.id === 'start')!.enabled, false)
  assert.equal(sub('local').find(item => item.id === 'stop')!.enabled, true)
  for (const id of ['show', 'quit', 'settings', 'about']) (menu.find(item => item.id === id)!.click as () => void)()
  assert.deepEqual(clicks, ['show', 'quit'])
  assert.deepEqual(commands, [{ type: 'overlay', overlay: { kind: 'settings' } }, { type: 'overlay', overlay: { kind: 'about' } }])
  state.local.home.migrationPending = true
  const gated = trayMenuTemplate(state, actions).find(item => item.id === 'local')!.submenu as MenuItemConstructorOptions[]
  assert.equal(gated.find(item => item.id === 'restart')!.enabled, false)
  state.local.operation = { kind: 'install', stage: '', progress: null, cancellable: true }
  const busy = trayMenuTemplate(state, actions).find(item => item.id === 'local')!.submenu as MenuItemConstructorOptions[]
  assert.ok(busy.filter(item => ['start', 'stop', 'restart'].includes(item.id ?? '')).every(item => item.enabled === false))
})
