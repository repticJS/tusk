//! Saved connections. Connection details live in a JSON file in the app's
//! config directory; passwords go to the OS credential store (Windows
//! Credential Manager). On other platforms, used only for development, they
//! fall back to a separate JSON file.

use crate::error::{AppError, AppResult};
use crate::ssh::SshConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    /// disable | prefer | require | verify-full
    pub ssl_mode: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub save_password: bool,
    /// Show pg_catalog / information_schema in the tree.
    #[serde(default)]
    pub show_system_schemas: bool,
    /// Sidebar folder; None is the top level.
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Reach the server through this saved SSH host. Host and port are then
    /// as seen from the SSH server (often localhost:5432).
    #[serde(default)]
    pub ssh_host_id: Option<String>,
}

/// A saved SSH port forward.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub name: String,
    pub host_id: String,
    /// local (-L) | remote (-R) | dynamic (-D, SOCKS)
    pub kind: String,
    /// Address to listen on: on this PC for local/dynamic, on the server for remote.
    pub bind_host: String,
    pub bind_port: u16,
    /// Where connections go: from the server for local, from this PC for remote.
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    /// Start when Tusk starts.
    #[serde(default)]
    pub auto_start: bool,
}

/// A sidebar folder. Folders nest through parent_id and can hold both
/// database connections and SSH hosts.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// Something that can be moved between folders.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    /// connection | ssh | folder
    pub kind: String,
    pub id: String,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    connections: Vec<ConnectionConfig>,
    #[serde(default)]
    ssh_hosts: Vec<SshConfig>,
    #[serde(default)]
    folders: Vec<Folder>,
    #[serde(default)]
    tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    monitor: MonitorSettings,
    #[serde(default)]
    commands: Vec<SavedCommand>,
}

/// A named shell script to run on one or more SSH hosts (deploys, restarts…).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub script: String,
    pub host_ids: Vec<String>,
    /// Stop at the first failing line (`set -e`).
    #[serde(default = "yes")]
    pub stop_on_error: bool,
    /// Ask before running.
    #[serde(default = "yes")]
    pub confirm: bool,
}

fn yes() -> bool {
    true
}

/// Background checks of SSH hosts.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorSettings {
    /// Hosts being watched.
    pub hosts: Vec<String>,
    pub interval_secs: u32,
    /// Disk use (%) that raises an alert.
    pub disk_threshold: u8,
    /// Show desktop notifications (alerts are listed in Tusk either way).
    pub notify: bool,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        MonitorSettings { hosts: Vec::new(), interval_secs: 300, disk_threshold: 90, notify: true }
    }
}

