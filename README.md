# Tusk

A fast, modern desktop client for PostgreSQL, with built-in SSH terminals and SFTP. Built with Tauri 2 (Rust) and React.

- **Small and quick.** Native Rust backend, about a 10 MB install, opens instantly.
- **Data grid that scales.** Canvas-rendered, loads rows as you scroll, handles 100k+ row results smoothly.
- **Exact values.** Results arrive in Postgres's own text format, so `numeric`, `jsonb`, arrays, ranges, PostGIS and custom types display exactly as the server sends them.
- **Safe editing.** Edit cells, add and delete rows, then review the generated SQL before it runs. All changes commit in one transaction. Only tables with a primary key can be edited.
- **Proper SQL editor.** Postgres syntax, autocomplete from your schema, run the statement under the cursor, errors underlined at the exact position along with Postgres's hint.
- **Isolated tabs.** Each query tab has its own connection, so a long query or open transaction never blocks the rest of the app. Running transactions are clearly flagged, with Commit and Rollback buttons.

Works with PostgreSQL 9.6 and newer (tested against 9.6, 10, 11 and 16).

## Features

| Area | What's there |
|---|---|
| Connections | Saved connections, paste a `postgres://` URL, test button, SSL modes, color tags (shown on tabs), passwords in Windows Credential Manager, nested folders mixing SSH hosts and databases (drag and drop) |
| Browser | Databases → schemas → tables, views, materialized views, functions; filter box; row estimates |
| Table view | Data, Structure (columns, indexes, constraints, triggers), generated DDL; WHERE filter; click a header to sort; exact or estimated counts |
| Editing | Inline and value-panel editing, NULL handling, add and delete rows, SQL preview, single-transaction commit |
| Query editor | Multiple statements, run at cursor or selection or all, cancel, EXPLAIN / EXPLAIN ANALYZE, notices, row limit, open and save `.sql` files |
| Results | Multiple result sets, messages log, value panel with pretty JSON, find (Ctrl+F), copy cells |
| Export | CSV (Excel-friendly), JSON, TSV to clipboard, INSERT statements |
| Everywhere | Command palette (Ctrl+P), query history, dark and light theme, tabs restored on restart |

### SSH terminals

| Area | What's there |
|---|---|
| Hosts | Saved SSH hosts in the sidebar, quick fill from `user@host:port` or an `ssh -p 2222 user@host` command, color tags, optional start folder (the shell and file panel open there) |
| Auth | Password (with keyboard-interactive fallback), private key files (OpenSSH or PuTTY `.ppk`, with passphrase), SSH agent (Windows OpenSSH agent or Pageant). Secrets go to Windows Credential Manager. |
| Host keys | Fingerprint confirmation on first connect, remembered afterwards; a clear warning if a server's key changes. Keys already in `~/.ssh/known_hosts` are trusted. |
| Terminal | xterm.js with GPU rendering, 256 colors and Unicode, clickable links, find (Ctrl+Shift+F), resize follows the window, press Enter to reconnect |
| Clipboard | Ctrl+C copies a selection (otherwise sends interrupt), Ctrl+V pastes, right-click copies a selection or pastes (PuTTY style) |

### SFTP file panel

Every terminal tab has a file panel (toggle with **Files**) that works over the same SSH connection, with no second login.

| Area | What's there |
|---|---|
| Browsing | Follows the terminal's current folder as you `cd` (Linux servers), path bar, home, parent, hidden-files toggle, symlinks |
| Transfers | Drag files or folders from Explorer to upload, Download… to a folder of your choice, recursive folders, progress and cancel |
| Files | Double-click to edit remote text files with syntax highlighting (YAML, nginx, shell, JSON, Python, …) and Ctrl+S to save back; rename (F2), new folder, delete (Del) |

In a terminal, Ctrl+W, Ctrl+R and friends go to the shell. Use Ctrl+Shift+T, Ctrl+Shift+W and Ctrl+Shift+P for Tusk's own new tab, close tab and palette.

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+P / Ctrl+K | Jump to any table, or run a command |
| Ctrl+T | New query tab |
| Ctrl+Enter | Run statement at cursor (or the selection) |
| Ctrl+Shift+Enter / F5 | Run the whole script |
| Ctrl+S | Save pending row changes / save `.sql` file |
| Ctrl+W, Ctrl+Tab | Close tab, next tab |
| Ctrl+F | Find in results grid |
| Delete | Mark selected rows for deletion |

## Getting the app

Download the installer from the [latest release](https://github.com/repticJS/tusk/releases/latest). After that, Tusk updates itself: it checks for new versions at startup and every few hours, shows an **Update available** chip in the status bar, and installs with one click. Updates are signed, and Tusk refuses any download whose signature doesn't match.

## Publishing a release

1. Add notes for the new version at the top of `CHANGELOG.md` (they're shown in the update dialog) and commit.
2. Run `npm run release 0.3.0`. This bumps the version everywhere and commits.
3. Run `git push origin main`. Seeing a version with no release yet, the workflow tags it, builds, signs and publishes the GitHub release with `latest.json`, and installed copies pick it up.

Releases are signed with the updater key in the `TAURI_SIGNING_PRIVATE_KEY` repository secret. Keep a backup of that key: without it you can't ship updates to existing installs.

## Building it yourself

Every push to `main` also builds test installers, downloadable from the workflow run's **Artifacts**. To build locally on Windows:

1. Install [Node.js 22+](https://nodejs.org) and [Rust](https://rustup.rs) (choose the default MSVC toolchain; the installer offers the Visual Studio C++ build tools).
2. Run:
   ```powershell
   npm install
   npm run tauri dev      # run with hot reload
   npm run tauri build    # installers in src-tauri\target\release\bundle\
   ```

Windows 10 and 11 already include WebView2, which Tauri uses for the UI.

## Project layout

```
src-tauri/src/
  db.rs        sessions, query execution (simple protocol + Describe for column types), cancel
  ssh.rs       SSH terminals: connect, host-key checks, auth, PTY shell streamed to the UI
  sftp.rs      SFTP over a terminal's connection: listing, transfers, remote editing, shell cwd
  store.rs     saved connections (JSON in %APPDATA%\dev.tusk.app) + Credential Manager passwords
  lib.rs       Tauri commands
src/
  lib/api.ts   typed wrappers around the Tauri commands, password prompt retry
  lib/meta.ts  catalog introspection queries, DDL generation
  lib/sql.ts   statement splitter, quoting, formatting, export helpers
  store.ts     app state (zustand)
  components/  Sidebar, QueryTab, TableTab, TerminalTab (xterm.js), SftpPanel, RemoteFileTab, DataGrid (Glide), SqlEditor (CodeMirror), dialogs
```

## Roadmap ideas

- SSH tunnels, including PostgreSQL over SSH
- Local terminals (PowerShell, cmd, WSL) and multi-exec
- Visual EXPLAIN plan viewer
- ER diagram
- Backup / restore via `pg_dump` / `pg_restore`
- Roles and permissions UI
