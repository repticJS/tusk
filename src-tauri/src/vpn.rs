//! A FortiGate SSL VPN for one remote desktop, run inside Tusk.
//!
//! FortiClient puts the whole PC on the company network. Tusk instead signs
//! in by itself and carries only one desktop's connection through the VPN:
//!
//! - Sign-in: single sign-on (SAML) in the user's own browser. FortiGate
//!   sends the browser back to `http://127.0.0.1:8020/?id=…` (where
//!   FortiClient listens too); Tusk trades that id for the session cookie.
//! - Tunnel: PPP inside TLS (`GET /remote/sslvpn-tunnel`), each PPP frame
//!   behind a 6-byte header.
//! - Network: a small TCP/IP stack (smoltcp) inside Tusk, so there is no
//!   network adapter, no admin rights and no change to the PC's routes.

use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use smoltcp::iface::{Config, Interface, PollResult, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::{dns, tcp};
use smoltcp::wire::{DnsQueryType, HardwareAddress, IpAddress, IpCidr};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use suppaftp::tokio_rustls::{client::TlsStream, rustls, TlsConnector};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};

/// Where FortiGate sends the browser after single sign-on (its default
/// `saml-redirect-port`, the one FortiClient uses).
const SAML_PORT: u16 = 8020;
/// How long the user has to finish signing in.
const SIGN_IN_WAIT: Duration = Duration::from_secs(300);
/// What FortiGate expects of a client.
const USER_AGENT: &str = "Mozilla/5.0 SV1";
/// Our MRU, as openfortivpn and FortiClient use.
const MRU: u16 = 1354;
const TCP_BUFFER: usize = 256 * 1024;

// ---- the gateway: HTTPS with the user's choice of certificate ----

/// "vpn.example.com:10443" (an https:// prefix or a path is ignored).
pub fn parse_gateway(s: &str) -> AppResult<(String, u16)> {
    let s = s.trim();
    let s = s.strip_prefix("https://").unwrap_or(s);
    let s = s.split('/').next().unwrap_or("").trim();
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| AppError::msg(format!("\"{p}\" isn't a port number")))?),
        None => (s, 443),
    };
    if host.is_empty() {
        return Err(AppError::msg("Enter the VPN gateway's address, like vpn.example.com:10443"));
    }
    Ok((host.to_lowercase(), port))
}

pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Accepts certificates the PC trusts, and otherwise only the one the user
/// accepted for this gateway (trust on first use, like SSH host keys).
struct GatewayVerifier {
    platform: rustls_platform_verifier::Verifier,
    provider: Arc<rustls::crypto::CryptoProvider>,
    pinned: Vec<String>,
    /// The certificate seen, and whether the PC trusts it.
    seen: Arc<Mutex<Option<(String, bool)>>>,
}

impl std::fmt::Debug for GatewayVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GatewayVerifier")
    }
}

impl rustls::client::danger::ServerCertVerifier for GatewayVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        let verdict = self.platform.verify_server_cert(end_entity, intermediates, server_name, ocsp, now);
        *self.seen.lock().unwrap() = Some((fp.clone(), verdict.is_ok()));
        match verdict {
            Ok(v) => Ok(v),
            Err(_) if self.pinned.contains(&fp) => Ok(rustls::client::danger::ServerCertVerified::assertion()),
            Err(e) => Err(e),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn known_hosts(path: &Path) -> HashMap<String, String> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

struct Gateway {
    host: String,
    port: u16,
    tls: TlsConnector,
    seen: Arc<Mutex<Option<(String, bool)>>>,
    known_path: PathBuf,
    /// The certificate the user just accepted, saved once it's seen.
    accept: Option<String>,
}

#[derive(Debug, Default)]
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// The session cookie FortiGate set (the last one that isn't empty).
    fn cookie(&self) -> Option<String> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, v)| v.strip_prefix("SVPNCOOKIE="))
            .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
            .rfind(|v| !v.is_empty())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Parses an HTTP/1.1 response read to its end.
fn parse_response(raw: &[u8]) -> AppResult<Response> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| AppError::msg("The VPN gateway sent an incomplete answer"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::msg("The VPN gateway's answer isn't HTTP"))?;
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let mut r = Response { status, headers, body: raw[split + 4..].to_vec() };
    if r.header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        r.body = dechunk(&r.body);
    } else if let Some(n) = r.header("content-length").and_then(|v| v.parse::<usize>().ok()) {
        r.body.truncate(n);
    }
    Ok(r)
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(eol) = b.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&b[..eol]).ok().and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok());
        let Some(size) = size.filter(|s| *s > 0) else { break };
        let start = eol + 2;
        let end = (start + size).min(b.len());
        out.extend_from_slice(&b[start..end]);
        b = &b[(end + 2).min(b.len())..];
    }
    out
}

impl Gateway {
    fn new(host: String, port: u16, known_path: PathBuf, accept: Option<&str>) -> AppResult<Self> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let seen = Arc::new(Mutex::new(None));
        let mut pinned: Vec<String> = known_hosts(&known_path).get(&Self::key_for(&host, port)).cloned().into_iter().collect();
        pinned.extend(accept.map(str::to_string));
        let verifier = GatewayVerifier {
            platform: rustls_platform_verifier::Verifier::new(provider.clone()).map_err(|e| AppError::msg(e.to_string()))?,
            provider: provider.clone(),
            pinned,
            seen: seen.clone(),
        };
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| AppError::msg(e.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(Gateway { host, port, tls: TlsConnector::from(Arc::new(config)), seen, known_path, accept: accept.map(str::to_string) })
    }

    fn key_for(host: &str, port: u16) -> String {
        format!("vpn:{host}:{port}")
    }

    fn addr(&self) -> String {
        if self.port == 443 { self.host.clone() } else { format!("{}:{}", self.host, self.port) }
    }

