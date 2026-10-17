//! IMD Agents: every IMD agent a wallet holds, from the menu bar (macOS) or the tray (Windows, Linux).
//!
//! The webview draws; this side does everything that touches the network, the key or Docker, so the
//! page never holds a credential and never gets a general "sign this" or "fetch that URL" power:
//! - reads go to the IMD API by path only, never to a URL the page names;
//! - the app's key is P-256, kept in the OS credential store (Keychain, Credential Manager, Secret
//!   Service), and signs exactly three things: a pause, a resume and an unlink;
//! - the box is started and stopped with the same `docker run` the box repository's script uses;
//! - the app updates itself from the latest GitHub release, signed with the key tauri.conf.json names.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::EncodePublicKey;
use serde::Serialize;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalSize, Manager, PhysicalPosition,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const API: &str = "https://api.imd.fun";
const EXPLORER: &str = "https://explorer.imd.fun";
const KEY_SERVICE: &str = "fun.imd.agents";
const KEY_ACCOUNT: &str = "app-key";

/// The box, as the imd-worker-box repository builds and runs it.
const BOX_IMAGE: &str = "imd-worker-box";
const BOX_NAME: &str = "imd-worker";
const BOX_VOLUME: &str = "imd-worker-home";

/// Where reads and writes go. The public network unless a developer points it elsewhere.
fn api_base() -> String {
    std::env::var("IMD_API").ok().filter(|v| v.starts_with("http")).unwrap_or_else(|| API.into())
}

fn explorer_base() -> String {
    std::env::var("IMD_EXPLORER").ok().filter(|v| v.starts_with("http")).unwrap_or_else(|| EXPLORER.into())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("imd-agents/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

#[derive(Serialize)]
struct Answer {
    status: u16,
    body: serde_json::Value,
}

/// A path on the IMD API, and nothing that could leave it: no scheme, no host, no climbing.
fn api_path(path: &str) -> Result<String, String> {
    let ok = path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("..")
        && !path.contains('\\')
        && path.len() < 512
        && path.chars().all(|c| c.is_ascii_graphic());
    if ok { Ok(format!("{}{}", api_base(), path)) } else { Err("not an API path".into()) }
}

async fn answer(response: reqwest::Response) -> Answer {
    let status = response.status().as_u16();
    let body = response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
    Answer { status, body }
}

/// A public read: agents, standings, records, rewards. Status 0 when the network did not answer.
#[tauri::command]
async fn api_get(path: String) -> Answer {
    let Ok(url) = api_path(&path) else { return Answer { status: 400, body: serde_json::Value::Null } };
    match http().get(url).send().await {
        Ok(response) => answer(response).await,
        Err(_) => Answer { status: 0, body: serde_json::Value::Null },
    }
}

/// The explorer's two public reads of a wallet's rewards, which the plane does not price: which are
/// ready to claim, and what each is worth. Only those two, and only for a wallet's address.
fn explorer_path(path: &str) -> Result<String, String> {
    let wallet = path.strip_prefix("/api/earned?wallet=").or_else(|| path.strip_prefix("/api/earned/value?wallet="));
    let ok = wallet.is_some_and(|w| w.len() == 42 && w.starts_with("0x") && w[2..].chars().all(|c| c.is_ascii_hexdigit()));
    if ok { Ok(format!("{}{}", explorer_base(), path)) } else { Err("not a rewards read".into()) }
}

#[tauri::command]
async fn explorer_get(path: String) -> Answer {
    let Ok(url) = explorer_path(&path) else { return Answer { status: 400, body: serde_json::Value::Null } };
    match http().get(url).send().await {
        Ok(response) => answer(response).await,
        Err(_) => Answer { status: 0, body: serde_json::Value::Null },
    }
}

/// An agent's face, as SVG text. Only the by-token art, and only SVG of a sane size.
#[tauri::command]
async fn agent_svg(token_id: String) -> Option<String> {
    if token_id.is_empty() || token_id.len() > 78 || !token_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let response = http().get(format!("{}/agents/by-token/{token_id}.svg", api_base())).send().await.ok()?;
    let svg = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("svg"));
    if !response.status().is_success() || !svg {
        return None;
    }
    let text = response.text().await.ok()?;
    (text.len() < 512 * 1024).then_some(text)
}

// ---------------------------------------------------------------------------------------------
// This computer's key: P-256, made once, kept in the OS credential store, used for three actions.
// ---------------------------------------------------------------------------------------------

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).map_err(|e| e.to_string())
}

fn load_key(create: bool) -> Result<Option<SigningKey>, String> {
    let entry = key_entry()?;
    match entry.get_secret() {
        Ok(bytes) => SigningKey::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) if create => {
            let key = SigningKey::random(&mut rand_core::OsRng);
            entry.set_secret(&key.to_bytes()).map_err(|e| e.to_string())?;
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn public_key(key: &SigningKey) -> String {
    let der = key.verifying_key().to_public_key_der().expect("P-256 public key encodes");
    B64.encode(der.as_bytes())
}

fn nonce() -> String {
    let mut bytes = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    hex::encode(bytes)
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One action as the network reads it: lines of text, the same bytes the control plane rebuilds.
fn action_text(action: &str, token_id: Option<&str>, nonce: &str, issued_at: u64, relay_origin: &str) -> String {
    ["IMD app v1", action, token_id.unwrap_or("-"), nonce, &issued_at.to_string(), relay_origin].join("\n")
}

fn sign(key: &SigningKey, text: &str) -> String {
    let signature: Signature = key.sign(text.as_bytes());
    B64.encode(signature.to_der().as_bytes())
}

/// What the approval page calls this app: "IMD Agents on MacBook Pro", never the computer's own name.
fn app_name() -> String {
    let model = machine_model();
    let clean: String = model.chars().filter(|c| c.is_ascii_alphanumeric() || *c == ' ').collect();
    let name = if clean.trim().is_empty() { "IMD Agents".to_string() } else { format!("IMD Agents on {}", clean.trim()) };
    name.chars().take(64).collect()
}

fn machine_model() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = hidden(Command::new("/usr/sbin/system_profiler")).args(["SPHardwareDataType", "-json"]).output() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                if let Some(name) = json["SPHardwareDataType"][0]["machine_name"].as_str() {
                    return name.to_string();
                }
            }
        }
        "Mac".into()
    }
    #[cfg(target_os = "windows")]
    {
        "Windows PC".into()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "Linux".into()
    }
}

