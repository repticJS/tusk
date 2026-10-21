//! Sharing a sidebar folder: its connections, SSH hosts and tunnels (and
//! subfolders) as a share code or `.tusk` file someone else can import.
//!
//! Passwords, SSH secrets and private key files are only included when the
//! sender asks, and then the whole bundle is encrypted with a passphrase
//! (Argon2id + XChaCha20-Poly1305). A share without secrets is just
//! compressed JSON.
//!
//! Format: `tusk-share-1:` + base64url(envelope JSON). The envelope shows the
//! folder name and item counts so an import can be previewed before the
//! passphrase is entered.

use crate::error::{AppError, AppResult};
use crate::ssh::SshConfig;
use crate::store::{ConnectionConfig, Folder, Store, TunnelConfig};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;

const PREFIX: &str = "tusk-share-1:";
/// Private key files larger than this aren't keys.
const MAX_KEY_FILE: u64 = 64 * 1024;

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub folders: usize,
    pub connections: usize,
    pub ssh_hosts: usize,
    pub tunnels: usize,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct KeyFile {
    pub name: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct Secrets {
    /// Database passwords by connection id.
    #[serde(default)]
    pub passwords: HashMap<String, String>,
    /// SSH passwords / key passphrases by host id.
    #[serde(default)]
    pub ssh: HashMap<String, String>,
    /// Private key files by host id.
    #[serde(default)]
    pub keys: HashMap<String, KeyFile>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Bundle {
    /// Folders in parent-before-child order; the first is the shared one.
    pub folders: Vec<Folder>,
    pub connections: Vec<ConnectionConfig>,
    pub ssh_hosts: Vec<SshConfig>,
    pub tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    pub secrets: Option<Secrets>,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u32,
    name: String,
    counts: Counts,
    /// base64 of the deflated bundle JSON, when not encrypted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enc: Option<Encrypted>,
}

#[derive(Serialize, Deserialize)]
struct Encrypted {
    kdf: String,
    /// Argon2id memory (KiB), iterations, lanes.
    m: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    /// Deflated bundle JSON, encrypted.
    ct: String,
}

/// What a share contains, before importing (and before any passphrase).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub name: String,
    pub counts: Counts,
    /// Includes passwords/keys and needs the passphrase.
    pub encrypted: bool,
}

/// What sharing a folder would include; shown before exporting.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    pub name: String,
    pub counts: Counts,
    /// SSH hosts from outside the folder that its connections go through.
    pub extra_hosts: Vec<String>,
    pub passwords: usize,
    pub ssh_secrets: usize,
    pub key_files: usize,
}

// ---- collecting ----

/// The folder, everything under it, and the SSH hosts its connections use.
pub fn collect(store: &Store, folder_id: &str) -> AppResult<(Bundle, Vec<String>)> {
    let all = store.list_folders();
    let root = all.iter().find(|f| f.id == folder_id).ok_or_else(|| AppError::msg("That folder no longer exists"))?;
    // Breadth-first, so parents come before their children.
    let mut folders = vec![Folder { parent_id: None, ..root.clone() }];
    let mut i = 0;
    while i < folders.len() {
        let id = folders[i].id.clone();
        folders.extend(all.iter().filter(|f| f.parent_id.as_deref() == Some(id.as_str())).cloned());
        i += 1;
    }
    let ids: HashSet<&str> = folders.iter().map(|f| f.id.as_str()).collect();
    let inside = |f: &Option<String>| f.as_deref().is_some_and(|f| ids.contains(f));

    let connections: Vec<ConnectionConfig> = store.list().into_iter().filter(|c| inside(&c.folder_id)).collect();
    let mut ssh_hosts: Vec<SshConfig> = store.list_ssh().into_iter().filter(|h| inside(&h.folder_id)).collect();
    // Connections that tunnel through a host kept elsewhere bring it along.
    let mut extra = Vec::new();
    for c in &connections {
        let Some(hid) = c.ssh_host_id.as_deref() else { continue };
        if ssh_hosts.iter().any(|h| h.id == hid) {
            continue;
        }
        if let Ok(h) = store.get_ssh(hid) {
            extra.push(h.name.clone());
            ssh_hosts.push(SshConfig { folder_id: Some(root.id.clone()), ..h });
        }
    }
    let host_ids: HashSet<&str> = ssh_hosts.iter().map(|h| h.id.as_str()).collect();
    let tunnels = store.list_tunnels().into_iter().filter(|t| host_ids.contains(t.host_id.as_str())).collect();
    for h in &mut ssh_hosts {
        h.key_path = h.key_path.as_deref().map(portable_path);
    }
    Ok((Bundle { folders, connections, ssh_hosts, tunnels, secrets: None }, extra))
}

