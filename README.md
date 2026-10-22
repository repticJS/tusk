# Tusk

A fast, modern desktop client for PostgreSQL, with built-in SSH terminals, SFTP, SSH tunnels and local terminals. Built with Tauri 2 (Rust) and React.

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
| Connections | Saved connections, paste a `postgres://` URL, test button, SSL modes, connect through an SSH host, color tags (shown on tabs), passwords in Windows Credential Manager, nested folders mixing SSH hosts and databases (drag and drop) |
| Browser | Databases → schemas → tables, views, materialized views, functions; filter box; row estimates |
| Table view | Data, Structure (columns, indexes, constraints, triggers), generated DDL; WHERE filter; click a header to sort; exact or estimated counts |
| Editing | Inline and value-panel editing, NULL handling, add and delete rows, SQL preview, single-transaction commit |
| Query editor | Multiple statements, run at cursor or selection or all, cancel, EXPLAIN / EXPLAIN ANALYZE, notices, row limit, open and save `.sql` files |
| Results | Multiple result sets, messages log, value panel with pretty JSON, find (Ctrl+F), copy cells |
| Export | CSV (Excel-friendly), JSON, TSV to clipboard, INSERT statements |
| Activity | Live dashboard per database (right-click a connection → *Activity & sessions*): connections, transactions per second, cache hit rate, sessions with their queries and run time, who is blocking whom, cancel a query or terminate a session, replicas, and table health (dead rows, scans, last vacuum) |
| Everywhere | Command palette (Ctrl+P), query history, dark and light theme, tabs restored on restart |

### SSH terminals

| Area | What's there |
|---|---|
| Hosts | Saved SSH hosts in the sidebar, quick fill from `user@host:port` or an `ssh -p 2222 user@host` command, color tags, optional start folder (the shell and file panel open there) |
| Auth | Password (with keyboard-interactive fallback), private key files (OpenSSH or PuTTY `.ppk`, with passphrase), SSH agent (Windows OpenSSH agent or Pageant). Secrets go to Windows Credential Manager. |
| Host keys | Fingerprint confirmation on first connect, remembered afterwards; a clear warning if a server's key changes. Keys already in `~/.ssh/known_hosts` are trusted. |
| Terminal | xterm.js with GPU rendering, 256 colors and Unicode, clickable links, find (Ctrl+Shift+F), resize follows the window, press Enter to reconnect |
| Server stats | A strip under each terminal with live CPU, memory, disk, network, load, uptime and users (Linux servers). Click it for 3-minute graphs, every disk, and the top processes by CPU. Toggle with **Stats**. |
| Clipboard | Ctrl+C copies a selection (otherwise sends interrupt), Ctrl+V pastes, right-click copies a selection or pastes (PuTTY style) |

### Local terminals and multi-exec

Open PowerShell, Command Prompt, Git Bash or any WSL distro in a tab from the monitor button at the top of the sidebar, the start page or the command palette. Tusk finds the installed shells by itself and runs them in a real console (ConPTY), so colors, full-screen programs and resizing work.