/// Starts connecting: names this computer's key and gets a code to approve in the browser, which opens.
#[tauri::command]
async fn link_start(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let key = load_key(true)?.ok_or("no key")?;
    let body = serde_json::json!({ "appKey": public_key(&key), "name": app_name() });
    let response = http().post(format!("{}/app-links", api_base())).json(&body).send().await.map_err(|_| "The network did not answer".to_string())?;
    let answer = answer(response).await;
    match answer.status {
        200 => {
            if let Some(code) = answer.body["code"].as_str() {
                let _ = app.opener().open_url(format!("{}/link?code={code}", explorer_base()), None::<&str>);
            }
            Ok(answer.body)
        }
        404 => Err("Connecting is not live on the network yet".into()),
        status => Err(format!("Could not start connecting ({status})")),
    }
}

/// Whether the holder has approved the code yet.
#[tauri::command]
async fn link_poll(code: String) -> Answer {
    if !(4..=16).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Answer { status: 400, body: serde_json::Value::Null };
    }
    api_get(format!("/app-links/{code}")).await
}

/// Opens the approval page again for a code still waiting.
#[tauri::command]
fn link_reopen(app: tauri::AppHandle, code: String) {
    if code.len() <= 16 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
        let _ = app.opener().open_url(format!("{}/link?code={code}", explorer_base()), None::<&str>);
    }
}

/// Pauses or resumes one seat, signed with this computer's key. The network checks the link and who
/// holds the seat right now.
#[tauri::command]
async fn seat_pause(token_id: String, paused: bool, relay_origin: String) -> Answer {
    let bad = Answer { status: 400, body: serde_json::Value::Null };
    if token_id.is_empty() || token_id.len() > 78 || !token_id.chars().all(|c| c.is_ascii_digit()) || relay_origin.len() > 256 {
        return bad;
    }
    let Ok(Some(key)) = load_key(false) else { return Answer { status: 401, body: serde_json::json!({ "error": "app_not_linked" }) } };
    let (nonce, issued_at) = (nonce(), unix_now());
    let text = action_text(if paused { "pause" } else { "resume" }, Some(&token_id), &nonce, issued_at, &relay_origin);
    let body = serde_json::json!({ "app": {
        "key": public_key(&key), "paused": paused, "nonce": nonce, "issuedAt": issued_at,
        "relayOrigin": relay_origin, "signature": sign(&key, &text),
    }});
    match http().post(format!("{}/seats/{token_id}/pause", api_base())).json(&body).send().await {
        Ok(response) => answer(response).await,
        Err(_) => Answer { status: 0, body: serde_json::Value::Null },
    }
}

/// Unlinks this computer from every wallet and forgets its key, so the next connection makes a new one.
#[tauri::command]
async fn unlink(relay_origin: String) -> Result<(), String> {
    if let Ok(Some(key)) = load_key(false) {
        let (nonce, issued_at) = (nonce(), unix_now());
        let text = action_text("unlink", None, &nonce, issued_at, &relay_origin);
        let body = serde_json::json!({ "app": {
            "key": public_key(&key), "nonce": nonce, "issuedAt": issued_at, "relayOrigin": relay_origin, "signature": sign(&key, &text),
        }});
        let status = http().post(format!("{}/app-links/unlink", api_base())).json(&body).send().await
            .map(|r| r.status().as_u16()).map_err(|_| "The network did not answer; try again".to_string())?;
        // A link the network no longer has is as gone as one it just removed.
        if status != 200 && status != 404 {
            return Err(format!("Could not disconnect ({status})"));
        }
    }
    key_entry()?.delete_credential().or_else(|e| if matches!(e, keyring::Error::NoEntry) { Ok(()) } else { Err(e.to_string()) })
}

// ---------------------------------------------------------------------------------------------
// The box: the IMD worker in Docker on this computer, as imd-worker-box runs it.
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn hidden(mut command: Command) -> Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes for a background check
    command
}

#[cfg(not(target_os = "windows"))]
fn hidden(command: Command) -> Command {
    command
}

/// Docker's CLI. An app opened from Finder or the Start menu gets a bare PATH, so the usual installs
/// are looked for by name too.
fn docker() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(if cfg!(windows) { "docker.exe" } else { "docker" })).collect())
        .unwrap_or_default();
    for fixed in [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        "/usr/bin/docker",
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    ] {
        candidates.push(PathBuf::from(fixed));
    }
    // Docker.app's own copy only once Finder has finished copying it into Applications (below)
    candidates.into_iter().find(|p| p.is_file() && !(p.starts_with("/Applications/Docker.app") && still_copying(Path::new("/Applications/Docker.app"))))
}