/// "C:\Users\me\.ssh\id" → "~/.ssh/id", so it means the receiver's home.
fn portable_path(path: &str) -> String {
    let Some(home) = dirs::home_dir() else { return path.to_string() };
    let home = home.to_string_lossy().to_string();
    match path.strip_prefix(&home) {
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => format!("~/{}", rest[1..].replace('\\', "/")),
        _ => path.to_string(),
    }
}

pub fn counts(b: &Bundle) -> Counts {
    Counts { folders: b.folders.len(), connections: b.connections.len(), ssh_hosts: b.ssh_hosts.len(), tunnels: b.tunnels.len() }
}

/// Reads a private key file to embed; None when it isn't there or too big.
pub fn read_key_file(path: &str) -> Option<KeyFile> {
    let p = crate::ssh::expand_home(path);
    if std::fs::metadata(&p).ok()?.len() > MAX_KEY_FILE {
        return None;
    }
    let content = std::fs::read_to_string(&p).ok()?;
    let name = p.file_name()?.to_string_lossy().to_string();
    Some(KeyFile { name, content })
}

// ---- encoding ----

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

fn inflate(data: &[u8]) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(data)
        .take(16 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|_| AppError::msg("This share is damaged"))?;
    Ok(out)
}

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> AppResult<Key> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|e| AppError::msg(e.to_string()))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(key.into())
}

/// Turns a bundle into share text. Secrets require a passphrase.
pub fn encode(name: &str, bundle: &Bundle, passphrase: Option<&str>) -> AppResult<String> {
    let json = serde_json::to_vec(bundle)?;
    let packed = deflate(&json);
    let mut env = Envelope { v: 1, name: name.to_string(), counts: counts(bundle), data: None, enc: None };
    match passphrase {
        Some(pass) => {
            if pass.chars().count() < 8 {
                return Err(AppError::msg("Use a passphrase of at least 8 characters"));
            }
            let (m, t, p) = (47_104, 1, 1);
            let mut salt = [0u8; 16];
            let mut nonce = [0u8; 24];
            rand::rngs::OsRng.fill_bytes(&mut salt);
            rand::rngs::OsRng.fill_bytes(&mut nonce);
            let key = derive_key(pass, &salt, m, t, p)?;
            let ct = XChaCha20Poly1305::new(&key)
                .encrypt(XNonce::from_slice(&nonce), packed.as_slice())
                .map_err(|_| AppError::msg("Encryption failed"))?;
            env.enc = Some(Encrypted {
                kdf: "argon2id".into(),
                m,
                t,
                p,
                salt: STANDARD.encode(salt),
                nonce: STANDARD.encode(nonce),
                ct: STANDARD.encode(ct),
            });
        }
        None if bundle.secrets.is_some() => return Err(AppError::msg("Shares with passwords need a passphrase")),
        None => env.data = Some(STANDARD.encode(packed)),
    }
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&env)?)))
}

fn envelope(text: &str) -> AppResult<Envelope> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let body = compact
        .strip_prefix(PREFIX)
        .ok_or_else(|| AppError::msg("This isn't a Tusk share code. It should start with \"tusk-share-1:\"."))?;
    let raw = URL_SAFE_NO_PAD.decode(body).map_err(|_| AppError::msg("This share code is incomplete or damaged"))?;
    let env: Envelope = serde_json::from_slice(&raw).map_err(|_| AppError::msg("This share code is incomplete or damaged"))?;
    if env.v != 1 {
        return Err(AppError::msg("This share was made by a newer version of Tusk. Update Tusk to import it."));
    }
    Ok(env)
}

pub fn preview(text: &str) -> AppResult<Preview> {
    let env = envelope(text)?;
    Ok(Preview { name: env.name, counts: env.counts, encrypted: env.enc.is_some() })
}

