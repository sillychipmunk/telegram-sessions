#!/usr/bin/env bun
/**
 * Telegram Sessions Daemon
 *
 * Single long-running process that:
 * 1. Holds the Telegram bot polling connection (grammy)
 * 2. Runs a unix socket server for MCP server connections
 * 3. Manages session registry and active-session-per-chat routing
 * 4. Handles Telegram slash commands: /new, /switch, /kill, /sessions
 * 5. Implements access control (gate, pairing, allowlists)
 * 6. Proxies outbound messages from sessions to Telegram
 */

import { Bot, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  statSync,
  renameSync,
  realpathSync,
  existsSync,
} from 'fs'
import { extname, join, sep } from 'path'
import { createServer, type Socket } from 'net'
import { homedir } from 'os'
import { spawn, execFileSync } from 'child_process'

import {
  STATE_DIR,
  ACCESS_FILE,
  APPROVED_DIR,
  DAEMON_SOCK,
  DAEMON_PID,
  INBOX_DIR,
  PLUGIN_ROOT,
  loadEnv,
  encode,
  parseMessages,
  type ServerToDaemon,
  type DaemonToServer,
  type SessionInfo,
} from './shared.js'

// ============================================================================
// Bootstrap
// ============================================================================

loadEnv()
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `telegram-sessions daemon: TELEGRAM_BOT_TOKEN required\n` +
      `  set in ${join(STATE_DIR, '.env')}\n` +
      `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Write PID file
writeFileSync(DAEMON_PID, String(process.pid), { mode: 0o600 })

const bot = new Bot(TOKEN)
let botUsername = ''

// ============================================================================
// Access Control Types
// ============================================================================

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  workspace?: string
  projects?: Record<string, string>
}

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// ============================================================================
// Access Control
// ============================================================================

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      workspace: parsed.workspace,
      projects: parsed.projects,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(
      `telegram-sessions daemon: access.json is corrupt, moved aside. Starting fresh.\n`,
    )
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'telegram-sessions daemon: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function getAllowedChatIds(): string[] {
  const access = loadAccess()
  return [...access.allowFrom, ...Object.keys(access.groups)]
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ============================================================================
// Approval Polling
// ============================================================================

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').then(
      () => rmSync(file, { force: true }),
      (err) => {
        process.stderr.write(`telegram-sessions daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}

if (!STATIC) setInterval(checkApprovals, 5000)

// ============================================================================
// Chunking
// ============================================================================

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ============================================================================
// Markdown Escaping
// ============================================================================

/**
 * Escape text for Telegram MarkdownV2.
 * Characters inside code spans / code blocks are handled separately:
 * only ` and \ need escaping there. Everything outside code needs the
 * full MarkdownV2 special-char set escaped.
 */
