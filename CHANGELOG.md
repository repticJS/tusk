# Changelog

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