pub fn decode(text: &str, passphrase: Option<&str>) -> AppResult<Bundle> {
    let env = envelope(text)?;
    let packed = match (env.enc, env.data) {
        (Some(e), _) => {
            let pass = passphrase
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::kind("PASSPHRASE_NEEDED", "Enter the passphrase for this share"))?;
            if e.kdf != "argon2id" {
                return Err(AppError::msg("Unknown encryption in this share"));
            }
            let bad = || AppError::msg("This share is damaged");
            let salt = STANDARD.decode(e.salt).map_err(|_| bad())?;
            let nonce = STANDARD.decode(e.nonce).map_err(|_| bad())?;
            let ct = STANDARD.decode(e.ct).map_err(|_| bad())?;
            if nonce.len() != 24 || e.m > 1_048_576 || e.t > 16 || e.p > 16 {
                return Err(bad());
            }
            let key = derive_key(pass, &salt, e.m, e.t, e.p)?;
            XChaCha20Poly1305::new(&key)
                .decrypt(XNonce::from_slice(&nonce), ct.as_slice())
                .map_err(|_| AppError::kind("PASSPHRASE_WRONG", "Wrong passphrase"))?
        }
        (None, Some(d)) => STANDARD.decode(d).map_err(|_| AppError::msg("This share is damaged"))?,
        (None, None) => return Err(AppError::msg("This share is empty")),
    };
    let json = inflate(&packed)?;
    serde_json::from_slice(&json).map_err(|_| AppError::msg("This share is damaged"))
}

// ---- importing ----

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub folder_id: String,
    pub name: String,
    pub counts: Counts,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A safe file name for a key written to disk.
fn key_file_name(host_id: &str, name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    format!("{host_id}-{}", if clean.is_empty() { "key".into() } else { clean })
}

/// Adds the bundle under `parent` (None: top level) with new ids, so it never
/// replaces anything. Secrets go to the credential store, key files to
/// `keys_dir`.
pub fn import(store: &mut Store, bundle: Bundle, parent: Option<String>, keys_dir: &Path) -> AppResult<ImportResult> {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut map = |old: &str| ids.entry(old.to_string()).or_insert_with(new_id).clone();
    let root_old = bundle.folders.first().ok_or_else(|| AppError::msg("This share has no folder"))?.id.clone();
    let root = map(&root_old);
    let counts = counts(&bundle);
    let name = bundle.folders[0].name.clone();

    for (i, f) in bundle.folders.iter().enumerate() {
        let parent_id = if i == 0 {
            parent.clone()
        } else {
            Some(f.parent_id.as_deref().map(&mut map).unwrap_or_else(|| root.clone()))
        };
        store.save_folder(Folder { id: map(&f.id), name: f.name.clone(), parent_id })?;
    }
    // Items whose folder isn't in the share land in its top folder.
    let folder_of = |f: &Option<String>, map: &mut dyn FnMut(&str) -> String| match f {
        Some(f) if bundle.folders.iter().any(|x| &x.id == f) => Some(map(f)),
        _ => Some(root.clone()),
    };
    let secrets = bundle.secrets.unwrap_or_default();

    for h in &bundle.ssh_hosts {
        let id = map(&h.id);
        let mut host = SshConfig { id: id.clone(), folder_id: folder_of(&h.folder_id, &mut map), ..h.clone() };
        if let Some(key) = secrets.keys.get(&h.id) {
            std::fs::create_dir_all(keys_dir)?;
            let path = keys_dir.join(key_file_name(&id, &key.name));
            write_private(&path, &key.content)?;
            host.key_path = Some(path.to_string_lossy().to_string());
        }
        let secret = secrets.ssh.get(&h.id);
        host.save_secret = secret.is_some() || (h.save_secret && h.auth != "password");
        store.upsert_ssh(host)?;
        if let Some(s) = secret {
            store.set_ssh_secret(&id, Some(s))?;
        }
    }
    for c in &bundle.connections {
        let id = map(&c.id);
        let password = secrets.passwords.get(&c.id);
        let conn = ConnectionConfig {
            id: id.clone(),
            folder_id: folder_of(&c.folder_id, &mut map),
            ssh_host_id: c.ssh_host_id.as_deref().map(&mut map),
            save_password: password.is_some() || c.save_password,
            ..c.clone()
        };
        store.upsert(conn)?;
        if let Some(p) = password {
            store.set_password(&id, Some(p))?;
        }
    }
    for t in &bundle.tunnels {
        let tunnel = TunnelConfig { id: map(&t.id), host_id: map(&t.host_id), ..t.clone() };
        store.save_tunnel(tunnel)?;
    }
    Ok(ImportResult { folder_id: root, name, counts })
}