function escapeMarkdownV2(text: string): string {
  // Split by code blocks (``` … ```) and inline code (` … `)
  // Process each segment: code segments get minimal escaping, rest gets full escaping.
  const parts: string[] = []
  let rest = text

  // Regex: match ```…``` or `…` (non-greedy)
  const codeRe = /(```[\s\S]*?```|`[^`]*`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeRe.exec(rest)) !== null) {
    // Text before the code span
    if (match.index > lastIndex) {
      parts.push(escapeOutsideCode(rest.slice(lastIndex, match.index)))
    }
    // The code span itself — keep as-is (Telegram parses it)
    parts.push(match[0])
    lastIndex = match.index + match[0].length
  }

  // Remaining text after last code span
  if (lastIndex < rest.length) {
    parts.push(escapeOutsideCode(rest.slice(lastIndex)))
  }

  return parts.join('')
}

/** Escape MarkdownV2 special chars outside of code spans */
function escapeOutsideCode(text: string): string {
  return text.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, '\\$1')
}

/** Sanitize a filename from Telegram to safe chars */
function safeName(name?: string): string | undefined {
  if (!name) return undefined
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// ============================================================================
// Session Registry
// ============================================================================

type ConnectedSession = SessionInfo & { socket: Socket }

/** sessionId -> ConnectedSession */
const sessions = new Map<string, ConnectedSession>()

/** chatId -> sessionId (which session is active for each chat) */
const activeSession = new Map<string, string>()

/** sessionId -> last outbound reply text (for /last command) */
const lastReply = new Map<string, string>()

/** request_id -> permission details for "See more" expansion */
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

/** sessionName -> chatId that requested /new (auto-activate on connect) */
const pendingActivation = new Map<string, string>()

function getActiveSessionForChat(chatId: string): ConnectedSession | undefined {
  const sid = activeSession.get(chatId)
  if (!sid) return undefined
  const s = sessions.get(sid)
  if (!s) {
    activeSession.delete(chatId)
    return undefined
  }
  return s
}

function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  sessions.delete(sessionId)

  // For any chat where this was active, switch to the last remaining session
  for (const [chatId, sid] of activeSession.entries()) {
    if (sid === sessionId) {
      activeSession.delete(chatId)
      // Auto-switch to the last remaining session
      if (sessions.size > 0) {
        const last = [...sessions.keys()].pop()!
        activeSession.set(chatId, last)
        // Notify the newly activated session
        const newSession = sessions.get(last)
        if (newSession) {
          newSession.socket.write(encode({ type: 'session_activated' } as DaemonToServer))
        }
      }
    }
  }

  // Notify the removed session it's deactivated
  if (session) {
    try {
      session.socket.write(encode({ type: 'session_deactivated' } as DaemonToServer))
    } catch {}
  }
}

// ============================================================================
// Telegram Commands
// ============================================================================

function generateSessionId(): string {
  return randomBytes(4).toString('hex')
}

function findClaudeTelegram(): string | null {
  try {
    return execFileSync('which', ['claude-telegram'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function handleNewCommand(ctx: Context, label?: string, opts?: { skipPermissions?: boolean; continue?: boolean }): Promise<void> {
  const id = generateSessionId()
  const name = label || `claude-${id}`
  const tmuxSession = name

  try {
    const pluginRoot = PLUGIN_ROOT.replace(/\/$/, '')
    const access = loadAccess()
    const projects = access.projects ?? {}
    const projectPath = projects[name]
    const rawCwd = projectPath ?? access.workspace ?? pluginRoot
    const cwd = rawCwd.startsWith('~') ? rawCwd.replace('~', homedir()) : rawCwd

    const claudeTelegramBin = findClaudeTelegram()
    const extraFlags: string[] = []
    if (opts?.skipPermissions) extraFlags.push('--skip-permissions')
    if (opts?.continue) extraFlags.push('--continue')
    const claudeCmd = claudeTelegramBin
      ? `${claudeTelegramBin} --name ${name}${extraFlags.length ? ' ' + extraFlags.join(' ') : ''}`
      : `TELEGRAM_SESSION_NAME=${name} claude --dangerously-load-development-channels server:telegram-sessions${opts?.skipPermissions ? ' --dangerously-skip-permissions' : ''}${opts?.continue ? ' --continue' : ''}`

    // Create tmux session with the claude command (wrap in shell so env vars are interpreted)
    const child = spawn('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, 'sh', '-c', claudeCmd], {
      stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code}`))))
      child.on('error', reject)
    })
    // Auto-confirm the dev channels warning (option 1 is pre-selected, just press Enter)
    await new Promise(resolve => setTimeout(resolve, 3000))
    const confirm = spawn('tmux', ['send-keys', '-t', tmuxSession, 'Enter'], {
      stdio: 'ignore',
    })
    await new Promise<void>(resolve => confirm.on('close', () => resolve()))
  } catch (err) {
    await ctx.reply(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  pendingActivation.set(name, String(ctx.chat!.id))
  await ctx.reply(`Session started: ${name}\nWaiting for Claude to connect...`)
}

async function handleSwitchCommand(ctx: Context): Promise<void> {
  if (sessions.size === 0) {
    await ctx.reply('No active sessions. Use /new to start one.')
    return
  }

  const chatId = String(ctx.chat!.id)
  const currentSid = activeSession.get(chatId)

  const buttons = [...sessions.entries()].map(([sid, s]) => {
    const mark = sid === currentSid ? ' \u2713' : ''
    return [{ text: `${s.name}${mark}`, callback_data: `switch:${sid}` }]
  })

  await ctx.reply('Choose a session:', {
    reply_markup: { inline_keyboard: buttons },
  })
}

async function handleKillCommand(ctx: Context, nameOrId?: string): Promise<void> {
  if (!nameOrId) {
    await ctx.reply('Usage: /kill <session-name-or-id>')
    return
  }

  // Find session by name or id
  let targetId: string | undefined
  let targetSession: ConnectedSession | undefined

  for (const [sid, s] of sessions.entries()) {
    if (sid === nameOrId || s.name === nameOrId) {
      targetId = sid
      targetSession = s
      break
    }
  }

  // Try to kill tmux session regardless of whether it's in our registry
  const tmuxName = targetSession?.name ?? nameOrId
  try {
    const child = spawn('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' })
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  } catch {}

  if (targetId) {
    removeSession(targetId)
    await ctx.reply(`Killed session: ${targetSession!.name}`)
  } else {
    await ctx.reply(`Session not found in registry, attempted tmux kill for: ${nameOrId}`)
  }
}

