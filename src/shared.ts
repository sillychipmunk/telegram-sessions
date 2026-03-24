import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ============================================================================
// Paths
// ============================================================================

export const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-sessions')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const DAEMON_SOCK = join(STATE_DIR, 'daemon.sock')
export const DAEMON_PID = join(STATE_DIR, 'daemon.pid')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

// Root directory of the plugin (where .mcp.json lives)
export const PLUGIN_ROOT = join(new URL('..', import.meta.url).pathname)

// ============================================================================
// Protocol: MCP Server → Daemon
// ============================================================================

export type ServerToDaemon =
  | { type: 'register'; sessionId: string; name?: string; cwd?: string }
  | { type: 'reply'; chat_id: string; text: string; reply_to?: string; files?: string[]; format?: 'text' | 'markdownv2' }
  | { type: 'react'; chat_id: string; message_id: string; emoji: string }
  | { type: 'edit'; chat_id: string; message_id: string; text: string; format?: 'text' | 'markdownv2' }
  | { type: 'download_attachment'; file_id: string }
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }

// ============================================================================
// Protocol: Daemon → MCP Server
// ============================================================================

export type DaemonToServer =
  | {
      type: 'message'
      chat_id: string
      message_id?: string
      user: string
      user_id: string
      text: string
      ts: string
      image_path?: string
      attachment_kind?: string
      attachment_file_id?: string
      attachment_name?: string
      attachment_mime?: string
      attachment_size?: string
      transcribe_tool?: string
    }
  | { type: 'session_activated' }
  | { type: 'session_deactivated' }
  | { type: 'result'; ok: boolean; data?: string; error?: string }
  | { type: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }

// ============================================================================
// Session Registry (daemon-internal)
// ============================================================================

export type SessionInfo = {
  sessionId: string
  name: string
  cwd: string
}

// ============================================================================
// Helpers
// ============================================================================

export function loadEnv(): void {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]
    }
  } catch {}
}

/** Encode a protocol message as a newline-delimited JSON string. */
export function encode(msg: ServerToDaemon | DaemonToServer): string {
  return JSON.stringify(msg) + '\n'
}

/** Parse newline-delimited JSON buffer. Returns parsed messages and leftover. */
export function parseMessages<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    if (line) {
      try {
        messages.push(JSON.parse(line) as T)
      } catch {}
    }
  }
  return { messages, rest }
}
