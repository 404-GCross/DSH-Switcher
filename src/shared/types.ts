export type Theme = 'system' | 'light' | 'dark'
export type ConnectionStatus = 'idle' | 'loading' | 'ready' | 'auth-required' | 'forbidden' | 'offline'
export type Overlay = { kind: 'instances' | 'add' | 'about' } | { kind: 'edit' | 'login' | 'remove'; id: string } | null

export interface Server {
  id: string
  name: string
  url: string
}

export interface Connection extends Server {
  status: ConnectionStatus
  error?: string
}

export interface Settings {
  version: 1
  servers: Server[]
  defaultId: string | null
  theme: Theme
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
}

export type Command =
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