async function handleSessionsCommand(ctx: Context): Promise<void> {
  if (sessions.size === 0) {
    await ctx.reply('No active sessions. Use /new to start one.')
    return
  }

  const chatId = String(ctx.chat!.id)
  const currentSid = activeSession.get(chatId)

  const lines = [...sessions.entries()].map(([sid, s]) => {
    const mark = sid === currentSid ? ' (active)' : ''
    const cwd = s.cwd ? ` [${s.cwd}]` : ''
    return `- ${s.name}${mark}${cwd}`
  })

  await ctx.reply(`Sessions:\n${lines.join('\n')}`)
}

// ============================================================================
// Telegram Inbound Handling
// ============================================================================

function isCommand(text: string): boolean {
  return /^\/(new|switch|kill|sessions|last|projects|start|help|status)/.test(text)
}

async function handleProjectsCommand(ctx: Context, args: string): Promise<void> {
  const access = loadAccess()
  const projects = access.projects ?? {}

  if (!args) {
    // List projects
    const entries = Object.entries(projects)
    if (entries.length === 0) {
      await ctx.reply('No saved projects.\n\nUsage:\n/projects add <name> <path>\n/projects remove <name>')
      return
    }
    const lines = entries.map(([name, path]) => `- ${name} → ${path}`)
    await ctx.reply(`Projects:\n${lines.join('\n')}\n\nUse: /new <project-name>`)
    return
  }

  const addMatch = args.match(/^add\s+(\S+)\s+(.+)$/)
  if (addMatch) {
    const [, name, path] = addMatch
    access.projects = { ...projects, [name]: path }
    saveAccess(access)
    await ctx.reply(`Project "${name}" saved → ${path}`)
    return
  }

  const removeMatch = args.match(/^(?:remove|rm|del)\s+(\S+)$/)
  if (removeMatch) {
    const name = removeMatch[1]
    if (!projects[name]) {
      await ctx.reply(`Project "${name}" not found.`)
      return
    }
    delete projects[name]
    access.projects = projects
    saveAccess(access)
    await ctx.reply(`Project "${name}" removed.`)
    return
  }

  await ctx.reply('Usage:\n/projects — list\n/projects add <name> <path>\n/projects remove <name>')
}

function parseCommand(text: string): { cmd: string; args: string } {
  // Handle /command@botname format
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/)
  if (!match) return { cmd: '', args: '' }
  return { cmd: match[1], args: match[2].trim() }
}