    /// A TLS connection, or an RDP_CERT_* error the tab asks the user about.
    async fn connect(&self) -> AppResult<TlsStream<TcpStream>> {
        let target = format!("{}:{}", self.host, self.port);
        let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((self.host.as_str(), self.port)))
            .await
            .map_err(|_| AppError::msg(format!("Timed out connecting to the VPN gateway {target}")))?
            .map_err(|e| AppError::msg(format!("Could not reach the VPN gateway {target}: {e}")))?;
        let _ = tcp.set_nodelay(true);
        let name = rustls::pki_types::ServerName::try_from(self.host.clone()).map_err(|e| AppError::msg(e.to_string()))?;
        match self.tls.connect(name, tcp).await {
            Ok(s) => {
                // Remember a certificate the user accepted.
                if let Some((fp, false)) = self.seen.lock().unwrap().clone() {
                    let key = Self::key_for(&self.host, self.port);
                    let mut known = known_hosts(&self.known_path);
                    if known.get(&key) != Some(&fp) && self.accept.as_deref() == Some(fp.as_str()) {
                        known.insert(key, fp);
                        std::fs::write(&self.known_path, serde_json::to_vec_pretty(&known)?)?;
                    }
                }
                Ok(s)
            }
            Err(e) => {
                let bad_cert = e.get_ref().and_then(|x| x.downcast_ref::<rustls::Error>()).is_some_and(|x| matches!(x, rustls::Error::InvalidCertificate(_)));
                let seen = self.seen.lock().unwrap().clone();
                match seen {
                    Some((fp, false)) if bad_cert => {
                        let changed = known_hosts(&self.known_path).contains_key(&Self::key_for(&self.host, self.port));
                        let (kind, message) = if changed {
                            ("RDP_CERT_CHANGED", format!("The certificate of the VPN gateway {target} has changed since you last connected. Someone could be intercepting the connection, or the gateway got a new certificate. Check with your IT team before trusting it."))
                        } else {
                            ("RDP_CERT_UNKNOWN", format!("The VPN gateway {target} uses a certificate this PC doesn't trust. Check with your IT team that this is the gateway's certificate before trusting it."))
                        };
                        let mut err = AppError::kind(kind, message);
                        err.detail = Some(format!("VPN gateway {target}\nSHA-256 {fp}"));
                        err.hint = Some(fp);
                        Err(err)
                    }
                    _ => Err(AppError::msg(format!("Secure connection to the VPN gateway {target} failed: {e}"))),
                }
            }
        }
    }

    /// One HTTPS request on a connection of its own.
    async fn request(&self, method: &str, path: &str, cookie: Option<&str>) -> AppResult<Response> {
        let mut s = self.connect().await?;
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nUser-Agent: {USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n", self.addr());
        if let Some(c) = cookie {
            req.push_str(&format!("Cookie: SVPNCOOKIE={c}\r\n"));
        }
        if method == "POST" {
            req.push_str("Content-Length: 0\r\n");
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).await?;
        s.flush().await?;
        let mut raw = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(30), async {
            let mut buf = [0u8; 16384];
            loop {
                match s.read(&mut buf).await {
                    Ok(0) => break Ok(()),
                    Ok(n) => raw.extend_from_slice(&buf[..n]),
                    // Many servers close without saying goodbye.
                    Err(_) if !raw.is_empty() => break Ok(()),
                    Err(e) => break Err(e),
                }
            }
        })
        .await;
        match read {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(AppError::msg(format!("The VPN gateway closed the connection: {e}"))),
            Err(_) if !raw.is_empty() => {}
            Err(_) => return Err(AppError::msg("The VPN gateway didn't answer")),
        }
        parse_response(&raw)
    }
}

// ---- single sign-on ----

/// The `id` FortiGate sends the browser back with, from a request line
/// like `GET /?id=abc HTTP/1.1`.
fn saml_id(request_line: &str) -> Option<String> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|kv| kv.strip_prefix("id=")).filter(|v| !v.is_empty()).map(str::to_string)
}

const SIGNED_IN_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Tusk</title>\
<body style=\"font:15px system-ui;margin:4em auto;max-width:28em;text-align:center\">\
<h2>Signed in to the VPN</h2><p>You can close this tab and go back to Tusk.</p>";

/// Waits for the browser to come back from single sign-on.
async fn wait_for_sign_in(listener: tokio::net::TcpListener) -> AppResult<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut head = Vec::new();
        let mut buf = [0u8; 4096];
        let got = tokio::time::timeout(Duration::from_secs(10), async {
            while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 16384 {
                match sock.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&buf[..n]),
                }
            }
        })
        .await;
        if got.is_err() {
            continue;
        }
        let line = String::from_utf8_lossy(&head).lines().next().unwrap_or("").to_string();
        match saml_id(&line) {
            Some(id) => {
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{SIGNED_IN_PAGE}",
                    SIGNED_IN_PAGE.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
                return Ok(id);
            }
            None => {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        }
    }
}

/// The values of `attr` on every `<tag …>` in FortiGate's XML settings.
fn xml_attrs(xml: &str, tag: &str, attr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{tag} ");
    for part in xml.split(&open).skip(1) {
        let element = part.split('>').next().unwrap_or("");
        for q in ['\'', '"'] {
            let key = format!("{attr}={q}");
            if let Some(rest) = element.split(&key).nth(1) {
                if let Some(v) = rest.split(q).next() {
                    out.push(v.to_string());
                }
            }
        }
    }
    out
}

// ---- PPP (RFC 1661, IPCP from RFC 1332) ----

const PROTO_LCP: u16 = 0xc021;
const PROTO_IPCP: u16 = 0x8021;
const PROTO_IPV4: u16 = 0x0021;
const CONF_REQ: u8 = 1;
const CONF_ACK: u8 = 2;
const CONF_NAK: u8 = 3;
const CONF_REJ: u8 = 4;
const TERM_REQ: u8 = 5;
const TERM_ACK: u8 = 6;
const PROTO_REJ: u8 = 8;
const ECHO_REQ: u8 = 9;
const ECHO_REP: u8 = 10;

/// A PPP frame: address, control, protocol, then the payload.
fn ppp_frame(proto: u16, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(payload.len() + 4);
    f.extend_from_slice(&[0xff, 0x03]);
    f.extend_from_slice(&proto.to_be_bytes());
    f.extend_from_slice(payload);
    f
}

fn control(proto: u16, code: u8, id: u8, data: &[u8]) -> Vec<u8> {
    let mut p = vec![code, id];
    p.extend_from_slice(&((data.len() + 4) as u16).to_be_bytes());
    p.extend_from_slice(data);
    ppp_frame(proto, &p)
}

/// Splits a frame into protocol and payload (with or without the
/// address/control bytes and a compressed protocol field).
fn split_frame(f: &[u8]) -> Option<(u16, &[u8])> {
    let f = f.strip_prefix(&[0xff, 0x03]).unwrap_or(f);
    match f.first()? {
        b if b & 1 == 1 => Some((u16::from(*b), &f[1..])),
        _ if f.len() >= 2 => Some((u16::from_be_bytes([f[0], f[1]]), &f[2..])),
        _ => None,
    }
}

/// Configuration options: (type, value).
fn options(data: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out = Vec::new();
    let mut d = data;
    while d.len() >= 2 {
        let len = usize::from(d[1]);
        if len < 2 || len > d.len() {
            break;
        }
        out.push((d[0], &d[2..len]));
        d = &d[len..];
    }
    out
}

fn put_option(out: &mut Vec<u8>, kind: u8, value: &[u8]) {
    out.push(kind);
    out.push((value.len() + 2) as u8);
    out.extend_from_slice(value);
}

/// The client side of the PPP link: LCP, then IPCP for an address.
pub struct Ppp {
    id: u8,
    magic: u32,
    ask_mru: bool,
    ask_magic: bool,
    lcp_req: u8,
    lcp_ours: bool,
    lcp_theirs: bool,
    ipcp_started: bool,
    ipcp_req: u8,
    ipcp_ours: bool,
    ipcp_theirs: bool,
    pub ip: Ipv4Addr,
    pub dns: [Ipv4Addr; 2],
    ask_dns: [bool; 2],
    pub peer_ip: Option<Ipv4Addr>,
    /// The most the peer takes in one frame.
    pub mtu: u16,
    /// Why the link went down, once it did.
    pub down: Option<String>,
}