/// Writes a private key readable only by the current user.
fn write_private(path: &Path, content: &str) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(content.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // The app's config folder is already private to the Windows user.
        std::fs::write(path, content)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::load(std::env::temp_dir().join(format!("tusk-share-{}", uuid::Uuid::new_v4())))
    }

    fn host(id: &str, folder: Option<&str>) -> SshConfig {
        SshConfig {
            id: id.into(),
            name: id.into(),
            host: "example.com".into(),
            port: 22,
            user: "deploy".into(),
            auth: "password".into(),
            key_path: None,
            color: None,
            save_secret: true,
            start_dir: None,
            folder_id: folder.map(Into::into),
        }
    }

    fn conn(id: &str, folder: Option<&str>, via: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: id.into(),
            host: "localhost".into(),
            port: 5432,
            user: "postgres".into(),
            database: "postgres".into(),
            ssl_mode: "prefer".into(),
            color: None,
            save_password: true,
            show_system_schemas: false,
            folder_id: folder.map(Into::into),
            ssh_host_id: via.map(Into::into),
        }
    }

    /// prod/ { api-db (via bastion, kept at top level), web/ { web-01 } }, plus unrelated items.
    fn sample() -> Store {
        let mut s = store();
        s.save_folder(Folder { id: "prod".into(), name: "Production".into(), parent_id: None }).unwrap();
        s.save_folder(Folder { id: "web".into(), name: "Web".into(), parent_id: Some("prod".into()) }).unwrap();
        s.save_folder(Folder { id: "other".into(), name: "Other".into(), parent_id: None }).unwrap();
        s.upsert_ssh(host("bastion", None)).unwrap();
        s.upsert_ssh(host("web-01", Some("web"))).unwrap();
        s.upsert_ssh(host("elsewhere", Some("other"))).unwrap();
        s.upsert(conn("api-db", Some("prod"), Some("bastion"))).unwrap();
        s.upsert(conn("other-db", Some("other"), None)).unwrap();
        s.save_tunnel(TunnelConfig {
            id: "t1".into(),
            name: "admin".into(),
            host_id: "web-01".into(),
            kind: "local".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 8080,
            target_host: "localhost".into(),
            target_port: 80,
            auto_start: false,
        })
        .unwrap();
        s.set_password("api-db", Some("db-secret")).unwrap();
        s.set_ssh_secret("web-01", Some("ssh-secret")).unwrap();
        s
    }

    #[test]
    fn collects_the_subtree_and_its_dependencies() {
        let s = sample();
        let (b, extra) = collect(&s, "prod").unwrap();
        assert_eq!(b.folders.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["prod", "web"]);
        assert_eq!(b.folders[0].parent_id, None);
        assert_eq!(b.connections.len(), 1);
        let hosts: HashSet<&str> = b.ssh_hosts.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(hosts, HashSet::from(["web-01", "bastion"]));
        assert_eq!(extra, ["bastion"]);
        assert_eq!(b.tunnels.len(), 1);
    }

    #[test]
    fn round_trips_without_secrets() {
        let s = sample();
        let (b, _) = collect(&s, "prod").unwrap();
        let text = encode("Production", &b, None).unwrap();
        assert!(text.starts_with(PREFIX));
        assert!(!text.contains("db-secret"));
        let p = preview(&format!("  {}\n", text)).unwrap();
        assert_eq!(p, Preview { name: "Production".into(), counts: counts(&b), encrypted: false });

        let mut dest = store();
        dest.save_folder(Folder { id: "team".into(), name: "Team".into(), parent_id: None }).unwrap();
        let r = import(&mut dest, decode(&text, None).unwrap(), Some("team".into()), &std::env::temp_dir()).unwrap();
        let folders = dest.list_folders();
        let top = folders.iter().find(|f| f.id == r.folder_id).unwrap();
        assert_eq!((top.name.as_str(), top.parent_id.as_deref()), ("Production", Some("team")));
        let web = folders.iter().find(|f| f.name == "Web").unwrap();
        assert_eq!(web.parent_id.as_deref(), Some(r.folder_id.as_str()));
        // New ids everywhere, links kept.
        let c = &dest.list()[0];
        assert_ne!(c.id, "api-db");
        let bastion = dest.list_ssh().into_iter().find(|h| h.name == "bastion").unwrap();
        assert_eq!(c.ssh_host_id.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(bastion.folder_id.as_deref(), Some(r.folder_id.as_str()));
        let web01 = dest.list_ssh().into_iter().find(|h| h.name == "web-01").unwrap();
        assert_eq!(web01.folder_id.as_deref(), Some(web.id.as_str()));
        assert_eq!(dest.list_tunnels()[0].host_id, web01.id);
        assert_eq!(dest.get_password(&c.id), None);
        // Importing again makes a second copy instead of overwriting.
        import(&mut dest, decode(&text, None).unwrap(), None, &std::env::temp_dir()).unwrap();
        assert_eq!(dest.list().len(), 2);
    }

    #[test]
    fn secrets_are_encrypted_and_need_the_passphrase() {
        let s = sample();
        let (mut b, _) = collect(&s, "prod").unwrap();
        let keys_dir = std::env::temp_dir().join(format!("tusk-keys-{}", uuid::Uuid::new_v4()));
        b.secrets = Some(Secrets {
            passwords: HashMap::from([("api-db".into(), "db-secret".into())]),
            ssh: HashMap::from([("web-01".into(), "ssh-secret".into())]),
            keys: HashMap::from([(
                "bastion".into(),
                KeyFile { name: "id_ed25519".into(), content: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n".into() },
            )]),
        });
        assert!(encode("Production", &b, None).is_err());
        assert!(encode("Production", &b, Some("short")).is_err());
        let text = encode("Production", &b, Some("correct horse")).unwrap();
        assert!(preview(&text).unwrap().encrypted);
        assert_eq!(decode(&text, None).unwrap_err().kind.as_deref(), Some("PASSPHRASE_NEEDED"));
        assert_eq!(decode(&text, Some("wrong horse")).unwrap_err().kind.as_deref(), Some("PASSPHRASE_WRONG"));

        let mut dest = store();
        import(&mut dest, decode(&text, Some("correct horse")).unwrap(), None, &keys_dir).unwrap();
        let c = &dest.list()[0];
        assert_eq!(dest.get_password(&c.id).as_deref(), Some("db-secret"));
        let web01 = dest.list_ssh().into_iter().find(|h| h.name == "web-01").unwrap();
        assert_eq!(dest.get_ssh_secret(&web01.id).as_deref(), Some("ssh-secret"));
        let bastion = dest.list_ssh().into_iter().find(|h| h.name == "bastion").unwrap();
        let key_path = bastion.key_path.unwrap();
        assert!(key_path.starts_with(keys_dir.to_string_lossy().as_ref()));
        assert!(std::fs::read_to_string(&key_path).unwrap().starts_with("-----BEGIN"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(preview("hello").is_err());
        assert!(preview("tusk-share-1:!!!").is_err());
        assert!(preview(&format!("tusk-share-1:{}", URL_SAFE_NO_PAD.encode(br#"{"v":2,"name":"x","counts":{"folders":0,"connections":0,"sshHosts":0,"tunnels":0}}"#)))
            .unwrap_err()
            .message
            .contains("newer version"));
    }

    #[test]
    fn key_paths_become_home_relative() {
        let home = dirs::home_dir().unwrap();
        let p = home.join(".ssh").join("id_ed25519");
        assert_eq!(portable_path(&p.to_string_lossy()), "~/.ssh/id_ed25519");
        assert_eq!(portable_path("/opt/keys/k"), "/opt/keys/k");
        assert_eq!(key_file_name("h1", "my key (1).pem"), "h1-my_key__1_.pem");
    }
}