**Multi-exec** (the antenna button in any terminal's header) sends what you type to several terminals at once, SSH and local alike. Tick which ones take part, and use **Tile** to see them side by side.

### Saved commands

Save the commands you run all the time — a deploy like `cd ~/apps/api && git pull && npm ci && pm2 reload api`, a restart, a cleanup — and run them on one server or several at once (**+** → **New command…**, right-click a host or folder, the ⚡ menu in a terminal, or **Commands** in the palette). Each server's output streams live in its own pane with exit status and time; failures can be re-run on just the servers that failed, and **Cancel** really stops the command on the server. Scripts run under `sh` in your home folder, stop at the first failing line unless you untick that, find Node tools installed with nvm, and ask before running unless you say otherwise. Commands travel with shared folders.

### Monitoring

Right-click an SSH host → **Monitor this host**, or open **Monitoring** from the bell in the status bar. While Tusk is open it checks those servers every few minutes (one short command each) and raises a Windows notification when something goes wrong, and again when it's fixed:

- a disk fuller than your threshold (90% by default), memory nearly exhausted
- failed systemd services
- PM2 apps or Docker containers that crashed or stopped
- TLS certificates served by the server (from its nginx or Caddy config) expiring within 14 days
- the server not answering two checks in a row

The status bar shows how many problems there are, hosts with problems get a warning icon in the sidebar, and the Monitoring tab lists each server's disks, apps and certificates plus the alert history.

### Sharing folders

Right-click a folder → **Share folder…** to hand its connections, SSH hosts and tunnels (with subfolders, and any SSH hosts its connections go through) to a teammate as a share code or a `.tusk` file. They import it with **+** → **Import shared folder…** and get their own copy; nothing in their sidebar is overwritten.

Passwords, SSH passwords and private key files are left out unless you tick **Include passwords and keys**. Then the share is encrypted with a passphrase you choose (Argon2id + XChaCha20-Poly1305); send the passphrase separately. Imported passwords go to Windows Credential Manager and key files to Tusk's own folder, readable only by you.

### Discover databases and containers

The **Discover** tab (radar button at the top of the sidebar, or right-click an SSH host → *Scan for databases & containers*) scans this PC and your SSH servers. SSH servers are also scanned in the background when you open a terminal, and the terminal header shows what was found.

- **Databases:** listening PostgreSQL, MySQL/MariaDB, Redis, MongoDB, SQL Server and more, with PostgreSQL versions and data folders. **Add connection** fills in a PostgreSQL connection, through the SSH host when needed. Other databases can be forwarded to this PC with one click.
- **Docker / Podman containers:** state, image and ports, with start, stop, restart, live logs and a shell inside the container. Database containers get **Add connection** too, filled in from their environment (`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`).

### PM2

Each scan also lists the PM2 apps of the SSH user (and on this PC): status, CPU, memory, uptime and restarts, refreshed every few seconds while Discover is open. Start, stop, restart, reload (cluster apps, no downtime) or delete apps, clear their logs, reset counters, save the process list, start saved apps when PM2 isn't running, and start new apps from a form. **Logs** and **Monitor** open `pm2 logs` / `pm2 monit` in a terminal tab. PM2 installed through nvm, Volta, n or npm's global folder is found even though it's not on the PATH of non-interactive SSH sessions, and listing never starts a PM2 daemon by itself.

### SSH tunnels

Open the **Tunnels** tab from the sidebar's tunnel button, the status bar, or the command palette.

| Type | What it does |
|---|---|
| Local (`-L`) | A port on this PC leads to a host and port reached from the server, e.g. `localhost:15432 → localhost:5432` |
| Remote (`-R`) | A port opened on the server leads back to a service on this PC or your network |
| Dynamic (`-D`) | A SOCKS4/4a/5 proxy on this PC that connects out from the server |

Tunnels through the same host share one SSH connection, reconnect by themselves if it drops, show live connection and byte counters, and can start automatically when Tusk opens. They listen on this PC only unless you allow other computers.

**PostgreSQL over SSH:** pick an SSH host under *Connect through* in a connection's settings. Tusk opens a private tunnel when you connect; host and port are then as seen from the SSH server (usually `localhost:5432`).

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
  stats.rs     server performance stats over a terminal's connection (/proc, df)
  sftp.rs      SFTP over a terminal's connection: listing, transfers, remote editing, shell cwd
  monitor.rs   background checks of SSH hosts, problems and alerts
  share.rs     folder share codes: collecting, encryption, importing with new ids
  pm2.rs       PM2 apps: listing (pm2 jlist), actions, new apps, logs/monit terminals
  discover.rs  finds databases and Docker containers (ss/netstat/proc, ps, pg_lsclusters, docker)
  local.rs     local shells in a pseudo-terminal (ConPTY on Windows), shell detection
  tunnel.rs    SSH port forwarding (local, remote, SOCKS), shared per-host connections, DB tunnels
  store.rs     saved connections (JSON in %APPDATA%\dev.tusk.app) + Credential Manager passwords
  lib.rs       Tauri commands
src/
  lib/api.ts   typed wrappers around the Tauri commands, password prompt retry
  lib/meta.ts  catalog introspection queries, DDL generation
  lib/sql.ts   statement splitter, quoting, formatting, export helpers
  store.ts     app state (zustand)
  components/  Sidebar, QueryTab, TableTab, TerminalTab (xterm.js), SftpPanel, RemoteFileTab, TunnelsTab, DataGrid (Glide), SqlEditor (CodeMirror), dialogs
```

## Roadmap ideas

- Visual EXPLAIN plan viewer
- ER diagram
- Backup / restore via `pg_dump` / `pg_restore`
- Roles and permissions UI
