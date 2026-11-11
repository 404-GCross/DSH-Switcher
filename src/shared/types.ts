export type Theme = 'system' | 'light' | 'dark'
export type ConnectionStatus = 'idle' | 'loading' | 'ready' | 'auth-required' | 'forbidden' | 'offline'
export type Overlay = { kind: 'instances' | 'add' | 'about' | 'local' } | { kind: 'edit' | 'login' | 'remove'; id: string } | null

export const LOCAL_SERVER_ID = '00000000-0000-4000-8000-000000000001'

export interface LocalInstallation {
  source: 'managed' | 'existing'
  version: string
  nodePath: string
  cliPath: string
  pnpmPath: string
  root: string
}

export interface LocalCandidate {
  cliPath: string
  nodePath: string
  version: string
  nodeVersion: string
}

export type LocalAction = 'detect' | 'install' | 'use-existing' | 'start' | 'stop' | 'restart' | 'check-update'

export interface LocalRuntimeState {
  installation: LocalInstallation | null
  process: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  operation: { kind: LocalAction; stage: string; progress: number | null; cancellable: boolean } | null
  candidates: LocalCandidate[]
  latestVersion: string | null
  error: string | null
  logs: string[]
  dataDirectory: string
  runtimeDirectory: string
}

export interface Server {
  id: string
  name: string
  url: string
}

export interface Connection extends Server {
  local?: boolean
  status: ConnectionStatus
  error?: string
}

export interface Settings {
  version: 2
  servers: Server[]
  defaultId: string | null
  theme: Theme
  local: { installation: LocalInstallation | null }
}

export interface AppState {
  servers: Connection[]
  activeId: string | null
  defaultId: string | null
  theme: Theme
  dark: boolean
  overlay: Overlay
  notice: string | null
  preview: boolean
  appVersion: string
  local: LocalRuntimeState
}

export type LocalCommand =
  | { type: 'local.detect' | 'local.cancel' | 'local.start' | 'local.stop' | 'local.restart' | 'local.check-update' | 'local.open-data-directory' }
  | { type: 'local.install'; version: string }
  | { type: 'local.use-existing'; cliPath: string; nodePath: string }

export type Command =
  | LocalCommand
  | { type: 'overlay'; overlay: Overlay }
  | { type: 'select'; id: string }
  | { type: 'save'; id?: string; name: string; url: string }
  | { type: 'default'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'login'; id: string; url: string }
  | { type: 'reload'; id: string }
  | { type: 'external'; id: string }
  | { type: 'theme'; theme: Theme }
  | { type: 'dismiss-notice' }

export type CommandResult = { ok: true } | { ok: false; error: string }

export interface DesktopBridge {
  state(): Promise<AppState>
  command(command: Command): Promise<CommandResult>
  subscribe(listener: (state: AppState) => void): () => void
}

declare global {
  interface Window { desktop?: DesktopBridge }
}