async function handleLastCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const session = getActiveSessionForChat(chatId)
  if (!session) {
    await ctx.reply('No active session. Use /new to start one.')
    return
  }
  const last = lastReply.get(session.sessionId)
  if (!last) {
    await ctx.reply(`No messages yet from session "${session.name}".`)
    return
  }
  const preview = last.length > 4000 ? last.slice(-4000) + '...' : last
  await ctx.reply(`Last from "${session.name}":\n\n${preview}`)
}

async function handleStartCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') {
    await ctx.reply(`This bot isn't accepting new connections.`)
    return
  }
  await ctx.reply(
    `This bot bridges Telegram to Claude Code sessions.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram-sessions:access pair <code>\n\n` +
    `After that, use /new to start a Claude session.`
  )
}

async function handleHelpCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session. ` +
    `Text, photos, documents and voice messages are forwarded.\n\n` +
    `/new [name] — start a new Claude session\n` +
    `/switch — switch between sessions\n` +
    `/sessions — list active sessions\n` +
    `/last — show last reply from current session\n` +
    `/projects — manage saved projects\n` +
    `/kill <name> — kill a session\n` +
    `/status — check your pairing state`
  )
}

async function handleStatusCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return
  const from = ctx.from
  if (!from) return
  const senderId = String(from.id)
  const access = loadAccess()

  if (access.allowFrom.includes(senderId)) {
    const name = from.username ? `@${from.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(
        `Pending pairing — run in Claude Code:\n\n/telegram-sessions:access pair ${code}`
      )
      return
    }
  }

  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
}

async function routeToSession(ctx: Context, text: string, imagePath?: string, attachment?: { file_id: string; name?: string; mime?: string; size?: number }): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const from = ctx.from!
  const msgId = ctx.message?.message_id

  let session = getActiveSessionForChat(chatId)

  // If no active session, auto-activate first available
  if (!session && sessions.size > 0) {
    const firstId = [...sessions.keys()][0]
    activeSession.set(chatId, firstId)
    session = sessions.get(firstId)!
    session.socket.write(encode({ type: 'session_activated' } as DaemonToServer))
  }

  if (!session) {
    await ctx.reply('No active Claude sessions. Use /new to start one.')
    return
  }

  const msg: DaemonToServer = {
    type: 'message',
    chat_id: chatId,
    message_id: msgId != null ? String(msgId) : undefined,
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    text,
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_file_id: attachment.file_id,
      attachment_name: attachment.name,
      attachment_mime: attachment.mime,
      attachment_size: attachment.size,
    } : {}),
  }

  session.socket.write(encode(msg))
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: { kind: string; file_id: string; size?: number; mime?: string; name?: string },
): Promise<void> {
  const result = gate(ctx)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Typing indicator
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  // Check for commands
  if (isCommand(text)) {
    const { cmd, args } = parseCommand(text)
    switch (cmd) {
      case 'new': {
        const skipPermissions = /--skip-permissions\b/.test(args)
        const cont = /--continue\b/.test(args)
        const name = args.replace(/--(skip-permissions|continue)\s*/g, '').trim() || undefined
        await handleNewCommand(ctx, name, { skipPermissions, continue: cont })
        return
      }
      case 'switch':
        await handleSwitchCommand(ctx)
        return
      case 'kill':
        await handleKillCommand(ctx, args || undefined)
        return
      case 'sessions':
        await handleSessionsCommand(ctx)
        return
      case 'last':
        await handleLastCommand(ctx)
        return
      case 'projects':
        await handleProjectsCommand(ctx, args)
        return
      case 'start':
        await handleStartCommand(ctx)
        return
      case 'help':
        await handleHelpCommand(ctx)
        return
      case 'status':
        await handleStatusCommand(ctx)
        return
    }
  }

  const imagePath = downloadImage ? await downloadImage() : undefined
  await routeToSession(ctx, text, imagePath, attachment ? {
    file_id: attachment.file_id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  } : undefined)
}

