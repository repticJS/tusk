# Tusk

A fast, modern desktop client for PostgreSQL. Built with Tauri 2 (Rust) and React.

- **Small and quick.** Native Rust backend, about a 10 MB install, opens instantly.
- **Data grid that scales.** Canvas-rendered, loads rows as you scroll, handles 100k+ row results smoothly.
- **Exact values.** Results arrive in Postgres's own text format, so `numeric`, `jsonb`, arrays, ranges, PostGIS and custom types display exactly as the server sends them.
- **Safe editing.** Edit cells, add and delete rows, then review the generated SQL before it runs. All changes commit in one transaction. Only tables with a primary key can be edited.
- **Proper SQL editor.** Postgres syntax, autocomplete from your schema, run the statement under the cursor, errors underlined at the exact position along with Postgres's hint.
- **Isolated tabs.** Each query tab has its own connection, so a long query or open transaction never blocks the rest of the app. Running transactions are clearly flagged, with Commit and Rollback buttons.

## Features

| Area | What's there |
|---|---|
| Connections | Saved connections, paste a `postgres://` URL, test button, SSL modes, color tags (shown on tabs), passwords in Windows Credential Manager |
| Browser | Databases → schemas → tables, views, materialized views, functions; filter box; row estimates |
| Table view | Data, Structure (columns, indexes, constraints, triggers), generated DDL; WHERE filter; click a header to sort; exact or estimated counts |
| Editing | Inline and value-panel editing, NULL handling, add and delete rows, SQL preview, single-transaction commit |
| Query editor | Multiple statements, run at cursor or selection or all, cancel, EXPLAIN / EXPLAIN ANALYZE, notices, row limit, open and save `.sql` files |
| Results | Multiple result sets, messages log, value panel with pretty JSON, find (Ctrl+F), copy cells |
| Export | CSV (Excel-friendly), JSON, TSV to clipboard, INSERT statements |
| Everywhere | Command palette (Ctrl+P), query history, dark and light theme, tabs restored on restart |

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

**Easiest:** push this repo to GitHub. The included workflow (`.github/workflows/build.yml`) builds a Windows installer on every push. Download it from the run's **Artifacts**. Pushing a tag like `v0.1.0` creates a draft GitHub Release with the installers attached.

**Build it yourself on Windows:**

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
  store.rs     saved connections (JSON in %APPDATA%\dev.tusk.app) + Credential Manager passwords
  lib.rs       Tauri commands
src/
  lib/api.ts   typed wrappers around the Tauri commands, password prompt retry
  lib/meta.ts  catalog introspection queries, DDL generation
  lib/sql.ts   statement splitter, quoting, formatting, export helpers
  store.ts     app state (zustand)
  components/  Sidebar, QueryTab, TableTab, DataGrid (Glide), SqlEditor (CodeMirror), dialogs
```

## Roadmap ideas

- SSH tunnels
- Visual EXPLAIN plan viewer
- ER diagram
- Backup / restore via `pg_dump` / `pg_restore`
- Roles and permissions UI
- Auto-update via the Tauri updater