pub struct Store {
    dir: PathBuf,
    file: StoreFile,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("connections.json");
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store { dir, file }
    }

    fn save(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_string_pretty(&self.file)?;
        std::fs::write(self.dir.join("connections.json"), json)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.file.connections.clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.file
            .connections
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown connection {id}")))
    }

    pub fn upsert(&mut self, config: ConnectionConfig) -> AppResult<()> {
        match self.file.connections.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config,
            None => self.file.connections.push(config),
        }
        self.save()
    }

    pub fn delete(&mut self, id: &str) -> AppResult<()> {
        self.file.connections.retain(|c| c.id != id);
        self.save()?;
        secret::delete(&self.dir, id);
        Ok(())
    }

    pub fn reorder(&mut self, ids: &[String]) -> AppResult<()> {
        self.file
            .connections
            .sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
        self.save()
    }

    pub fn list_ssh(&self) -> Vec<SshConfig> {
        self.file.ssh_hosts.clone()
    }

    pub fn get_ssh(&self, id: &str) -> AppResult<SshConfig> {
        self.file
            .ssh_hosts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown SSH host {id}")))
    }

    pub fn upsert_ssh(&mut self, config: SshConfig) -> AppResult<()> {
        match self.file.ssh_hosts.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config,
            None => self.file.ssh_hosts.push(config),
        }
        self.save()
    }

    /// Deletes an SSH host and its tunnels. Refused while a database
    /// connection goes through it, since that connection would silently start
    /// connecting directly instead.
    pub fn delete_ssh(&mut self, id: &str) -> AppResult<()> {
        let users: Vec<&str> = self
            .file
            .connections
            .iter()
            .filter(|c| c.ssh_host_id.as_deref() == Some(id))
            .map(|c| c.name.as_str())
            .collect();
        if !users.is_empty() {
            return Err(AppError::msg(format!(
                "This SSH host is used by {}. Change {} to connect another way first.",
                users.join(", "),
                if users.len() == 1 { "that connection" } else { "those connections" }
            )));
        }
        self.file.ssh_hosts.retain(|c| c.id != id);
        self.file.tunnels.retain(|t| t.host_id != id);
        for c in &mut self.file.commands {
            c.host_ids.retain(|h| h != id);
        }
        self.file.commands.retain(|c| !c.host_ids.is_empty());
        self.save()?;
        secret::delete(&self.dir, &ssh_secret_key(id));
        Ok(())
    }

    // ---- saved commands ----

    pub fn list_commands(&self) -> Vec<SavedCommand> {
        self.file.commands.clone()
    }

    pub fn save_command(&mut self, c: SavedCommand) -> AppResult<()> {
        if c.name.trim().is_empty() {
            return Err(AppError::msg("Give the command a name"));
        }
        if c.script.trim().is_empty() {
            return Err(AppError::msg("Enter the commands to run"));
        }
        if c.host_ids.is_empty() {
            return Err(AppError::msg("Pick at least one server"));
        }
        for h in &c.host_ids {
            self.get_ssh(h)?;
        }
        match self.file.commands.iter_mut().find(|x| x.id == c.id) {
            Some(existing) => *existing = c,
            None => self.file.commands.push(c),
        }
        self.save()
    }

    pub fn delete_command(&mut self, id: &str) -> AppResult<()> {
        self.file.commands.retain(|c| c.id != id);
        self.save()
    }

    // ---- monitoring ----

    pub fn monitor(&self) -> MonitorSettings {
        let mut m = self.file.monitor.clone();
        // Forget hosts that were deleted.
        m.hosts.retain(|h| self.file.ssh_hosts.iter().any(|x| &x.id == h));
        m
    }

    pub fn set_monitor(&mut self, mut m: MonitorSettings) -> AppResult<()> {
        m.interval_secs = m.interval_secs.clamp(60, 24 * 3600);
        m.disk_threshold = m.disk_threshold.clamp(50, 99);
        m.hosts.dedup();
        self.file.monitor = m;
        self.save()
    }

    // ---- tunnels ----

    pub fn list_tunnels(&self) -> Vec<TunnelConfig> {
        self.file.tunnels.clone()
    }

    pub fn get_tunnel(&self, id: &str) -> AppResult<TunnelConfig> {
        self.file
            .tunnels
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown tunnel {id}")))
    }

    pub fn save_tunnel(&mut self, tunnel: TunnelConfig) -> AppResult<()> {
        if tunnel.name.trim().is_empty() {
            return Err(AppError::msg("Give the tunnel a name"));
        }
        if !matches!(tunnel.kind.as_str(), "local" | "remote" | "dynamic") {
            return Err(AppError::msg(format!("Unknown tunnel type {}", tunnel.kind)));
        }
        if tunnel.kind != "dynamic" && (tunnel.target_host.trim().is_empty() || tunnel.target_port == 0) {
            return Err(AppError::msg("Enter the destination host and port"));
        }
        if tunnel.kind == "remote" && tunnel.bind_port == 0 {
            return Err(AppError::msg("Enter the port to open on the server"));
        }
        self.get_ssh(&tunnel.host_id)?;
        match self.file.tunnels.iter_mut().find(|t| t.id == tunnel.id) {
            Some(existing) => *existing = tunnel,
            None => self.file.tunnels.push(tunnel),
        }
        self.save()
    }

    pub fn delete_tunnel(&mut self, id: &str) -> AppResult<()> {
        self.file.tunnels.retain(|t| t.id != id);
        self.save()
    }

    // ---- folders ----

    pub fn list_folders(&self) -> Vec<Folder> {
        self.file.folders.clone()
    }

    /// True if `folder` is `ancestor` or sits somewhere inside it.
    fn is_within(&self, folder: Option<&str>, ancestor: &str) -> bool {
        let mut current = folder.map(str::to_string);
        // The hop limit guards against a corrupted file with a cycle.
        for _ in 0..=self.file.folders.len() {
            match current {
                None => return false,
                Some(id) if id == ancestor => return true,
                Some(id) => current = self.file.folders.iter().find(|f| f.id == id).and_then(|f| f.parent_id.clone()),
            }
        }
        true
    }

    fn check_folder(&self, folder_id: Option<&str>) -> AppResult<()> {
        match folder_id {
            Some(id) if !self.file.folders.iter().any(|f| f.id == id) => Err(AppError::msg("That folder no longer exists")),
            _ => Ok(()),
        }
    }

    pub fn save_folder(&mut self, folder: Folder) -> AppResult<()> {
        if folder.name.trim().is_empty() {
            return Err(AppError::msg("Folder name can't be empty"));
        }
        self.check_folder(folder.parent_id.as_deref())?;
        if self.is_within(folder.parent_id.as_deref(), &folder.id) {
            return Err(AppError::msg("A folder can't be moved inside itself"));
        }
        match self.file.folders.iter_mut().find(|f| f.id == folder.id) {
            Some(existing) => *existing = folder,
            None => self.file.folders.push(folder),
        }
        self.save()
    }

    /// Deletes a folder. Its contents (subfolders, connections, hosts) move
    /// up to the folder's parent, so nothing else is lost.
    pub fn delete_folder(&mut self, id: &str) -> AppResult<()> {
        let parent = self.file.folders.iter().find(|f| f.id == id).and_then(|f| f.parent_id.clone());
        for f in self.file.folders.iter_mut().filter(|f| f.parent_id.as_deref() == Some(id)) {
            f.parent_id = parent.clone();
        }
        for c in self.file.connections.iter_mut().filter(|c| c.folder_id.as_deref() == Some(id)) {
            c.folder_id = parent.clone();
        }
        for h in self.file.ssh_hosts.iter_mut().filter(|h| h.folder_id.as_deref() == Some(id)) {
            h.folder_id = parent.clone();
        }
        self.file.folders.retain(|f| f.id != id);
        self.save()
    }

    /// Moves connections, hosts and folders into `folder_id` (None = top level).
    pub fn move_items(&mut self, items: &[ItemRef], folder_id: Option<String>) -> AppResult<()> {
        self.check_folder(folder_id.as_deref())?;
        for item in items {
            match item.kind.as_str() {
                "connection" => {
                    if let Some(c) = self.file.connections.iter_mut().find(|c| c.id == item.id) {
                        c.folder_id = folder_id.clone();
                    }
                }
                "ssh" => {
                    if let Some(h) = self.file.ssh_hosts.iter_mut().find(|h| h.id == item.id) {
                        h.folder_id = folder_id.clone();
                    }
                }
                "folder" => {
                    if self.is_within(folder_id.as_deref(), &item.id) {
                        return Err(AppError::msg("A folder can't be moved inside itself"));
                    }
                    if let Some(f) = self.file.folders.iter_mut().find(|f| f.id == item.id) {
                        f.parent_id = folder_id.clone();
                    }
                }
                other => return Err(AppError::msg(format!("Unknown item kind {other}"))),
            }
        }
        self.save()
    }

    /// Where private keys from imported shares are kept.
    pub fn keys_dir(&self) -> PathBuf {
        self.dir.join("keys")
    }

    pub fn known_hosts_path(&self) -> std::path::PathBuf {
        self.dir.join("known_hosts")
    }

    pub fn get_ssh_secret(&self, id: &str) -> Option<String> {
        secret::get(&self.dir, &ssh_secret_key(id))
    }

    pub fn set_ssh_secret(&self, id: &str, secret: Option<&str>) -> AppResult<()> {
        self.set_password(&ssh_secret_key(id), secret)
    }

    pub fn get_password(&self, id: &str) -> Option<String> {
        secret::get(&self.dir, id)
    }

    pub fn set_password(&self, id: &str, password: Option<&str>) -> AppResult<()> {
        match password {
            Some(p) => secret::set(&self.dir, id, p),
            None => {
                secret::delete(&self.dir, id);
                Ok(())
            }
        }
    }
}