// ============================================================================
// Telegram Bot Setup
// ============================================================================

bot.on('message:text', async (ctx) => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async (ctx) => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram-sessions daemon: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document',
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  })
})

bot.on('message:voice', async (ctx) => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})

bot.on('message:audio', async (ctx) => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${name ?? audio.title ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'audio',
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  })
})

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data

  // Handle permission verdict buttons
  if (data.startsWith('perm:')) {
    const match = data.match(/^perm:(allow|deny|more):(.+)$/)
    if (!match) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    // Security: verify sender is in allowFrom
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }

    const [, action, requestId] = match

    // Handle "See more" expansion
    if (action === 'more') {
      const details = pendingPermissions.get(requestId)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      await ctx.editMessageText(expanded, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Allow', callback_data: `perm:allow:${requestId}` },
            { text: '❌ Deny', callback_data: `perm:deny:${requestId}` },
          ]],
        },
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    const behavior = action as 'allow' | 'deny'
    const chatId = String(ctx.chat!.id)
    const session = getActiveSessionForChat(chatId)

    if (!session) {
      await ctx.answerCallbackQuery({ text: 'No active session.' })
      return
    }

    session.socket.write(encode({
      type: 'permission_verdict',
      request_id: requestId,
      behavior,
    } as DaemonToServer))

    pendingPermissions.delete(requestId)
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    try {
      const original = ctx.callbackQuery.message?.text ?? ''
      await ctx.editMessageText(`${original}\n\n${label}`)
    } catch {}
    return
  }

  if (!data.startsWith('switch:')) return

  const sessionId = data.slice('switch:'.length)
  const session = sessions.get(sessionId)
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session no longer available.' })
    return
  }

  const chatId = String(ctx.chat!.id)
  const previousSid = activeSession.get(chatId)

  // Deactivate previous
  if (previousSid && previousSid !== sessionId) {
    const prev = sessions.get(previousSid)
    if (prev) {
      prev.socket.write(encode({ type: 'session_deactivated' } as DaemonToServer))
    }
  }

  activeSession.set(chatId, sessionId)
  session.socket.write(encode({ type: 'session_activated' } as DaemonToServer))

  await ctx.answerCallbackQuery({ text: `Switched to: ${session.name}` })
  await ctx.editMessageText(`Active session: ${session.name}`)
})

// ============================================================================
// Outbound Proxy (Session -> Telegram)
// ============================================================================