impl Ppp {
    pub fn new(magic: u32) -> Self {
        Ppp {
            id: 0,
            magic,
            ask_mru: true,
            ask_magic: true,
            lcp_req: 0,
            lcp_ours: false,
            lcp_theirs: false,
            ipcp_started: false,
            ipcp_req: 0,
            ipcp_ours: false,
            ipcp_theirs: false,
            ip: Ipv4Addr::UNSPECIFIED,
            dns: [Ipv4Addr::UNSPECIFIED; 2],
            ask_dns: [true, true],
            peer_ip: None,
            mtu: MRU,
            down: None,
        }
    }

    pub fn is_up(&self) -> bool {
        self.lcp_ours && self.lcp_theirs && self.ipcp_ours && self.ipcp_theirs && !self.ip.is_unspecified()
    }

    fn next_id(&mut self) -> u8 {
        self.id = self.id.wrapping_add(1);
        self.id
    }

    pub fn start(&mut self, out: &mut Vec<Vec<u8>>) {
        self.send_lcp_request(out);
    }

    /// Asks again for whatever the peer hasn't agreed to yet.
    pub fn retry(&mut self, out: &mut Vec<Vec<u8>>) {
        if !self.lcp_ours {
            self.send_lcp_request(out);
        } else if self.lcp_theirs && !self.ipcp_ours {
            self.send_ipcp_request(out);
        }
    }

    fn send_lcp_request(&mut self, out: &mut Vec<Vec<u8>>) {
        let mut opts = Vec::new();
        if self.ask_mru {
            put_option(&mut opts, 1, &MRU.to_be_bytes());
        }
        if self.ask_magic {
            put_option(&mut opts, 5, &self.magic.to_be_bytes());
        }
        self.lcp_req = self.next_id();
        out.push(control(PROTO_LCP, CONF_REQ, self.lcp_req, &opts));
    }

    fn send_ipcp_request(&mut self, out: &mut Vec<Vec<u8>>) {
        let mut opts = Vec::new();
        put_option(&mut opts, 3, &self.ip.octets());
        for (i, kind) in [(0, 129u8), (1, 131u8)] {
            if self.ask_dns[i] {
                put_option(&mut opts, kind, &self.dns[i].octets());
            }
        }
        self.ipcp_started = true;
        self.ipcp_req = self.next_id();
        out.push(control(PROTO_IPCP, CONF_REQ, self.ipcp_req, &opts));
    }

    /// Handles a frame from the peer; returns an IPv4 packet when it is one.
    pub fn input(&mut self, frame: &[u8], out: &mut Vec<Vec<u8>>) -> Option<Vec<u8>> {
        let (proto, payload) = split_frame(frame)?;
        if proto == PROTO_IPV4 {
            return Some(payload.to_vec());
        }
        if payload.len() < 4 {
            return None;
        }
        let (code, id) = (payload[0], payload[1]);
        let len = usize::from(u16::from_be_bytes([payload[2], payload[3]])).clamp(4, payload.len());
        let data = &payload[4..len];
        match proto {
            PROTO_LCP => self.lcp(code, id, data, out),
            PROTO_IPCP if self.lcp_ours && self.lcp_theirs => self.ipcp(code, id, data, out),
            PROTO_IPCP => {}
            // IPv6CP, CCP and others: not spoken here.
            _ => {
                let mut rejected = proto.to_be_bytes().to_vec();
                rejected.extend_from_slice(&payload[..len]);
                let id = self.next_id();
                out.push(control(PROTO_LCP, PROTO_REJ, id, &rejected));
            }
        }
        None
    }

    fn lcp(&mut self, code: u8, id: u8, data: &[u8], out: &mut Vec<Vec<u8>>) {
        match code {
            CONF_REQ => {
                // No authentication (the cookie did that), no compression.
                let mut rejected = Vec::new();
                for (kind, value) in options(data) {
                    match kind {
                        3 | 4 | 7 | 8 | 13 => put_option(&mut rejected, kind, value),
                        1 if value.len() == 2 => self.mtu = u16::from_be_bytes([value[0], value[1]]).clamp(576, MRU),
                        _ => {}
                    }
                }
                if rejected.is_empty() {
                    out.push(control(PROTO_LCP, CONF_ACK, id, data));
                    self.lcp_theirs = true;
                } else {
                    out.push(control(PROTO_LCP, CONF_REJ, id, &rejected));
                }
            }
            CONF_ACK if id == self.lcp_req => self.lcp_ours = true,
            CONF_NAK if id == self.lcp_req => {
                for (kind, value) in options(data) {
                    if kind == 5 && value.len() == 4 {
                        self.magic = rand::random();
                    } else if kind == 1 {
                        self.ask_mru = false;
                    }
                }
                self.send_lcp_request(out);
            }
            CONF_REJ if id == self.lcp_req => {
                for (kind, _) in options(data) {
                    match kind {
                        1 => self.ask_mru = false,
                        5 => self.ask_magic = false,
                        _ => {}
                    }
                }
                self.send_lcp_request(out);
            }
            TERM_REQ => {
                out.push(control(PROTO_LCP, TERM_ACK, id, &[]));
                self.down = Some("The VPN ended the connection".into());
            }
            ECHO_REQ => {
                let mut reply = (if self.ask_magic { self.magic } else { 0 }).to_be_bytes().to_vec();
                reply.extend_from_slice(data.get(4..).unwrap_or(&[]));
                out.push(control(PROTO_LCP, ECHO_REP, id, &reply));
            }
            _ => {}
        }
        if self.lcp_ours && self.lcp_theirs && !self.ipcp_started {
            self.send_ipcp_request(out);
        }
    }

    fn ipcp(&mut self, code: u8, id: u8, data: &[u8], out: &mut Vec<Vec<u8>>) {
        let addr = |v: &[u8]| (v.len() == 4).then(|| Ipv4Addr::new(v[0], v[1], v[2], v[3]));
        match code {
            CONF_REQ => {
                for (kind, value) in options(data) {
                    if kind == 3 {
                        self.peer_ip = addr(value).filter(|a| !a.is_unspecified());
                    }
                }
                out.push(control(PROTO_IPCP, CONF_ACK, id, data));
                self.ipcp_theirs = true;
            }
            CONF_ACK if id == self.ipcp_req => self.ipcp_ours = true,
            CONF_NAK if id == self.ipcp_req => {
                for (kind, value) in options(data) {
                    match (kind, addr(value)) {
                        (3, Some(a)) => self.ip = a,
                        (129, Some(a)) => self.dns[0] = a,
                        (131, Some(a)) => self.dns[1] = a,
                        _ => {}
                    }
                }
                self.send_ipcp_request(out);
            }
            CONF_REJ if id == self.ipcp_req => {
                for (kind, _) in options(data) {
                    match kind {
                        129 => self.ask_dns[0] = false,
                        131 => self.ask_dns[1] = false,
                        3 => self.down = Some("The VPN didn't give Tusk an address".into()),
                        _ => {}
                    }
                }
                self.send_ipcp_request(out);
            }
            TERM_REQ => {
                out.push(control(PROTO_IPCP, TERM_ACK, id, &[]));
                self.down = Some("The VPN ended the connection".into());
            }
            _ => {}
        }
    }