/// SSH secrets (password or key passphrase) share the credential store with
/// database passwords, under a prefixed name.
fn ssh_secret_key(id: &str) -> String {
    format!("ssh:{id}")
}

#[cfg(windows)]
mod secret {
    use crate::error::{AppError, AppResult};
    use std::path::Path;

    const SERVICE: &str = "dev.tusk.app";

    fn entry(id: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, id).ok()
    }

    pub fn get(_dir: &Path, id: &str) -> Option<String> {
        entry(id)?.get_password().ok()
    }

    pub fn set(_dir: &Path, id: &str, password: &str) -> AppResult<()> {
        entry(id)
            .ok_or_else(|| AppError::msg("Could not open the Windows credential store"))?
            .set_password(password)
            .map_err(|e| AppError::msg(format!("Could not save password: {e}")))
    }

    pub fn delete(_dir: &Path, id: &str) {
        if let Some(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(not(windows))]
mod secret {
    use crate::error::AppResult;
    use std::collections::HashMap;
    use std::path::Path;

    fn read(dir: &Path) -> HashMap<String, String> {
        std::fs::read_to_string(dir.join("passwords.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write(dir: &Path, map: &HashMap<String, String>) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join("passwords.json"), serde_json::to_string(map)?)?;
        Ok(())
    }

    pub fn get(dir: &Path, id: &str) -> Option<String> {
        read(dir).get(id).cloned()
    }

    pub fn set(dir: &Path, id: &str, password: &str) -> AppResult<()> {
        let mut map = read(dir);
        map.insert(id.to_string(), password.to_string());
        write(dir, &map)
    }

    pub fn delete(dir: &Path, id: &str) {
        let mut map = read(dir);
        if map.remove(id).is_some() {
            let _ = write(dir, &map);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("tusk-test-{}", uuid::Uuid::new_v4()));
        Store::load(dir)
    }

    fn folder(id: &str, parent: Option<&str>) -> Folder {
        Folder { id: id.into(), name: id.into(), parent_id: parent.map(Into::into) }
    }

    fn conn(id: &str, folder: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: id.into(),
            host: "localhost".into(),
            port: 5432,
            user: "postgres".into(),
            database: "postgres".into(),
            ssl_mode: "prefer".into(),
            color: None,
            save_password: false,
            show_system_schemas: false,
            folder_id: folder.map(Into::into),
            ssh_host_id: None,
        }
    }

    fn host(id: &str) -> SshConfig {
        SshConfig {
            id: id.into(),
            name: id.into(),
            host: "example.com".into(),
            port: 22,
            user: "me".into(),
            auth: "agent".into(),
            key_path: None,
            color: None,
            save_secret: false,
            start_dir: None,
            folder_id: None,
        }
    }

    fn tunnel(id: &str, host_id: &str) -> TunnelConfig {
        TunnelConfig {
            id: id.into(),
            name: id.into(),
            host_id: host_id.into(),
            kind: "local".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 8080,
            target_host: "localhost".into(),
            target_port: 80,
            auto_start: false,
        }
    }

    #[test]
    fn commands_follow_their_hosts() {
        let mut s = store();
        s.upsert_ssh(host("a")).unwrap();
        s.upsert_ssh(host("b")).unwrap();
        let cmd = |id: &str, hosts: &[&str]| SavedCommand {
            id: id.into(),
            name: id.into(),
            script: "uptime".into(),
            host_ids: hosts.iter().map(|h| h.to_string()).collect(),
            stop_on_error: true,
            confirm: true,
        };
        assert!(s.save_command(cmd("bad", &["missing"])).is_err());
        assert!(s.save_command(cmd("none", &[])).is_err());
        s.save_command(cmd("both", &["a", "b"])).unwrap();
        s.save_command(cmd("only-b", &["b"])).unwrap();
        s.delete_ssh("b").unwrap();
        let left = s.list_commands();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].host_ids, ["a"]);
    }

    #[test]
    fn ssh_hosts_in_use_by_a_database_are_kept() {
        let mut s = store();
        s.upsert_ssh(host("bastion")).unwrap();
        s.save_tunnel(tunnel("web", "bastion")).unwrap();
        s.upsert(ConnectionConfig { ssh_host_id: Some("bastion".into()), ..conn("db", None) }).unwrap();
        let err = s.delete_ssh("bastion").unwrap_err();
        assert!(err.message.contains("used by db"), "{}", err.message);
        // Once nothing goes through it, it and its tunnels are deleted.
        s.upsert(conn("db", None)).unwrap();
        s.delete_ssh("bastion").unwrap();
        assert!(s.list_tunnels().is_empty());
    }

    #[test]
    fn tunnels_are_validated() {
        let mut s = store();
        s.upsert_ssh(host("h")).unwrap();
        assert!(s.save_tunnel(TunnelConfig { target_port: 0, ..tunnel("t", "h") }).is_err());
        assert!(s.save_tunnel(tunnel("t", "missing")).is_err());
        assert!(s.save_tunnel(TunnelConfig { kind: "dynamic".into(), target_host: "".into(), ..tunnel("t", "h") }).is_ok());
    }

    #[test]
    fn folders_cannot_contain_themselves() {
        let mut s = store();
        s.save_folder(folder("a", None)).unwrap();
        s.save_folder(folder("b", Some("a"))).unwrap();
        s.save_folder(folder("c", Some("b"))).unwrap();
        let into_child = s.move_items(&[ItemRef { kind: "folder".into(), id: "a".into() }], Some("c".into()));
        assert!(into_child.is_err());
        assert!(s.save_folder(folder("a", Some("a"))).is_err());
        // Moving to an unrelated place is fine.
        s.move_items(&[ItemRef { kind: "folder".into(), id: "c".into() }], None).unwrap();
        assert_eq!(s.list_folders().iter().find(|f| f.id == "c").unwrap().parent_id, None);
    }

    #[test]
    fn deleting_a_folder_moves_its_contents_up() {
        let mut s = store();
        s.save_folder(folder("outer", None)).unwrap();
        s.save_folder(folder("inner", Some("outer"))).unwrap();
        s.save_folder(folder("deep", Some("inner"))).unwrap();
        s.upsert(conn("db", Some("inner"))).unwrap();
        s.delete_folder("inner").unwrap();
        assert!(s.list_folders().iter().all(|f| f.id != "inner"));
        assert_eq!(s.list_folders().iter().find(|f| f.id == "deep").unwrap().parent_id.as_deref(), Some("outer"));
        assert_eq!(s.get("db").unwrap().folder_id.as_deref(), Some("outer"));
    }

    #[test]
    fn moving_into_missing_folder_fails() {
        let mut s = store();
        s.upsert(conn("db", None)).unwrap();
        let r = s.move_items(&[ItemRef { kind: "connection".into(), id: "db".into() }], Some("nope".into()));
        assert!(r.is_err());
    }
}