/// Whether Finder is still copying an item: until a copy finishes, Finder dates the item 24 January 1984, the
/// day of the first Macintosh, and puts its real date back at the end (seen in Finder on 2026-10-16).
fn still_copying(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|d| finder_copy_date(d.as_secs()))
}

/// 24 January 1984 in any time zone: from the 23rd to the 26th, UTC.
fn finder_copy_date(secs: u64) -> bool {
    (443_664_000..443_923_200).contains(&secs)
}

/// Whether Docker's engine is answering, asked of its socket alone, so nothing of Docker's runs before
/// Docker itself does. Running Docker's CLI from a Docker.app Finder was still copying made macOS judge the
/// half-copied app damaged, and it kept refusing to open it after the copy finished (the Mac mini, 2026-10-16).
fn engine_listening() -> bool {
    #[cfg(unix)]
    {
        let mut sockets = vec![PathBuf::from("/var/run/docker.sock")];
        if let Some(home) = std::env::var_os("HOME") {
            sockets.push(PathBuf::from(home).join(".docker/run/docker.sock"));
        }
        if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR") {
            sockets.push(PathBuf::from(run).join("docker.sock"));
        }
        if let Some(host) = std::env::var("DOCKER_HOST").ok().and_then(|h| h.strip_prefix("unix://").map(PathBuf::from)) {
            sockets.push(host);
        }
        sockets.iter().any(|socket| std::os::unix::net::UnixStream::connect(socket).is_ok())
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Docker's CLI, ready to run: its own directory first on PATH, where Docker Desktop's credential
/// helpers live beside it.
fn docker_command() -> Option<Command> {
    let binary = docker()?;
    let mut command = hidden(Command::new(&binary));
    if let Some(dir) = binary.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        dirs.insert(0, dir.to_path_buf());
        if let Ok(joined) = std::env::join_paths(dirs) {
            command.env("PATH", joined);
        }
    }
    Some(command)
}

fn run_docker(args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut command = docker_command()?;
    command.args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = command.spawn().ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Some((false, "timed out".into()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(if output.status.success() { &output.stdout } else { &output.stderr }).trim().to_string();
    Some((output.status.success(), text))
}

#[derive(Serialize)]
struct BoxState {
    /// "running", "stopped", "docker-down" (installed but not running) or "no-docker".
    state: &'static str,
    /// Whether the box's image has been built here: without it there is no box to start.
    installed: bool,
    /// The worker's device key, while it runs: what the network knows this computer's agent by.
    device_key: Option<String>,
}

#[tauri::command]
async fn box_state() -> BoxState {
    tauri::async_runtime::spawn_blocking(|| {
        if docker().is_none() {
            return BoxState { state: "no-docker", installed: false, device_key: None };
        }
        if !engine_listening() || !run_docker(&["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(10)).is_some_and(|(ok, _)| ok) {
            return BoxState { state: "docker-down", installed: true, device_key: None };
        }
        let installed = run_docker(&["image", "inspect", "--format", "{{.Id}}", BOX_IMAGE], Duration::from_secs(10)).is_some_and(|(ok, _)| ok);
        let running = run_docker(&["inspect", "-f", "{{.State.Running}}", BOX_NAME], Duration::from_secs(10)).is_some_and(|(ok, out)| ok && out == "true");
        let device_key = if running {
            run_docker(&["exec", "-u", "imd", BOX_NAME, "imd", "whoami"], Duration::from_secs(20))
                .filter(|(ok, out)| *ok && out.len() == 64 && out.chars().all(|c| c.is_ascii_hexdigit()))
                .map(|(_, out)| out)
        } else {
            None
        };
        BoxState { state: if running { "running" } else { "stopped" }, installed, device_key }
    })
    .await
    .unwrap_or(BoxState { state: "no-docker", installed: false, device_key: None })
}

// ---------------------------------------------------------------------------------------------
// Setting a box up, as the box's README does it the first time, one step at a time from the panel:
// Docker, the box, the worker in it, Claude's sign-in, pairing. Then it starts like any other.
// ---------------------------------------------------------------------------------------------

/// Where the box comes from: built for Apple Silicon and Intel by the box's own repository.
const BOX_PUBLISHED: &str = "ghcr.io/identity-md/worker-box:latest";
/// The one-off box that pairs, named so that a cancel can stop it.
const BOX_PAIRING: &str = "imd-worker-pair";
/// Docker Desktop's installer for this computer, straight from Docker, so Get Docker downloads it rather than
/// opening a page that asks which chip it is for; anywhere else, Docker's page.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const DOCKER_DOWNLOAD: &str = "https://desktop.docker.com/mac/main/arm64/Docker.dmg";
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const DOCKER_DOWNLOAD: &str = "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const DOCKER_DOWNLOAD: &str = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86_64"))))]
const DOCKER_DOWNLOAD: &str = "https://www.docker.com/products/docker-desktop/";