    fn echo_request(&mut self) -> Vec<u8> {
        let id = self.next_id();
        control(PROTO_LCP, ECHO_REQ, id, &(if self.ask_magic { self.magic } else { 0 }).to_be_bytes())
    }
}

// ---- the TCP/IP stack ----

/// IP packets in and out of the stack.
struct Link {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
    mtu: usize,
}

struct RxToken(Vec<u8>);
struct TxToken<'a>(&'a mut VecDeque<Vec<u8>>);

impl phy::RxToken for RxToken {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl phy::TxToken for TxToken<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut b = vec![0; len];
        let r = f(&mut b);
        self.0.push_back(b);
        r
    }
}

impl Device for Link {
    type RxToken<'a> = RxToken;
    type TxToken<'a> = TxToken<'a>;

    fn receive(&mut self, _: smoltcp::time::Instant) -> Option<(RxToken, TxToken<'_>)> {
        let p = self.rx.pop_front()?;
        Some((RxToken(p), TxToken(&mut self.tx)))
    }

    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<TxToken<'_>> {
        Some(TxToken(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = self.mtu;
        c
    }
}

enum Cmd {
    Connect { ip: Ipv4Addr, port: u16, reply: oneshot::Sender<Result<DuplexStream, String>> },
    Resolve { name: String, reply: oneshot::Sender<Result<Ipv4Addr, String>> },
    Close,
}

/// One TCP connection through the VPN, with the app's end as a duplex stream.
struct Conn {
    handle: SocketHandle,
    app: Option<DuplexStream>,
    reply: Option<oneshot::Sender<Result<DuplexStream, String>>>,
    deadline: tokio::time::Instant,
    from_app: mpsc::Receiver<Vec<u8>>,
    to_app: Option<mpsc::Sender<Vec<u8>>>,
    out: VecDeque<u8>,
    pending_in: Option<Vec<u8>>,
    app_closed: bool,
    target: String,
}

/// Moves bytes between the app's streams and the stack's sockets; true when
/// anything moved.
fn service(conns: &mut Vec<Conn>, sockets: &mut SocketSet<'_>) -> bool {
    let mut moved = false;
    conns.retain_mut(|c| {
        let s = sockets.get_mut::<tcp::Socket>(c.handle);
        if let Some(reply) = c.reply.take() {
            match s.state() {
                tcp::State::Established => {
                    let _ = reply.send(Ok(c.app.take().expect("app side")));
                }
                tcp::State::Closed | tcp::State::TimeWait => {
                    let _ = reply.send(Err(format!("{} didn't accept the connection through the VPN", c.target)));
                    sockets.remove(c.handle);
                    return false;
                }
                _ if tokio::time::Instant::now() > c.deadline => {
                    let _ = reply.send(Err(format!("Timed out connecting to {} through the VPN", c.target)));
                    s.abort();
                    sockets.remove(c.handle);
                    return false;
                }
                _ => {
                    c.reply = Some(reply);
                    return true;
                }
            }
        }
        // App → network.
        while c.out.len() < TCP_BUFFER && !c.app_closed {
            match c.from_app.try_recv() {
                Ok(b) => c.out.extend(b),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => c.app_closed = true,
            }
        }
        if !c.out.is_empty() && s.can_send() {
            let n = s.send_slice(c.out.make_contiguous()).unwrap_or(0);
            c.out.drain(..n);
            moved |= n > 0;
        }
        if c.app_closed && c.out.is_empty() && s.may_send() {
            s.close();
        }
        // Network → app.
        loop {
            if let Some(b) = c.pending_in.take() {
                match c.to_app.as_ref().map(|t| t.try_send(b)) {
                    Some(Ok(())) => moved = true,
                    Some(Err(mpsc::error::TrySendError::Full(b))) => {
                        c.pending_in = Some(b);
                        break;
                    }
                    _ => {
                        // The app is gone.
                        c.to_app = None;
                        c.app_closed = true;
                        s.abort();
                        break;
                    }
                }
            }
            if !s.can_recv() {
                break;
            }
            let mut b = vec![0; 16384];
            let n = s.recv_slice(&mut b).unwrap_or(0);
            if n == 0 {
                break;
            }
            b.truncate(n);
            c.pending_in = Some(b);
        }
        if !s.may_recv() && c.pending_in.is_none() {
            // The far end is done: the app reads to the end.
            c.to_app = None;
        }
        if s.state() == tcp::State::Closed && c.pending_in.is_none() {
            sockets.remove(c.handle);
            return false;
        }
        true
    });
    moved
}

fn ms(d: Duration) -> smoltcp::time::Duration {
    smoltcp::time::Duration::from_millis(d.as_millis() as u64)
}

/// Runs the PPP link and the TCP/IP stack until the tunnel ends; returns why.
async fn engine(
    mut ppp: Ppp,
    mut frames_in: mpsc::Receiver<Vec<u8>>,
    frames_out: mpsc::UnboundedSender<Vec<u8>>,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    dns_hint: Vec<Ipv4Addr>,
    up: oneshot::Sender<Result<Ipv4Addr, String>>,
) -> String {
    let send = |frames: Vec<Vec<u8>>| {
        for f in frames {
            let _ = frames_out.send(f);
        }
    };
    // Bring the link up.
    let mut early = VecDeque::new();
    let mut out = Vec::new();
    ppp.start(&mut out);
    send(std::mem::take(&mut out));
    let negotiation = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(negotiation);
    let mut retry = tokio::time::interval(Duration::from_secs(3));
    retry.tick().await;
    while !ppp.is_up() {
        tokio::select! {
            f = frames_in.recv() => match f {
                Some(f) => {
                    if let Some(p) = ppp.input(&f, &mut out) { early.push_back(p); }
                    send(std::mem::take(&mut out));
                }
                None => {
                    let _ = up.send(Err("The VPN gateway closed the tunnel while setting it up".into()));
                    return "closed".into();
                }
            },
            _ = retry.tick() => { ppp.retry(&mut out); send(std::mem::take(&mut out)); }
            _ = &mut negotiation => {
                let _ = up.send(Err("The VPN tunnel didn't come up within 30 seconds".into()));
                return "timed out".into();
            }
        }
        if let Some(why) = ppp.down.take() {
            let _ = up.send(Err(why.clone()));
            return why;
        }
    }

    // The stack, on the address the VPN gave us.
    let t0 = std::time::Instant::now();
    let now = || smoltcp::time::Instant::from_millis(t0.elapsed().as_millis() as i64);
    let mut link = Link { rx: early, tx: VecDeque::new(), mtu: usize::from(ppp.mtu) };
    let mut config = Config::new(HardwareAddress::Ip);
    config.random_seed = rand::random();
    let mut iface = Interface::new(config, &mut link, now());
    let ip = ppp.ip;
    iface.update_ip_addrs(|a| {
        let _ = a.push(IpCidr::new(IpAddress::Ipv4(ip), 32));
    });
    let via = ppp.peer_ip.filter(|p| *p != ip).unwrap_or(Ipv4Addr::new(169, 254, 0, 1));
    let _ = iface.routes_mut().add_default_ipv4_route(via);
    let mut sockets = SocketSet::new(Vec::new());
    let mut servers: Vec<IpAddress> = Vec::new();
    for a in dns_hint.iter().chain(ppp.dns.iter()) {
        if !a.is_unspecified() && !servers.contains(&IpAddress::Ipv4(*a)) {
            servers.push(IpAddress::Ipv4(*a));
        }
    }
    servers.truncate(smoltcp::config::DNS_MAX_SERVER_COUNT);
    let dns_socket = (!servers.is_empty()).then(|| sockets.add(dns::Socket::new(&servers, (0..8).map(|_| None).collect::<Vec<_>>())));
    let _ = up.send(Ok(ip));

    let wake = Arc::new(Notify::new());
    let mut conns: Vec<Conn> = Vec::new();
    type Query = (dns::QueryHandle, oneshot::Sender<Result<Ipv4Addr, String>>, tokio::time::Instant);
    let mut queries: Vec<Query> = Vec::new();
    let mut keepalive = tokio::time::interval(Duration::from_secs(25));
    keepalive.tick().await;
    let reason = loop {
        // Run the stack until it settles.
        for _ in 0..16 {
            let changed = iface.poll(now(), &mut link, &mut sockets) == PollResult::SocketStateChanged;
            let moved = service(&mut conns, &mut sockets);
            let sent = !link.tx.is_empty();
            for p in link.tx.drain(..) {
                let _ = frames_out.send(ppp_frame(PROTO_IPV4, &p));
            }
            if !changed && !moved && !sent && link.rx.is_empty() {
                break;
            }
        }
        if let Some(h) = dns_socket {
            let s = sockets.get_mut::<dns::Socket>(h);
            let mut i = 0;
            while i < queries.len() {
                let (q, _, deadline) = &queries[i];
                let result = match s.get_query_result(*q) {
                    Err(dns::GetQueryResultError::Pending) if tokio::time::Instant::now() < *deadline => {
                        i += 1;
                        continue;
                    }
                    Err(dns::GetQueryResultError::Pending) => {
                        s.cancel_query(*q);
                        Err("the VPN's DNS server didn't answer".to_string())
                    }
                    Err(dns::GetQueryResultError::Failed) => Err("the VPN's DNS server doesn't know it".to_string()),
                    Ok(list) => list
                        .iter()
                        .find_map(|a| match a {
                            IpAddress::Ipv4(v4) => Some(*v4),
                            #[allow(unreachable_patterns)]
                            _ => None,
                        })
                        .ok_or_else(|| "it has no IPv4 address".to_string()),
                };
                let (_, reply, _) = queries.swap_remove(i);
                let _ = reply.send(result);
            }
        }
        let delay = iface.poll_delay(now(), &sockets).map(|d| Duration::from_millis(d.total_millis())).unwrap_or(Duration::from_millis(250)).min(Duration::from_millis(250));
        tokio::select! {
            f = frames_in.recv() => match f {
                None => break "The VPN connection dropped".to_string(),
                Some(f) => {
                    let mut batch = vec![f];
                    while let Ok(more) = frames_in.try_recv() { batch.push(more); if batch.len() > 256 { break; } }
                    for f in batch {
                        if let Some(p) = ppp.input(&f, &mut out) { link.rx.push_back(p); }
                    }
                    send(std::mem::take(&mut out));
                    if let Some(why) = ppp.down.take() { break why; }
                }
            },
            c = cmds.recv() => match c {
                None | Some(Cmd::Close) => break "closed".to_string(),
                Some(Cmd::Connect { ip, port, reply }) => {
                    let mut s = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; TCP_BUFFER]), tcp::SocketBuffer::new(vec![0; TCP_BUFFER]));
                    s.set_nagle_enabled(false);
                    s.set_keep_alive(Some(ms(Duration::from_secs(30))));
                    let local = 49152 + rand::random::<u16>() % 16000;
                    if let Err(e) = s.connect(iface.context(), (IpAddress::Ipv4(ip), port), local) {
                        let _ = reply.send(Err(format!("Can't connect to {ip}:{port}: {e}")));
                        continue;
                    }
                    let handle = sockets.add(s);
                    let (app, mine) = tokio::io::duplex(TCP_BUFFER);
                    let (from_app, to_app) = pump(mine, wake.clone());
                    conns.push(Conn {
                        handle, app: Some(app), reply: Some(reply), deadline: tokio::time::Instant::now() + Duration::from_secs(20),
                        from_app, to_app: Some(to_app), out: VecDeque::new(), pending_in: None, app_closed: false, target: format!("{ip}:{port}"),
                    });
                }
                Some(Cmd::Resolve { name, reply }) => match dns_socket {
                    None => { let _ = reply.send(Err("the VPN gave no DNS server".into())); }
                    Some(h) => match sockets.get_mut::<dns::Socket>(h).start_query(iface.context(), &name, DnsQueryType::A) {
                        Ok(q) => queries.push((q, reply, tokio::time::Instant::now() + Duration::from_secs(10))),
                        Err(e) => { let _ = reply.send(Err(format!("{e:?}"))); }
                    },
                },
            },
            _ = wake.notified() => {}
            _ = tokio::time::sleep(delay) => {}
            _ = keepalive.tick() => { let _ = frames_out.send(ppp.echo_request()); }
        }
    };
    for c in conns.iter_mut() {
        if let Some(r) = c.reply.take() {
            let _ = r.send(Err(reason.clone()));
        }
    }
    for (_, r, _) in queries {
        let _ = r.send(Err(reason.clone()));
    }
    // Ask the gateway to end the link.
    let id = ppp.next_id();
    let _ = frames_out.send(control(PROTO_LCP, TERM_REQ, id, &[]));
    reason
}

