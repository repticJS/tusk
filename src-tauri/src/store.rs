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
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    connections: Vec<ConnectionConfig>,
    #[serde(default)]
    ssh_hosts: Vec<SshConfig>,
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

    pub fn delete_ssh(&mut self, id: &str) -> AppResult<()> {
        self.file.ssh_hosts.retain(|c| c.id != id);
        self.save()?;
        secret::delete(&self.dir, &ssh_secret_key(id));
        Ok(())
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