/// The flags every box runs with, as `./box` gives them: nothing of this computer mounted, every
/// capability dropped but the few its firewall needs before it hands over to the worker's own user.
fn box_flags() -> Vec<String> {
    [
        "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--cap-add", "CHOWN",
        "--security-opt", "no-new-privileges:true",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(jail_flags())
    .chain(["--cpus".to_string(), box_cpus()])
    .chain(["--memory", "6g", "--pids-limit", "2048", "-v"].iter().map(|s| s.to_string()))
    .chain([format!("{BOX_VOLUME}:/home/imd")])
    .collect()
}

/// Four CPUs, or as many as Docker has if fewer: Docker refuses to start a container asking for more
/// than it has, and a Mac whose Docker was given two would never start the box.
fn box_cpus() -> String {
    let have = run_docker(&["info", "--format", "{{.NCPU}}"], Duration::from_secs(10))
        .and_then(|(ok, out)| if ok { out.trim().parse::<u32>().ok() } else { None });
    have.map_or(4, |n| n.clamp(1, 4)).to_string()
}

/// What Docker said when a step failed, whole: its error is on the first line and its last is often
/// only "Run 'docker run --help'", so the panel picks the telling line and says it in plain words.
fn docker_failure(why: String, otherwise: &str) -> String {
    let why = why.trim();
    if why.is_empty() { otherwise.to_string() } else { why.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect() }
}

/// The box repository's seccomp.json, kept identical to it: Docker's default profile with the
/// namespace calls bubblewrap needs, so the worker's read jail starts and the box takes oracle,
/// research and contract work.
const BOX_SECCOMP: &str = include_str!("../box-seccomp.json");

/// Docker reads a seccomp profile from a file on this computer, so the app writes its copy first,
/// and /proc is left unmasked for the jail to mount its own. Without the file the box still runs,
/// under Docker's own profile, and the worker withholds the jailed work.
fn jail_flags() -> Vec<String> {
    let path = std::env::temp_dir().join("imd-box-seccomp.json");
    let current = std::fs::read_to_string(&path).is_ok_and(|text| text == BOX_SECCOMP);
    if !current && std::fs::write(&path, BOX_SECCOMP).is_err() {
        return Vec::new();
    }
    vec!["--security-opt".into(), format!("seccomp={}", path.display()), "--security-opt".into(), "systempaths=unconfined".into()]
}

#[derive(Serialize)]
struct Setup {
    /// "missing", "stopped" (installed, not running) or "running".
    docker: &'static str,
    /// The box's image is here.
    image: bool,
    /// The worker is installed in the box's volume.
    worker: bool,
    /// Claude Code is signed in, in the box.
    claude: bool,
    /// The worker's device key: the network says which agent it is paired to.
    device_key: Option<String>,
}

/// How far setting this computer's box up has got. One look inside the box answers the last three:
/// whether the worker is there, whether Claude's sign-in file is (never what is in it), and the key.
#[tauri::command]
async fn box_setup_state() -> Setup {
    tauri::async_runtime::spawn_blocking(|| {
        let none = |docker| Setup { docker, image: false, worker: false, claude: false, device_key: None };
        if docker().is_none() {
            return none("missing");
        }
        if !engine_listening() || !run_docker(&["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(10)).is_some_and(|(ok, _)| ok) {
            return none("stopped");
        }
        if !run_docker(&["image", "inspect", "--format", "{{.Id}}", BOX_IMAGE], Duration::from_secs(10)).is_some_and(|(ok, _)| ok) {
            return none("running");
        }
        let look = r#"command -v imd >/dev/null && echo worker; test -s "$HOME/.claude/.credentials.json" && echo claude; command -v imd >/dev/null && imd whoami 2>/dev/null | head -1; true"#;
        let running = run_docker(&["inspect", "-f", "{{.State.Running}}", BOX_NAME], Duration::from_secs(10)).is_some_and(|(ok, out)| ok && out == "true");
        let answer = if running {
            run_docker(&["exec", "-u", "imd", BOX_NAME, "sh", "-c", look], Duration::from_secs(30))
        } else {
            let mut args: Vec<String> = vec!["run".into(), "--rm".into()];
            args.extend(box_flags());
            args.extend([BOX_IMAGE.to_string(), "sh".into(), "-c".into(), look.to_string()]);
            run_docker(&args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(60))
        };
        let lines: Vec<String> = answer.filter(|(ok, _)| *ok).map(|(_, out)| out.lines().map(str::to_string).collect()).unwrap_or_default();
        Setup {
            docker: "running",
            image: true,
            worker: lines.iter().any(|l| l == "worker"),
            claude: lines.iter().any(|l| l == "claude"),
            device_key: lines.into_iter().find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit())),
        }
    })
    .await
    .unwrap_or(Setup { docker: "missing", image: false, worker: false, claude: false, device_key: None })
}