/// Copies between the app's end of a connection and the engine's channels.
fn pump(stream: DuplexStream, wake: Arc<Notify>) -> (mpsc::Receiver<Vec<u8>>, mpsc::Sender<Vec<u8>>) {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (from_app_tx, from_app_rx) = mpsc::channel::<Vec<u8>>(64);
    let (to_app_tx, mut to_app_rx) = mpsc::channel::<Vec<u8>>(64);
    let w = wake.clone();
    tokio::spawn(async move {
        let mut b = vec![0u8; 16384];
        loop {
            match rd.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if from_app_tx.send(b[..n].to_vec()).await.is_err() {
                        break;
                    }
                    w.notify_one();
                }
            }
        }
        drop(from_app_tx);
        w.notify_one();
    });
    tokio::spawn(async move {
        while let Some(b) = to_app_rx.recv().await {
            if wr.write_all(&b).await.is_err() {
                break;
            }
            // Room again: the engine may have more waiting.
            wake.notify_one();
        }
        let _ = wr.shutdown().await;
        wake.notify_one();
    });
    (from_app_rx, to_app_tx)
}

// ---- a running tunnel ----

/// The network inside a VPN tunnel: connect to hosts on it by name or address.
pub struct Network {
    cmds: mpsc::UnboundedSender<Cmd>,
    pub address: Ipv4Addr,
    /// The company's DNS domain, for short computer names.
    domain: Option<String>,
    /// Why the tunnel ended, once it has.
    ended: Arc<Mutex<Option<String>>>,
}

