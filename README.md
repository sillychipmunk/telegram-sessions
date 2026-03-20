# telegram-sessions

> **WARNING:** Sessions spawned from Telegram run with `--dangerously-skip-permissions`, which means Claude can execute any command without confirmation. Use at your own risk. Only allow access to trusted users and always lock down access policy to `allowlist` after setup.

Telegram channel for Claude Code. Run multiple Claude sessions, manage them from Telegram with `/new`, `/switch`, `/kill`, `/sessions`.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Bun](https://bun.sh/) runtime
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## Install

```bash
git clone https://github.com/Bergamolt/telegram-sessions.git
cd telegram-sessions
bun install
```

Add the plugin to Claude Code:

```bash
# Add the local marketplace
/plugin marketplace add /path/to/telegram-sessions

# Install the plugin
/plugin install telegram-sessions@telegram-sessions-marketplace

# Reload to activate
/reload-plugins
```

The plugin registers its MCP server and skills automatically.

## Setup

Everything is done through built-in skills — no need to edit config files manually.

### 1. Save your bot token

```
/telegram-sessions:configure <your-bot-token>
```

The token is stored in `~/.claude/channels/telegram-sessions/.env`.

### 2. Check status

```
/telegram-sessions:configure
```

Shows: token status, access policy, allowed users, pending pairings, and next steps.

### 3. Pair your Telegram account

DM your bot on Telegram. It replies with a 6-character pairing code. Approve it:

```
/telegram-sessions:access pair <code>
```

### 4. Lock down access

Once everyone who needs access has paired, switch from pairing mode to allowlist:

```
/telegram-sessions:access policy allowlist
```

Now only approved users can reach Claude through the bot.

## Usage from Telegram

| Command | Description |
|---------|-------------|
| `/new [name]` | Start a new Claude session (runs in tmux) |
| `/switch` | Switch between active sessions |
| `/sessions` | List all active sessions |
| `/kill <name>` | Kill a session |

Regular messages are routed to the active session. Claude replies directly in the chat with markdown formatting.

## Access management

```
/telegram-sessions:access                          # show status
/telegram-sessions:access pair <code>              # approve a pairing
/telegram-sessions:access deny <code>              # reject a pairing
/telegram-sessions:access allow <senderId>         # add user by ID
/telegram-sessions:access remove <senderId>        # remove user
/telegram-sessions:access policy <mode>            # pairing | allowlist | disabled
/telegram-sessions:access group add <groupId>      # allow a group chat
/telegram-sessions:access group rm <groupId>       # remove a group chat
/telegram-sessions:access set ackReaction <emoji>   # reaction on received messages
/telegram-sessions:access set replyToMode <mode>   # off | first | all
```

## CLI wrapper

The plugin includes `bin/claude-telegram` for launching sessions from the terminal:

```bash
claude-telegram --name my-session
claude-telegram --name my-session --skip-permissions
claude-telegram --help
```

To make it available globally:

```bash
mkdir -p ~/.local/bin
ln -sf /path/to/telegram-sessions/bin/claude-telegram ~/.local/bin/claude-telegram
```

Add `~/.local/bin` to PATH if not already there:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

The `/telegram-sessions:configure` skill will offer to set this up automatically.

## Architecture

```
Telegram ← Bot API → Daemon (grammy, unix socket server)
                        ↕ unix socket
                     MCP Server (per Claude session)
                        ↕ stdio
                     Claude Code
```

- **Daemon** (`src/daemon.ts`) — single long-running process. Holds the Telegram bot connection, manages session registry, routes messages, handles commands.
- **MCP Server** (`src/server.ts`) — one per Claude session. Connects to daemon via unix socket, exposes `reply`, `react`, `edit_message` tools.
- **Shared** (`src/shared.ts`) — paths, protocol types, helpers.

State is stored in `~/.claude/channels/telegram-sessions/`:

| File | Purpose |
|------|---------|
| `.env` | `TELEGRAM_BOT_TOKEN` and optional settings |
| `access.json` | Access policy, allowlist, pending pairings |
| `daemon.sock` | Unix socket for server↔daemon communication |
| `daemon.pid` | Daemon process ID |
| `inbox/` | Downloaded photos from Telegram |

## Group chats

Add the bot to a group, then register the group:

```
/telegram-sessions:access group add <groupId>
```

By default, the bot only responds when mentioned (`@yourbot`). To disable this:

```
/telegram-sessions:access group add <groupId> --no-mention
```

To restrict which group members can interact:

```
/telegram-sessions:access group add <groupId> --allow id1,id2
```

## Settings

Configure via `/telegram-sessions:access set`:

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `ackReaction` | emoji or `""` | none | React to incoming messages |
| `replyToMode` | `off`, `first`, `all` | `first` | Thread replies under the original message |
| `textChunkLimit` | number | 4096 | Max message length before splitting |
| `chunkMode` | `length`, `newline` | `length` | How to split long messages |
| `mentionPatterns` | JSON array | none | Extra patterns to trigger bot in groups |
| `workspace` | path | plugin root | Working directory for new sessions |