/// Docker Desktop: its installer when it is not installed, the app itself when it is not running.
#[tauri::command]
fn docker_open(app: tauri::AppHandle) -> Result<(), String> {
    if docker().is_none() {
        return app.opener().open_url(DOCKER_DOWNLOAD, None::<&str>).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    let opened = Command::new("open").args(["-a", "Docker"]).status();
    #[cfg(target_os = "windows")]
    let opened = hidden(Command::new("cmd")).args(["/c", "start", "", "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"]).status();
    #[cfg(target_os = "linux")]
    let opened = Command::new("systemctl").args(["--user", "start", "docker-desktop"]).status();
    match opened {
        Ok(status) if status.success() => Ok(()),
        _ => Err("Open Docker yourself, then come back".into()),
    }
}

/// Downloads the published box and names it as `./box` names its own build, so either runs it.
#[tauri::command]
async fn box_pull() -> Result<(), String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(|| {
        match run_docker(&["pull", BOX_PUBLISHED], Duration::from_secs(30 * 60)) {
            Some((true, _)) => {}
            Some((false, why)) => return Err(docker_failure(why, "could not download the box")),
            None => return Err("Docker is not installed".into()),
        }
        match run_docker(&["tag", BOX_PUBLISHED, BOX_IMAGE], Duration::from_secs(30)) {
            Some((true, _)) => Ok(()),
            Some((false, why)) => Err(why),
            None => Err("Docker is not installed".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs the worker and Claude Code into the box's volume, as `./box setup` does before its shell.
#[tauri::command]
async fn box_install() -> Result<(), String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(|| {
        let mut args: Vec<String> = vec!["run".into(), "--rm".into()];
        args.extend(box_flags());
        args.extend([BOX_IMAGE.to_string(), "imd-box-setup".into()]);
        match run_docker(&args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(20 * 60)) {
            Some((true, _)) => Ok(()),
            Some((false, why)) => Err(docker_failure(why, "could not install the worker")),
            None => Err("Docker is not installed".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude's sign-in is Claude's own, in a terminal: a window opens on Claude Code inside the box,
/// with one line saying what to type. The panel sees it done when the sign-in file appears.
#[tauri::command]
fn box_sign_in() -> Result<(), String> {
    let binary = docker().ok_or("Docker is not installed")?;
    let docker = binary.to_string_lossy().to_string();
    // Quoted, for the seccomp profile's path: a temporary folder can have a space in it on Windows.
    let quote = if cfg!(target_os = "windows") { '"' } else { '\'' };
    let flags = box_flags().iter().map(|flag| format!("{quote}{flag}{quote}")).collect::<Vec<_>>().join(" ");
    let say = "Sign in to Claude for your IMD agent: type /login, follow it in your browser, then /exit.";
    #[cfg(target_os = "macos")]
    {
        let line = format!("clear; echo '{say}'; echo; '{docker}' run -it --rm {flags} {BOX_IMAGE} claude; exit");
        let script = format!("tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell", line.replace('\\', "\\\\").replace('"', "\\\""));
        Command::new("osascript").args(["-e", &script]).status().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let line = format!("echo {say} && \"{docker}\" run -it --rm {flags} {BOX_IMAGE} claude");
        Command::new("cmd").args(["/c", "start", "IMD box", "cmd", "/k", &line]).status().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let line = format!("echo '{say}'; echo; '{docker}' run -it --rm {flags} {BOX_IMAGE} claude");
        Command::new("x-terminal-emulator").args(["-e", "sh", "-c", &line]).status().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct PairingCode {
    code: String,
    url: String,
}

#[derive(Serialize)]
struct Paired {
    token_id: Option<String>,
    /// The page to register the agent at, when its token is not an ERC-8004 agent yet.
    register: Option<String>,
}

/// Pairs the box with the wallet that holds an agent: `imd pair` in a one-off box, its code and page
/// handed to the panel as soon as it prints them, then its answer once the wallet has signed.
#[tauri::command]
async fn box_pair(app: tauri::AppHandle) -> Result<Paired, String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;
        let _ = run_docker(&["rm", "-f", BOX_PAIRING], Duration::from_secs(30));
        let mut command = docker_command().ok_or("Docker is not installed")?;
        let mut args: Vec<String> = vec!["run".into(), "--rm".into(), "--name".into(), BOX_PAIRING.into()];
        args.extend(box_flags());
        args.extend([BOX_IMAGE.to_string(), "imd".into(), "pair".into()]);
        command.args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no output")?;
        let mut code = String::new();
        let mut paired = Paired { token_id: None, register: None };
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("Code") {
                code = rest.trim().to_string();
            } else if line.starts_with("http") && line.contains("/pair?code=") {
                let _ = app.emit("box-pairing", PairingCode { code: code.clone(), url: line.to_string() });
            } else if line.starts_with("http") && line.contains("/pair?register=") {
                paired.register = Some(line.to_string());
            } else if let Some(rest) = line.strip_prefix("Paired. Token ") {
                paired.token_id = rest.split_whitespace().next().map(str::to_string);
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() && paired.token_id.is_some() {
            return Ok(paired);
        }
        let mut why = String::new();
        if let Some(mut err) = child.stderr.take() {
            use std::io::Read;
            let _ = err.read_to_string(&mut why);
        }
        Err(why.lines().last().map(str::to_string).filter(|l| !l.is_empty()).unwrap_or_else(|| "Pairing stopped".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the page a pairing code is approved on: the network's own pairing page, never another.
#[tauri::command]
fn open_pairing(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let base = format!("{}/pair?", api_base());
    let ok = url.starts_with(&base) && url.len() < 256 && url.chars().all(|c| c.is_ascii_graphic()) && !url.contains("..");
    if !ok {
        return Err("not a pairing page".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Stops a pairing that is waiting for a signature.
#[tauri::command]
async fn box_pair_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(|| run_docker(&["rm", "-f", BOX_PAIRING], Duration::from_secs(30))).await;
}

/// Starts the box exactly as `./box start` does: nothing of this computer mounted, every capability
/// dropped but the few the firewall needs before it hands over to the worker's own user.
#[tauri::command]
async fn box_start(runtime: String) -> Result<(), String> {
    if !["claude", "codex", "claude,grok", "codex,grok"].contains(&runtime.as_str()) {
        return Err("unknown runtime".into());
    }
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(30));
        let mut args: Vec<String> = ["run", "-d", "--name", BOX_NAME, "--restart", "unless-stopped"].iter().map(|s| s.to_string()).collect();
        args.extend(box_flags());
        args.extend([BOX_IMAGE, "imd", "start", "--runtime", &runtime, "--auto-update"].iter().map(|s| s.to_string()));
        match run_docker(&args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(120)) {
            Some((true, _)) => Ok(()),
            Some((false, why)) => Err(docker_failure(why, "could not start")),
            None => Err("Docker is not installed".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the box: the job it holds goes back to the network, as `./box stop` does.
#[tauri::command]
async fn box_stop() -> Result<(), String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(|| match run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(60)) {
        Some((true, _)) => Ok(()),
        Some((false, why)) if why.contains("No such container") => Ok(()),
        Some((false, why)) => Err(why),
        None => Err("Docker is not installed".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restarts this computer's agent: the same box, started again. It runs with `--auto-update`, so a
/// restart is also how it takes the newest worker.
#[tauri::command]
async fn box_restart() -> Result<(), String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(|| match run_docker(&["restart", "--time", "30", BOX_NAME], Duration::from_secs(90)) {
        Some((true, _)) => Ok(()),
        Some((false, why)) => Err(why),
        None => Err("Docker is not installed".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The worker's newest releases, from the public list daemons update from: newest first, with when
/// each came out. Read straight from GitHub, as the explorer reads it; nothing is sent with the ask.
#[tauri::command]
async fn worker_releases() -> Answer {
    let request = http()
        .get("https://api.github.com/repos/Identity-md/worker/releases?per_page=10")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json");
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            // only what the panel reads: the tag, when it came out, and whether it is a real release
            let rows = response.json::<Vec<serde_json::Value>>().await.unwrap_or_default();
            let body = rows
                .iter()
                .map(|r| serde_json::json!({ "tag_name": r["tag_name"], "published_at": r["published_at"], "draft": r["draft"], "prerelease": r["prerelease"] }))
                .collect();
            Answer { status, body: serde_json::Value::Array(body) }
        }
        Err(_) => Answer { status: 0, body: serde_json::Value::Null },
    }
}

// ---------------------------------------------------------------------------------------------
// Links out, and the panel itself.
// ---------------------------------------------------------------------------------------------

/// Opens a page on the explorer: an agent, a wallet's rewards, a token. Never any other site.
#[tauri::command]
fn open_explorer(app: tauri::AppHandle, path: String) {
    if path.starts_with('/') && !path.starts_with("//") && !path.contains("..") && path.len() < 256 && path.chars().all(|c| c.is_ascii_graphic()) {
        let _ = app.opener().open_url(format!("{}{path}", explorer_base()), None::<&str>);
    }
}

static PANEL_HIDDEN_AT_MS: AtomicU64 = AtomicU64::new(0);
/// The click on the icon that blurs the panel closed must not open it again on its way up.
const REOPEN_GUARD_MS: u64 = 300;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
fn hide_panel(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("panel") {
        PANEL_HIDDEN_AT_MS.store(now_ms(), Ordering::Relaxed);
        let _ = win.hide();
    }
}

/// Whether the panel opened above its icon, over a taskbar at the bottom: it then grows upward.
static PANEL_ABOVE: AtomicBool = AtomicBool::new(false);

/// The panel is 360 points wide, drawn inset in its window: room for its own shadow, which grows and
/// shrinks with it as a window's shadow would not. Little above, where macOS keeps a window below the menu
/// bar anyway; most below, where the shadow falls. The page's CSS matches.
const PANEL_WIDTH: f64 = 360.0;
const INSET_TOP: f64 = 6.0;
const INSET_SIDE: f64 = 22.0;
const INSET_BOTTOM: f64 = 32.0;

/// The window is as tall as the panel shows, its inset included. A resize alone keeps a window's bottom
/// edge on macOS, so the edge by the icon is put back: the top under a menu bar, the bottom over a taskbar.
#[tauri::command]
fn fit_panel(window: tauri::WebviewWindow, height: f64) {
    let height = height.clamp(80.0 + INSET_TOP + INSET_BOTTOM, 720.0 + INSET_TOP + INSET_BOTTOM);
    let scale = window.scale_factor().unwrap_or(1.0);
    let before = window.outer_position().ok().zip(window.outer_size().ok());
    let _ = window.set_size(LogicalSize::new(PANEL_WIDTH + 2.0 * INSET_SIDE, height));
    if let Some((position, size)) = before {
        let y = if PANEL_ABOVE.load(Ordering::Relaxed) { position.y as f64 + size.height as f64 - height * scale } else { position.y as f64 };
        let _ = window.set_position(PhysicalPosition::new(position.x as f64, y));
    }
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Docker work under way: a download, an install, pairing, a start, stop or restart. The app does not
/// start again on an update while any of it runs.
static BUSY: AtomicUsize = AtomicUsize::new(0);

struct Busy;

impl Busy {
    fn new() -> Self {
        BUSY.fetch_add(1, Ordering::SeqCst);
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Closed for five minutes with no Docker work under way: a moment no one is using the app.
fn quiet(app: &tauri::AppHandle) -> bool {
    let open = app.get_webview_window("panel").and_then(|win| win.is_visible().ok()).unwrap_or(false);
    let closed_for = now_ms().saturating_sub(PANEL_HIDDEN_AT_MS.load(Ordering::Relaxed));
    !open && closed_for >= 5 * 60 * 1000 && BUSY.load(Ordering::SeqCst) == 0
}

/// The app updates itself as the worker does. A minute after it starts and every six hours after, it
/// asks the latest GitHub release whether there is a newer version; once the app is quiet it installs
/// that version and starts again on it. An update not signed with the key in tauri.conf.json is refused.
fn watch_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let found = match app.updater() {
                Ok(updater) => updater.check().await.ok().flatten(),
                Err(_) => None,
            };
            if let Some(update) = found {
                while !quiet(&app) {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
                if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    app.restart();
                }
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

/// The icon says, at a glance, how the agents are: resting, working, or one needs you.
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, state: String) {
    let Some(tray) = app.try_state::<TrayHandle>() else { return };
    if let Ok(image) = Image::from_bytes(tray_icon(&state)) {
        let _ = tray.0.set_icon(Some(image));
        #[cfg(target_os = "macos")]
        let _ = tray.0.set_icon_as_template(true);
    }
}

struct TrayHandle(TrayIcon);

/// The icon for a state. macOS tints a black template for its menu bar; Windows and Linux get the mark on a
/// white tile, which reads on a dark taskbar and a light one.
fn tray_icon(state: &str) -> &'static [u8] {
    #[cfg(target_os = "macos")]
    {
        match state {
            "working" => include_bytes!("../icons/tray-working.png"),
            "attention" => include_bytes!("../icons/tray-attention.png"),
            "off" => include_bytes!("../icons/tray-off.png"),
            _ => include_bytes!("../icons/tray.png"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        match state {
            "working" => include_bytes!("../icons/tray-tile-working.png"),
            "attention" => include_bytes!("../icons/tray-tile-attention.png"),
            "off" => include_bytes!("../icons/tray-tile-off.png"),
            _ => include_bytes!("../icons/tray-tile.png"),
        }
    }
}

/// Shows the panel and tells the page, which plays it in from the side its icon is on.
fn open_panel(win: &tauri::WebviewWindow, above: bool) {
    PANEL_ABOVE.store(above, Ordering::Relaxed);
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit("panel-shown", above);
}

/// Opens the panel where there is no icon to place it by: the app opened by hand, or the menu on a Linux
/// tray that only shows menus. Top right of the screen, under where a status area usually is.
fn show_panel_top_right(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("panel") else { return };
    // A panel never shown yet has no screen of its own: the primary one, which holds the menu bar.
    if let Some(monitor) = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten()) {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let x = area.position.x as f64 + area.size.width as f64 - (PANEL_WIDTH + 12.0 + INSET_SIDE) * scale;
        let _ = win.set_position(PhysicalPosition::new(x, area.position.y as f64 + (6.0 - INSET_TOP) * scale));
    }
    open_panel(&win, false);
}

/// Opens the panel from its icon: under it below a menu bar (macOS), above it over a taskbar (Windows and
/// Linux), centred on it and kept inside its screen. Open already, it closes, the page playing it out first.
fn toggle_panel(app: &tauri::AppHandle, cursor: PhysicalPosition<f64>, icon: tauri::Rect) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.emit("panel-close", ());
        return;
    }
    if now_ms().saturating_sub(PANEL_HIDDEN_AT_MS.load(Ordering::Relaxed)) < REOPEN_GUARD_MS {
        return;
    }
    let monitor = win
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                cursor.x >= p.x as f64 && cursor.x < (p.x as f64 + s.width as f64) && cursor.y >= p.y as f64 && cursor.y < (p.y as f64 + s.height as f64)
            })
        })
        .or_else(|| win.primary_monitor().ok().flatten());
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or_else(|| win.scale_factor().unwrap_or(2.0));
    // the icon's own bounds, so the panel hangs from the bar rather than from wherever the click landed
    let (at, size) = (icon.position.to_physical::<f64>(scale), icon.size.to_physical::<f64>(scale));
    let (centre, top, bottom) = if size.width > 0.0 && size.height > 0.0 {
        (at.x + size.width / 2.0, at.y, at.y + size.height)
    } else {
        (cursor.x, cursor.y, cursor.y)
    };
    let width = PANEL_WIDTH * scale;
    let height = win.outer_size().map(|s| s.height as f64).unwrap_or(518.0 * scale) - (INSET_TOP + INSET_BOTTOM) * scale;
    let (gap, margin) = (6.0 * scale, 8.0 * scale);
    let area = monitor.as_ref().map(|m| {
        let a = m.work_area();
        (a.position.x as f64, a.position.y as f64, a.size.width as f64, a.size.height as f64)
    });
    let (x, y, above) = match area {
        Some((sx, sy, sw, sh)) => {
            let x = (centre - width / 2.0).clamp(sx + margin, sx + sw - width - margin);
            // In the top half the bar is above: open below the icon. In the bottom half, above it.
            let above = top >= sy + sh / 2.0;
            (x, if above { top - gap - height } else { bottom + gap }, above)
        }
        None => (centre - width / 2.0, bottom + gap, false),
    };
    let _ = win.set_position(PhysicalPosition::new(x - INSET_SIDE * scale, y - INSET_TOP * scale));
    open_panel(&win, above);
}

/// What the login item passes, so a start at login stays in the tray while one by hand opens the panel.
const AT_LOGIN: &str = "--at-login";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opened again while running, on Windows and Linux: no second icon, the panel opens instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel_top_right(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![AT_LOGIN])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            api_get, explorer_get, agent_svg, link_start, link_poll, link_reopen, seat_pause, unlink,
            box_state, box_start, box_stop, box_restart, worker_releases, open_explorer,
            box_setup_state, docker_open, box_pull, box_install, box_sign_in, box_pair, box_pair_cancel, open_pairing, hide_panel, fit_panel, quit, set_tray_state
        ])
        .setup(|app| {
            // A menu bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let icon = Image::from_bytes(tray_icon("idle"))?;
            // A small menu too: a right-click on macOS and Windows, and the only way in on a Linux tray
            // that sends no clicks.
            let open = tauri::menu::MenuItem::with_id(app, "open", "Open IMD Agents", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit_item])?;
            let tray = TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("IMD Agents")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_panel_top_right(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, rect, .. } = event {
                        toggle_panel(tray.app_handle(), position, rect);
                    }
                })
                .build(app)?;
            app.manage(TrayHandle(tray));

            // Opened by hand, the panel opens too: a menu bar manager may hide the icon.
            if !std::env::args().any(|arg| arg == AT_LOGIN) {
                show_panel_top_right(app.handle());
            }
            // A release build only: one run from source is not an install to replace.
            if !cfg!(debug_assertions) {
                watch_for_updates(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running IMD Agents")
        .run(|_app, _event| {
            // Opened again while running, on macOS (Spotlight, Finder, Raycast): the panel opens.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_panel_top_right(_app);
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn finder_dates_an_item_it_is_still_copying() {
        // 24 January 1984, 08:00 UTC: Finder's stamp on a copy in progress, read off one mid-copy
        assert!(super::finder_copy_date(443_779_200));
        assert!(!super::finder_copy_date(0));
        assert!(!super::finder_copy_date(1_792_000_000));
    }

    use super::*;

    #[test]
    fn action_text_is_the_lines_the_network_rebuilds() {
        assert_eq!(
            action_text("pause", Some("22"), &"ab".repeat(32), 1_790_000_000, "https://api.imd.fun"),
            format!("IMD app v1\npause\n22\n{}\n1790000000\nhttps://api.imd.fun", "ab".repeat(32))
        );
        assert_eq!(action_text("unlink", None, "n", 1, "o"), "IMD app v1\nunlink\n-\nn\n1\no");
    }

    #[test]
    fn only_the_rewards_reads_go_to_the_explorer() {
        let wallet = "0x1111111111111111111111111111111111111111";
        assert!(explorer_path(&format!("/api/earned?wallet={wallet}")).is_ok());
        assert!(explorer_path(&format!("/api/earned/value?wallet={wallet}")).is_ok());
        for bad in ["/api/claim?wallet=0x1", "/api/earned?wallet=0xzz", "/api/earned?wallet=0x1111111111111111111111111111111111111111&x=1", "https://evil.test/api/earned"] {
            assert!(explorer_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_box_runs_with_the_jails_profile() {
        let flags = box_flags();
        let seccomp = flags.iter().find_map(|flag| flag.strip_prefix("seccomp=")).expect("a seccomp profile");
        assert_eq!(std::fs::read_to_string(seccomp).unwrap(), BOX_SECCOMP);
        assert!(flags.iter().any(|flag| flag == "systempaths=unconfined"));
        let profile: serde_json::Value = serde_json::from_str(BOX_SECCOMP).unwrap();
        let unshare_outright = profile["syscalls"].as_array().unwrap().iter().any(|rule| {
            rule["action"] == "SCMP_ACT_ALLOW" && rule.get("includes").is_none() && rule["names"].as_array().unwrap().iter().any(|name| name == "unshare")
        });
        assert!(unshare_outright, "unshare is allowed without CAP_SYS_ADMIN");
        assert_eq!(&flags[..2], ["--cap-drop", "ALL"]);
        assert_eq!(flags.last().unwrap(), &format!("{BOX_VOLUME}:/home/imd"));
    }

    #[test]
    fn only_api_paths_are_read() {
        assert!(api_path("/seats/12?collaborators=0").is_ok());
        for bad in ["https://evil.test/x", "//evil.test", "/../admin", "/a\\b", "/a b"] {
            assert!(api_path(bad).is_err(), "{bad}");
        }
    }

    /// Against the live network and this computer's Docker: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_live_api_and_the_box() {
        tauri::async_runtime::block_on(async {
            let seat = api_get("/seats/12/standing?queue=0".into()).await;
            println!("standing status {}", seat.status);
            assert!(seat.status == 200 || seat.status == 429, "the API answers");
            let svg = agent_svg("12".into()).await;
            println!("face {} bytes", svg.as_ref().map(|s| s.len()).unwrap_or(0));
            let state = box_state().await;
            println!("box {} installed {} device {:?}", state.state, state.installed, state.device_key.as_deref().map(|k| &k[..8]));
        });
    }

    /// How far this computer's box is set up: `cargo test -- --ignored reads_this_computers_setup --nocapture`.
    #[test]
    #[ignore]
    fn reads_this_computers_setup() {
        tauri::async_runtime::block_on(async {
            let s = box_setup_state().await;
            println!("docker {} image {} worker {} claude {} device {:?}", s.docker, s.image, s.worker, s.claude, s.device_key.as_deref().map(|k| &k[..8]));
        });
    }

    /// Prints a key and a signature for the plane's own check: `cargo test -- --ignored prints_a_signature --nocapture`.
    #[test]
    #[ignore]
    fn prints_a_signature() {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let text = action_text("pause", Some("22"), &"ab".repeat(32), 1_790_000_000, "https://api.imd.fun");
        println!("KEY {}", public_key(&key));
        println!("SIG {}", sign(&key, &text));
    }

    #[test]
    fn the_public_key_is_p256_spki_der() {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let der = B64.decode(public_key(&key)).unwrap();
        // SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (uncompressed point) }: 91 bytes
        assert_eq!(der.len(), 91);
        assert_eq!(der[der.len() - 65], 0x04, "uncompressed point");
    }
}