impl Network {
    /// Starts the PPP link and stack on frames from and to the gateway.
    async fn start(
        frames_in: mpsc::Receiver<Vec<u8>>,
        frames_out: mpsc::UnboundedSender<Vec<u8>>,
        dns: Vec<Ipv4Addr>,
        domain: Option<String>,
    ) -> Result<Network, String> {
        let (cmds, cmd_rx) = mpsc::unbounded_channel();
        let (up_tx, up_rx) = oneshot::channel();
        let ended = Arc::new(Mutex::new(None));
        let e = ended.clone();
        tokio::spawn(async move {
            let why = engine(Ppp::new(rand::random()), frames_in, frames_out, cmd_rx, dns, up_tx).await;
            *e.lock().unwrap() = Some(why);
        });
        let address = up_rx.await.map_err(|_| "The VPN tunnel stopped".to_string())??;
        Ok(Network { cmds, address, domain, ended })
    }

    pub fn alive(&self) -> bool {
        !self.cmds.is_closed() && self.ended.lock().unwrap().is_none()
    }

    fn gone(&self) -> AppError {
        let why = self.ended.lock().unwrap().clone().unwrap_or_else(|| "it stopped".into());
        AppError::msg(format!("The VPN connection ended: {why}"))
    }

    async fn lookup(&self, name: &str) -> Result<Ipv4Addr, String> {
        let (reply, rx) = oneshot::channel();
        self.cmds.send(Cmd::Resolve { name: name.to_string(), reply }).map_err(|_| "the VPN connection ended".to_string())?;
        rx.await.map_err(|_| "the VPN connection ended".to_string())?
    }

    /// The address of a computer on the company network.
    pub async fn resolve(&self, host: &str) -> AppResult<Ipv4Addr> {
        let host = host.trim().trim_end_matches('.');
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            return Ok(ip);
        }
        match self.lookup(host).await {
            Ok(ip) => Ok(ip),
            Err(first) => {
                // "rdp-pc" might need the company's domain: rdp-pc.corp.example.
                if let Some(d) = self.domain.as_deref().filter(|_| !host.contains('.')) {
                    if let Ok(ip) = self.lookup(&format!("{host}.{d}")).await {
                        return Ok(ip);
                    }
                }
                if !self.alive() {
                    return Err(self.gone());
                }
                Err(AppError::msg(format!("Couldn't find {host} on the VPN: {first}. Try the computer's IP address instead.")))
            }
        }
    }

    /// A TCP connection to `host:port` through the tunnel.
    pub async fn connect(&self, host: &str, port: u16) -> AppResult<DuplexStream> {
        let ip = self.resolve(host).await?;
        let (reply, rx) = oneshot::channel();
        if self.cmds.send(Cmd::Connect { ip, port, reply }).is_err() {
            return Err(self.gone());
        }
        match rx.await {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(e)) => Err(AppError::msg(e)),
            Err(_) => Err(self.gone()),
        }
    }

    fn close(&self) {
        let _ = self.cmds.send(Cmd::Close);
    }
}

/// A signed-in FortiGate SSL VPN tunnel.
pub struct Tunnel {
    pub net: Network,
    gateway: Arc<Gateway>,
    cookie: String,
}

impl Tunnel {
    pub fn alive(&self) -> bool {
        self.net.alive()
    }

    /// Ends the tunnel and signs out.
    pub fn close(&self) {
        self.net.close();
        let (gw, cookie) = (self.gateway.clone(), self.cookie.clone());
        tokio::spawn(async move {
            let _ = gw.request("GET", "/remote/logout", Some(&cookie)).await;
        });
    }
}

/// What a tunnel needs to start.
pub struct Settings {
    pub gateway: String,
    pub realm: String,
    pub known_path: PathBuf,
    pub accept: Option<String>,
}

/// Progress for the user: a line of text, and a page to open when there is one.
pub type Status<'a> = &'a (dyn Fn(String, Option<String>) + Send + Sync);

/// Signs in with single sign-on and opens the tunnel.
async fn open_tunnel(app: &tauri::AppHandle, s: Settings, status: Status<'_>) -> AppResult<Tunnel> {
    let (host, port) = parse_gateway(&s.gateway)?;
    let gw = Arc::new(Gateway::new(host, port, s.known_path, s.accept.as_deref())?);
    let addr = gw.addr();

    // Check the gateway (and its certificate) before sending anyone to sign in.
    status(format!("Connecting to the VPN gateway {addr}…"), None);
    gw.request("GET", "/remote/login", None).await?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", SAML_PORT)).await.map_err(|_| {
        AppError::msg(format!(
            "Tusk needs port {SAML_PORT} on this PC to finish the VPN sign-in, and something else is using it. Close FortiClient (or another VPN sign-in) and try again."
        ))
    })?;
    let mut url = format!("https://{addr}/remote/saml/start?redirect=1");
    if !s.realm.trim().is_empty() {
        url.push_str(&format!("&realm={}", s.realm.trim()));
    }
    status(format!("Sign in to the VPN in your browser ({addr})…"), Some(url.clone()));
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url, None::<&str>);
    }
    let id = tokio::time::timeout(SIGN_IN_WAIT, wait_for_sign_in(listener))
        .await
        .map_err(|_| AppError::msg("The VPN sign-in wasn't finished within 5 minutes"))??;

    status("Opening the VPN tunnel…".into(), None);
    let r = gw.request("GET", &format!("/remote/saml/auth_id?id={id}"), None).await?;
    let cookie = r.cookie().ok_or_else(|| {
        AppError::msg(format!("The VPN gateway didn't accept the sign-in (HTTP {}). Try again, or check with your IT team that your account may use the VPN.", r.status))
    })?;
    // Ask for tunnel resources, then the settings (DNS servers and domain).
    let _ = gw.request("GET", "/remote/index", Some(&cookie)).await?;
    let _ = gw.request("GET", "/remote/fortisslvpn", Some(&cookie)).await?;
    let config = gw.request("GET", "/remote/fortisslvpn_xml", Some(&cookie)).await?;
    if config.status == 401 || config.status == 403 {
        return Err(AppError::msg(
            "The VPN signed you in but didn't allow a tunnel. Your account may only have web access; ask your IT team for tunnel access.",
        ));
    }
    let xml = config.text();
    let dns: Vec<Ipv4Addr> = xml_attrs(&xml, "dns", "ip").iter().filter_map(|a| a.parse().ok()).collect();
    let domain = xml_attrs(&xml, "dns", "domain").into_iter().find(|d| !d.is_empty()).map(|d| d.split([',', ';', ' ']).next().unwrap_or("").to_string()).filter(|d| !d.is_empty());

    // The tunnel itself: PPP frames after a 6-byte header.
    let mut tls = gw.connect().await?;
    let req = format!("GET /remote/sslvpn-tunnel HTTP/1.1\r\nHost: sslvpn\r\nCookie: SVPNCOOKIE={cookie}\r\n\r\n");
    tls.write_all(req.as_bytes()).await?;
    tls.flush().await?;
    let (rd, wr) = tokio::io::split(tls);
    let (in_tx, in_rx) = mpsc::channel(1024);
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let refused = Arc::new(Mutex::new(None));
    tokio::spawn(read_frames(rd, in_tx, refused.clone()));
    tokio::spawn(write_frames(wr, out_rx));
    let net = Network::start(in_rx, out_tx, dns, domain).await.map_err(|e| {
        let why = refused.lock().unwrap().clone().unwrap_or(e);
        AppError::msg(why)
    })?;
    Ok(Tunnel { net, gateway: gw, cookie })
}

