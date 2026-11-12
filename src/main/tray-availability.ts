import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TrayState } from '../shared/types'

const execute = promisify(execFile)
type Probe = (binary: string, args: string[]) => Promise<string>
const run: Probe = async (binary, args) => (await execute(binary, args, { timeout: 1500, windowsHide: true, maxBuffer: 8192 })).stdout

/** A desktop name alone does not establish that a panel is hosting StatusNotifier items. */
export async function probeTraySupport(platform = process.platform, probe: Probe = run): Promise<TrayState> {
  if (platform !== 'linux') return { status: 'available', detail: '使用系统原生托盘' }
  for (const name of ['org.kde.StatusNotifierWatcher', 'org.freedesktop.StatusNotifierWatcher']) {
    try {
      const value = await probe('busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', name])
      if (/\bb true\b/.test(value)) {
        const host = await probe('busctl', ['--user', 'get-property', name, '/StatusNotifierWatcher', name, 'IsStatusNotifierHostRegistered'])
        if (/\bb true\b/.test(host)) return { status: 'available', detail: '已连接 StatusNotifier / AppIndicator 托盘服务' }
      }
    } catch { /* Some desktop installations provide gdbus instead of busctl. */ }
    try {
      const value = await probe('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', name])
      if (/\(true,?\)/.test(value.trim())) {
        const host = await probe('gdbus', ['call', '--session', '--dest', name, '--object-path', '/StatusNotifierWatcher', '--method', 'org.freedesktop.DBus.Properties.Get', name, 'IsStatusNotifierHostRegistered'])
        if (/<true>/.test(host)) return { status: 'available', detail: '已连接 StatusNotifier / AppIndicator 托盘服务' }
      }
    } catch { /* An absent session bus or watcher leaves the window recoverable. */ }
  }
  return { status: 'unavailable', detail: '未发现可用托盘服务；关闭窗口将最小化。GNOME 可启用 AppIndicator，平铺桌面可配置 Waybar 托盘。' }
}