async function handleOutbound(msg: ServerToDaemon, session: ConnectedSession): Promise<void> {
  switch (msg.type) {
    case 'download_attachment': {
      try {
        const file = await bot.api.getFile(msg.file_id)
        if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(path, buf)
        session.socket.write(
          encode({ type: 'result', ok: true, data: path } as DaemonToServer),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        session.socket.write(
          encode({ type: 'result', ok: false, error: `download_attachment failed: ${errMsg}` } as DaemonToServer),
        )
      }
      return
    }

    case 'reply': {
      const { chat_id, text, reply_to, files = [], format } = msg
      try {
        assertAllowedChat(chat_id)
        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(
              `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`,
            )
          }
        }

        const access = loadAccess()
        const limit = Math.max(
          1,
          Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT),
        )
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const useRawMarkdown = format === 'markdownv2'
        const parseMode = useRawMarkdown ? 'MarkdownV2' as const : 'MarkdownV2' as const
        const formattedText = useRawMarkdown ? text : escapeMarkdownV2(text)
        const chunks = chunk(formattedText, limit, mode)
        const plainChunks = useRawMarkdown ? undefined : chunk(text, limit, mode)
        const sentIds: number[] = []
        const replyToNum = reply_to != null ? Number(reply_to) : undefined

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            replyToNum != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const replyParams = shouldReplyTo ? { reply_parameters: { message_id: replyToNum } } : {}
          let sent
          try {
            sent = await bot.api.sendMessage(chat_id, chunks[i], {
              parse_mode: parseMode,
              ...replyParams,
            })
          } catch {
            // Fallback to plain text if MarkdownV2 parsing fails
            const fallback = plainChunks ? plainChunks[i] : chunks[i]
            sent = await bot.api.sendMessage(chat_id, fallback, {
              ...replyParams,
            })
          }
          sentIds.push(sent.message_id)
        }

        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts =
            replyToNum != null && replyMode !== 'off'
              ? { reply_parameters: { message_id: replyToNum } }
              : undefined
          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chat_id, input, opts)
            sentIds.push(sent.message_id)
          } else {
            const sent = await bot.api.sendDocument(chat_id, input, opts)
            sentIds.push(sent.message_id)
          }
        }

        lastReply.set(session.sessionId, text)

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`

        session.socket.write(
          encode({ type: 'result', ok: true, data: result } as DaemonToServer),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        session.socket.write(
          encode({ type: 'result', ok: false, error: `reply failed: ${errMsg}` } as DaemonToServer),
        )
      }
      return
    }

    case 'react': {
      try {
        assertAllowedChat(msg.chat_id)
        await bot.api.setMessageReaction(msg.chat_id, Number(msg.message_id), [
          { type: 'emoji', emoji: msg.emoji as ReactionTypeEmoji['emoji'] },
        ])
        session.socket.write(
          encode({ type: 'result', ok: true, data: 'reacted' } as DaemonToServer),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        session.socket.write(
          encode({ type: 'result', ok: false, error: `react failed: ${errMsg}` } as DaemonToServer),
        )
      }
      return
    }

    case 'permission_request': {
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const text = `🔐 Permission: ${tool_name} (${session.name})`
      const keyboard = {
        inline_keyboard: [[
          { text: 'See more', callback_data: `perm:more:${request_id}` },
          { text: '✅ Allow', callback_data: `perm:allow:${request_id}` },
          { text: '❌ Deny', callback_data: `perm:deny:${request_id}` },
        ]],
      }
      // Send to allowlisted DM users only (not groups — security)
      const access = loadAccess()
      for (const chatId of access.allowFrom) {
        void bot.api.sendMessage(chatId, text, { reply_markup: keyboard }).catch(e => {
          process.stderr.write(`permission_request send to ${chatId} failed: ${e}\n`)
        })
      }
      return
    }

    case 'edit': {
      try {
        assertAllowedChat(msg.chat_id)
        const useRawMd = msg.format === 'markdownv2'
        const formatted = useRawMd ? msg.text : escapeMarkdownV2(msg.text)
        let edited
        try {
          edited = await bot.api.editMessageText(
            msg.chat_id,
            Number(msg.message_id),
            formatted,
            { parse_mode: 'MarkdownV2' },
          )
        } catch {
          edited = await bot.api.editMessageText(
            msg.chat_id,
            Number(msg.message_id),
            msg.text,
          )
        }
        const id = typeof edited === 'object' ? edited.message_id : msg.message_id
        session.socket.write(
          encode({ type: 'result', ok: true, data: `edited (id: ${id})` } as DaemonToServer),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        session.socket.write(
          encode({
            type: 'result',
            ok: false,
            error: `edit failed: ${errMsg}`,
          } as DaemonToServer),
        )
      }
      return
    }
  }
}

// ============================================================================
// Unix Socket Server
// ============================================================================

// Clean stale socket
if (existsSync(DAEMON_SOCK)) {
  try {
    unlinkSync(DAEMON_SOCK)
  } catch {}
}

const socketServer = createServer((socket: Socket) => {
  let buffer = ''
  let sessionId: string | undefined

  socket.on('data', (data: Buffer) => {
    buffer += data.toString()
    const { messages, rest } = parseMessages<ServerToDaemon>(buffer)
    buffer = rest

    for (const msg of messages) {
      if (msg.type === 'register') {
        sessionId = msg.sessionId
        const session: ConnectedSession = {
          sessionId: msg.sessionId,
          name: msg.name ?? `session-${msg.sessionId}`,
          cwd: msg.cwd ?? '',
          socket,
        }
        sessions.set(msg.sessionId, session)
        process.stderr.write(
          `telegram-sessions daemon: session registered: ${session.name} (${msg.sessionId})\n`,
        )

        socket.write(encode({ type: 'result', ok: true, data: 'registered' } as DaemonToServer))

        // If this session was created via /new, auto-activate for the requesting chat
        const pendingChatId = pendingActivation.get(session.name)
        if (pendingChatId) {
          pendingActivation.delete(session.name)
          const previousSid = activeSession.get(pendingChatId)
          if (previousSid && previousSid !== msg.sessionId) {
            const prev = sessions.get(previousSid)
            if (prev) prev.socket.write(encode({ type: 'session_deactivated' } as DaemonToServer))
          }
          activeSession.set(pendingChatId, msg.sessionId)
          session.socket.write(encode({ type: 'session_activated' } as DaemonToServer))
        }

        // Auto-activate for chats that don't have an active session
        for (const chatId of getAllowedChatIds()) {
          if (!getActiveSessionForChat(chatId)) {
            activeSession.set(chatId, msg.sessionId)
            session.socket.write(encode({ type: 'session_activated' } as DaemonToServer))
          }
        }

        // Notify all allowed chats that a session connected
        for (const chatId of getAllowedChatIds()) {
          const isActive = activeSession.get(chatId) === msg.sessionId
          const suffix = isActive ? ' (active)' : ''
          void bot.api.sendMessage(chatId, `Session "${session.name}" connected.${suffix}`).catch(() => {})
        }
        continue
      }

      // All other messages require a registered session
      if (!sessionId) {
        socket.write(
          encode({
            type: 'result',
            ok: false,
            error: 'not registered — send register first',
          } as DaemonToServer),
        )
        continue
      }

      const session = sessions.get(sessionId)
      if (!session) continue

      void handleOutbound(msg, session)
    }
  })

  socket.on('close', () => {
    if (sessionId) {
      process.stderr.write(`telegram-sessions daemon: session disconnected: ${sessionId}\n`)
      removeSession(sessionId)
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`telegram-sessions daemon: socket error: ${err.message}\n`)
    if (sessionId) {
      removeSession(sessionId)
    }
  })
})

socketServer.listen(DAEMON_SOCK, () => {
  process.stderr.write(`telegram-sessions daemon: socket server listening on ${DAEMON_SOCK}\n`)
})

// ============================================================================
// Graceful Shutdown
// ============================================================================

function shutdown(): void {
  process.stderr.write('telegram-sessions daemon: shutting down...\n')

  socketServer.close()

  try {
    unlinkSync(DAEMON_SOCK)
  } catch {}
  try {
    unlinkSync(DAEMON_PID)
  } catch {}

  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ============================================================================
// Start Bot
// ============================================================================

void bot.start({
  onStart: async (info) => {
    botUsername = info.username
    process.stderr.write(`telegram-sessions daemon: polling as @${info.username}\n`)
    await bot.api.setMyCommands([
      { command: 'start', description: 'Pairing instructions' },
      { command: 'help', description: 'Available commands' },
      { command: 'status', description: 'Check your pairing state' },
      { command: 'new', description: 'Start a session (/new [--skip-permissions] [--continue] name)' },
      { command: 'switch', description: 'Switch between active sessions' },
      { command: 'sessions', description: 'List all active sessions' },
      { command: 'last', description: 'Show last message from current session' },
      { command: 'projects', description: 'Manage saved projects (/projects add name path)' },
      { command: 'kill', description: 'Kill a session (/kill name-or-id)' },
    ])
  },
})