/// Reads tunnel frames: total length, 0x5050, PPP length, then the PPP frame.
async fn read_frames<R: AsyncRead + Unpin>(mut rd: R, tx: mpsc::Sender<Vec<u8>>, refused: Arc<Mutex<Option<String>>>) {
    let mut head = [0u8; 6];
    loop {
        if rd.read_exact(&mut head).await.is_err() {
            break;
        }
        if &head[..4] == b"HTTP" {
            // The gateway answered with an error page instead of a tunnel.
            let mut rest = vec![0u8; 512];
            let n = rd.read(&mut rest).await.unwrap_or(0);
            let line = format!("HTTP{}", String::from_utf8_lossy(&[&head[4..], &rest[..n]].concat()));
            let status = line.lines().next().unwrap_or("").to_string();
            *refused.lock().unwrap() = Some(format!("The VPN gateway refused the tunnel ({status}). Your account may not have tunnel access."));
            break;
        }
        if head[2..4] != [0x50, 0x50] {
            *refused.lock().unwrap() = Some("The VPN gateway sent something Tusk doesn't understand".into());
            break;
        }
        let len = usize::from(u16::from_be_bytes([head[4], head[5]]));
        let mut f = vec![0u8; len];
        if rd.read_exact(&mut f).await.is_err() || tx.send(f).await.is_err() {
            break;
        }
    }
}

async fn write_frames<W: AsyncWrite + Unpin>(mut wr: W, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(f) = rx.recv().await {
        let mut b = Vec::with_capacity(f.len() + 6);
        b.extend_from_slice(&((f.len() + 6) as u16).to_be_bytes());
        b.extend_from_slice(&[0x50, 0x50]);
        b.extend_from_slice(&(f.len() as u16).to_be_bytes());
        b.extend_from_slice(&f);
        // Send what else is waiting in the same write.
        while let Ok(more) = rx.try_recv() {
            b.extend_from_slice(&((more.len() + 6) as u16).to_be_bytes());
            b.extend_from_slice(&[0x50, 0x50]);
            b.extend_from_slice(&(more.len() as u16).to_be_bytes());
            b.extend_from_slice(&more);
            if b.len() > 64 * 1024 {
                break;
            }
        }
        if wr.write_all(&b).await.is_err() || wr.flush().await.is_err() {
            break;
        }
    }
    let _ = wr.shutdown().await;
}

// ---- tunnels per saved connection ----

/// One tunnel per saved connection, shared by its sessions and closed when
/// the last of them is.
#[derive(Default)]
pub struct Vpns {
    tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// One sign-in at a time per connection.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Sessions using each connection's tunnel.
    users: Mutex<HashMap<String, HashSet<String>>>,
    /// Wakes a sign-in that nobody is waiting for any more.
    cancel: Mutex<HashMap<String, Arc<Notify>>>,
}

impl Vpns {
    /// The connection's tunnel, signing in first when there's none.
    pub async fn tunnel(&self, app: &tauri::AppHandle, conn_id: &str, session_id: &str, settings: Settings, status: Status<'_>) -> AppResult<Arc<Tunnel>> {
        self.users.lock().unwrap().entry(conn_id.to_string()).or_default().insert(session_id.to_string());
        let lock = self.starting.lock().unwrap().entry(conn_id.to_string()).or_default().clone();
        let _one_at_a_time = lock.lock().await;
        if let Some(t) = self.tunnels.lock().unwrap().get(conn_id).filter(|t| t.alive()) {
            return Ok(t.clone());
        }
        let cancel = self.cancel.lock().unwrap().entry(conn_id.to_string()).or_default().clone();
        let t = tokio::select! {
            t = open_tunnel(app, settings, status) => Arc::new(t?),
            _ = cancel.notified() => return Err(AppError::msg("Cancelled")),
        };
        if let Some(old) = self.tunnels.lock().unwrap().insert(conn_id.to_string(), t.clone()) {
            old.close();
        }
        Ok(t)
    }

