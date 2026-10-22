# Changelog

## 0.10.0

- Saved commands: save deploys, restarts and other scripts and run them on one or many servers at once, with live output from each, exit codes, cancel, and "run again where it failed".
- Run them from the Commands tab, a host's right-click menu, the ⚡ menu in a terminal header, or the command palette.
- Shared folders now include the commands for their servers.

## 0.9.0

- Monitoring: pick SSH hosts to watch (right-click → Monitor this host). Tusk checks them every few minutes and sends a Windows notification for full disks, low memory, failed services, crashed PM2 apps and containers, certificates about to expire, and servers that stop answering, and again when each is fixed.
- A bell in the status bar shows the number of problems; the Monitoring tab shows every server's state and the alert history.

## 0.8.0

- Activity dashboard: right-click a connection or database → Activity & sessions. Live connections, transactions per second, cache hit rate, and every session with its query and how long it's been running.
- See which sessions are waiting on locks and which session is blocking them; cancel a query or terminate a session from the dashboard.
- Replica status and table health (dead rows, full table scans, last vacuum and analyze).

## 0.7.0

- Share folders: right-click a folder → Share folder… to send its connections, SSH hosts and tunnels as a share code or .tusk file. Import with + → Import shared folder….
- Optionally include passwords, SSH passwords and private key files, encrypted with a passphrase.
- Shares bring along SSH hosts their connections tunnel through, and imports never overwrite what you already have.

## 0.6.0

- PM2 support: Discover now lists PM2 apps on your servers (and this PC) with live status, CPU, memory, uptime and restarts. Start, stop, restart, reload, delete, clear logs, reset counters, save the process list, bring back saved apps, and start new apps. Logs and Monitor open in a terminal tab.
- Works with PM2 installed through nvm, Volta and similar, and never starts a PM2 daemon just by looking.
- SSH terminals count PM2 apps in their header.
- Server scans, stats and the file panel now work for users whose login shell is fish or tcsh.

## 0.5.0

- Discover: scan this PC and your SSH servers for databases (PostgreSQL, MySQL, MariaDB, Redis, MongoDB, SQL Server and more) and Docker or Podman containers. Open it from the radar button at the top of the sidebar.
- SSH servers are scanned in the background when you open a terminal; the terminal header shows what was found.
- Add a found PostgreSQL server or container as a connection in one click, with the details filled in (through the SSH host when needed). Forward other databases to this PC.
- Start, stop and restart containers, follow their logs, or open a shell inside them.

## 0.4.1

- Server stats for SSH terminals: a live strip under the terminal shows CPU, memory, disk, network, load, uptime and logged-in users. Click it for graphs, all disks and the top processes. Works with Linux servers, and uses the terminal's own connection (no extra login).

## 0.4.0

- Local terminals: PowerShell, Command Prompt, Git Bash and WSL distros in tabs, found automatically. Open one from the new monitor button at the top of the sidebar.
- Multi-exec: type into several terminals at once, SSH and local, and optionally see them side by side.

## 0.3.0

- SSH tunnels: local (-L), remote (-R) and dynamic SOCKS (-D) port forwarding through your saved SSH hosts. Manage them in the new Tunnels tab, with live connection and traffic counters. Tunnels reconnect by themselves if the connection drops, and can start automatically when Tusk opens.
- PostgreSQL over SSH: choose "Connect through" an SSH host in a connection's settings to reach databases that are only reachable from a server.

## 0.2.3

- Folders in the sidebar: group SSH hosts and PostgreSQL connections together, nest folders inside folders, and collapse them. Use the + button or right-click a folder to create one, then drag items onto it or right-click and choose "Move to…".
- Deleting a folder keeps its contents: they move up one level.

## 0.2.2

- SSH hosts can have a start folder (e.g. /home/New Webapp): the terminal and file panel open there when you connect. Set it in the host's settings, or right-click a folder in the file panel and choose "Use as start folder".

## 0.2.1

- After an update, Tusk now confirms it on the next launch ("Updated to Tusk 0.2.1").

## 0.2.0

- Automatic updates: Tusk checks for new versions and installs them with one click.
- SSH terminals: saved hosts, password, key file and SSH agent login, host key checks.
- SFTP file panel next to each terminal: follows your current folder, drag-and-drop upload, download, edit remote files.
- Works with PostgreSQL 9.6 and newer.
- Fixed fast typing in terminals sometimes arriving out of order.

## 0.1.0

- First version: PostgreSQL browser, data grid with editing, SQL editor, export.