    /// A session ended: close its tunnel once no session uses it.
    pub fn release(&self, session_id: &str) {
        let mut done = Vec::new();
        self.users.lock().unwrap().retain(|conn, sessions| {
            if sessions.remove(session_id) && sessions.is_empty() {
                done.push(conn.clone());
                return false;
            }
            !sessions.is_empty()
        });
        for conn in done {
            if let Some(t) = self.tunnels.lock().unwrap().remove(&conn) {
                t.close();
            }
            if let Some(c) = self.cancel.lock().unwrap().get(&conn) {
                c.notify_waiters();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateways_parse() {
        assert_eq!(parse_gateway("vpn.example.com:10443").unwrap(), ("vpn.example.com".into(), 10443));
        assert_eq!(parse_gateway("https://VPN.example.com/remote/login").unwrap(), ("vpn.example.com".into(), 443));
        assert!(parse_gateway("vpn:abc").is_err());
        assert!(parse_gateway("  ").is_err());
    }

    #[test]
    fn responses_and_cookies_parse() {
        let raw = b"HTTP/1.1 200 OK\r\nSet-Cookie: SVPNCOOKIE=; path=/\r\nSet-Cookie: SVPNCOOKIE=abc123%3D; path=/; secure\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let r = parse_response(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.cookie().as_deref(), Some("abc123%3D"));
        assert_eq!(r.text(), "hello world");
        let r = parse_response(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\nnoXX").unwrap();
        assert_eq!((r.status, r.text().as_str(), r.cookie()), (403, "no", None));
    }

    #[test]
    fn sign_in_ids_come_from_the_redirect() {
        assert_eq!(saml_id("GET /?id=Zm9v123 HTTP/1.1").as_deref(), Some("Zm9v123"));
        assert_eq!(saml_id("GET /?a=1&id=x HTTP/1.1").as_deref(), Some("x"));
        assert_eq!(saml_id("GET /favicon.ico HTTP/1.1"), None);
    }

    #[test]
    fn settings_xml_gives_dns() {
        let xml = "<?xml version='1.0'?><sslvpn-tunnel><ipv4><dns ip='10.1.0.53' /><dns ip=\"10.1.0.54\"/><dns domain='corp.example' /><assigned-addr ipv4='10.212.134.200' /></ipv4></sslvpn-tunnel>";
        assert_eq!(xml_attrs(xml, "dns", "ip"), ["10.1.0.53", "10.1.0.54"]);
        assert_eq!(xml_attrs(xml, "dns", "domain"), ["corp.example"]);
        assert_eq!(xml_attrs(xml, "assigned-addr", "ipv4"), ["10.212.134.200"]);
    }

    /// The gateway's side of PPP, as FortiGate behaves: asks for an MRU and
    /// magic, hands out 10.0.0.2 and DNS 10.0.0.53 by Configure-Nak.
    struct FakePeer {
        up: bool,
    }

    impl FakePeer {
        fn input(&mut self, frame: &[u8], out: &mut Vec<Vec<u8>>) -> Option<Vec<u8>> {
            let (proto, p) = split_frame(frame).unwrap();
            if proto == PROTO_IPV4 {
                return Some(p.to_vec());
            }
            let (code, id, data) = (p[0], p[1], &p[4..]);
            match (proto, code) {
                (PROTO_LCP, CONF_REQ) => {
                    out.push(control(PROTO_LCP, CONF_ACK, id, data));
                    let mut o = Vec::new();
                    put_option(&mut o, 1, &1354u16.to_be_bytes());
                    put_option(&mut o, 5, &0x1234_5678u32.to_be_bytes());
                    out.push(control(PROTO_LCP, CONF_REQ, 1, &o));
                    // Something the client doesn't speak, which it must reject.
                    out.push(control(0x8057, CONF_REQ, 1, &[]));
                }
                (PROTO_IPCP, CONF_REQ) => {
                    let opts = options(data);
                    let ip = opts.iter().find(|(k, _)| *k == 3).map(|(_, v)| v.to_vec()).unwrap();
                    if ip == [0, 0, 0, 0] {
                        let mut o = Vec::new();
                        put_option(&mut o, 3, &[10, 0, 0, 2]);
                        put_option(&mut o, 129, &[10, 0, 0, 53]);
                        put_option(&mut o, 131, &[10, 0, 0, 54]);
                        out.push(control(PROTO_IPCP, CONF_NAK, id, &o));
                        let mut mine = Vec::new();
                        put_option(&mut mine, 3, &[10, 0, 0, 1]);
                        out.push(control(PROTO_IPCP, CONF_REQ, 7, &mine));
                    } else {
                        out.push(control(PROTO_IPCP, CONF_ACK, id, data));
                        self.up = true;
                    }
                }
                _ => {}
            }
            None
        }
    }

    #[test]
    fn ppp_comes_up_and_gets_an_address() {
        let mut ppp = Ppp::new(42);
        let mut peer = FakePeer { up: false };
        let mut to_peer = Vec::new();
        ppp.start(&mut to_peer);
        let mut rejected_ipv6 = false;
        for _ in 0..10 {
            let mut to_client = Vec::new();
            for f in to_peer.drain(..) {
                if split_frame(&f).map(|(p, d)| p == PROTO_LCP && d[0] == PROTO_REJ) == Some(true) {
                    rejected_ipv6 = true;
                }
                peer.input(&f, &mut to_client);
            }
            for f in to_client {
                ppp.input(&f, &mut to_peer);
            }
        }
        assert!(ppp.is_up() && peer.up);
        assert_eq!(ppp.ip, Ipv4Addr::new(10, 0, 0, 2));
        assert_eq!(ppp.dns, [Ipv4Addr::new(10, 0, 0, 53), Ipv4Addr::new(10, 0, 0, 54)]);
        assert_eq!(ppp.peer_ip, Some(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(rejected_ipv6, "unknown protocols get a Protocol-Reject");
        // Echo requests are answered.
        let mut out = Vec::new();
        ppp.input(&control(PROTO_LCP, ECHO_REQ, 9, &[0, 0, 0, 1]), &mut out);
        assert_eq!(split_frame(&out[0]).unwrap().1[0], ECHO_REP);
        // And the peer can hang up.
        ppp.input(&control(PROTO_LCP, TERM_REQ, 3, &[]), &mut out);
        assert!(ppp.down.is_some());
    }

    #[test]
    fn frames_split_with_or_without_compression() {
        assert_eq!(split_frame(&[0xff, 0x03, 0x00, 0x21, 1, 2]), Some((PROTO_IPV4, &[1u8, 2][..])));
        assert_eq!(split_frame(&[0x21, 1, 2]), Some((PROTO_IPV4, &[1u8, 2][..])));
        assert_eq!(split_frame(&[0xc0, 0x21, 9]), Some((PROTO_LCP, &[9u8][..])));
    }

    /// The whole path: PPP up, then a TCP connection through the tunnel to an
    /// echo server running on the "company network" (a second stack).
    #[tokio::test]
    async fn tcp_goes_through_the_tunnel() {
        let (to_client, from_gateway) = mpsc::channel::<Vec<u8>>(1024);
        let (to_gateway, mut from_client) = mpsc::unbounded_channel::<Vec<u8>>();
        // The gateway: PPP from FakePeer, then a stack at 10.0.0.9 with an echo server on port 3389.
        tokio::spawn(async move {
            let mut peer = FakePeer { up: false };
            let t0 = std::time::Instant::now();
            let now = || smoltcp::time::Instant::from_millis(t0.elapsed().as_millis() as i64);
            let mut link = Link { rx: VecDeque::new(), tx: VecDeque::new(), mtu: 1354 };
            let mut iface = Interface::new(Config::new(HardwareAddress::Ip), &mut link, now());
            iface.update_ip_addrs(|a| {
                let _ = a.push(IpCidr::new(IpAddress::Ipv4(Ipv4Addr::new(10, 0, 0, 9)), 32));
            });
            let _ = iface.routes_mut().add_default_ipv4_route(Ipv4Addr::new(10, 0, 0, 1));
            let mut sockets = SocketSet::new(Vec::new());
            let mut server = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; 65536]), tcp::SocketBuffer::new(vec![0; 65536]));
            server.listen(3389).unwrap();
            let h = sockets.add(server);
            loop {
                let mut out = Vec::new();
                while let Ok(f) = from_client.try_recv() {
                    if let Some(p) = peer.input(&f, &mut out) {
                        link.rx.push_back(p);
                    }
                }
                iface.poll(now(), &mut link, &mut sockets);
                let s = sockets.get_mut::<tcp::Socket>(h);
                if s.can_recv() && s.can_send() {
                    let mut b = [0u8; 4096];
                    let n = s.recv_slice(&mut b).unwrap();
                    s.send_slice(&b[..n]).unwrap();
                }
                iface.poll(now(), &mut link, &mut sockets);
                for p in link.tx.drain(..) {
                    out.push(ppp_frame(PROTO_IPV4, &p));
                }
                for f in out {
                    if to_client.send(f).await.is_err() {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        });
        let net = tokio::time::timeout(Duration::from_secs(10), Network::start(from_gateway, to_gateway, vec![], None))
            .await
            .expect("link up in time")
            .expect("link up");
        assert_eq!(net.address, Ipv4Addr::new(10, 0, 0, 2));
        let mut s = tokio::time::timeout(Duration::from_secs(10), net.connect("10.0.0.9", 3389)).await.unwrap().unwrap();

        let msg: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let (mut rd, mut wr) = tokio::io::split(&mut s);
        let sent = msg.clone();
        let (_, got) = tokio::join!(async { wr.write_all(&sent).await.unwrap() }, async {
            let mut got = vec![0u8; sent.len()];
            tokio::time::timeout(Duration::from_secs(20), rd.read_exact(&mut got)).await.unwrap().unwrap();
            got
        });
        assert_eq!(got, msg, "echoed through the tunnel");
        // Names go to the VPN's DNS server, which doesn't exist here.
        assert!(net.connect("rdp-pc", 3389).await.is_err());
        net.close();
    }
}
