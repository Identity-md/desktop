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

/// The box, as the IMD Box repository's ./box builds and runs it: the name it keeps on each machine.
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

/// One client for the app's life, so reads reuse their connections instead of shaking hands each time.
fn http() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                // let go of an idle connection before the network does: one it has closed fails the next read on it
                .pool_idle_timeout(Duration::from_secs(30))
                .user_agent(concat!("imd-agents/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client")
        })
        .clone()
}

/// For downloads of hundreds of megabytes: a time limit on connecting, none on the whole transfer.
fn http_long() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent(concat!("imd-agents/", env!("CARGO_PKG_VERSION")))
        // the bytes as sent, so progress counts against the size the server gives
        .no_gzip()
        .no_brotli()
        .build()
        .expect("http client")
}

/// What a setup step is doing right now, in words, for the setup window to show under it.
#[derive(Clone, Serialize)]
struct StepProgress {
    step: &'static str,
    words: String,
}

fn progress(app: &tauri::AppHandle, step: &'static str, words: impl Into<String>) {
    let _ = app.emit("setup-step-progress", StepProgress { step, words: words.into() });
}

/// Megabytes, whole, as a person counts a download.
fn mb(bytes: u64) -> u64 {
    (bytes as f64 / 1_000_000.0).round() as u64
}

/// What went wrong, kept beside the app's data for a look at a computer no one can watch it on: reads the
/// network didn't answer, its own errors, and where a panic happened. Set as the app starts.
static LOG: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static LOGGING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn log_failure(line: &str) {
    if let Some(path) = LOG.get() {
        log_in(path, line);
    }
}

/// One line, after the time in UTC. Past a megabyte the log moves aside to imd-agents.old.log and starts again.
fn log_in(path: &Path, line: &str) {
    let _one_at_a_time = LOGGING.lock().unwrap_or_else(|held| held.into_inner());
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > 1_000_000) {
        let _ = std::fs::rename(path, path.with_file_name("imd-agents.old.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "{} {}", utc(unix_now()), line.replace(['\r', '\n'], " "));
    }
}

/// A moment in UTC as ISO 8601 writes it, 2026-10-24T17:25:31Z: days to a date by Howard Hinnant's
/// civil_from_days, which needs no calendar of its own.
fn utc(secs: u64) -> String {
    let (days, time) = ((secs / 86_400) as i64 + 719_468, secs % 86_400);
    let (era, day_of_era) = (days.div_euclid(146_097), days.rem_euclid(146_097));
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", time / 3_600, time % 3_600 / 60, time % 60)
}

/// An error and every cause under it: reqwest's own words stop at "error sending request".
fn causes(error: &dyn std::error::Error) -> String {
    let mut words = error.to_string();
    let mut cause = error.source();
    while let Some(next) = cause {
        words.push_str(": ");
        words.push_str(&next.to_string());
        cause = next.source();
    }
    words
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
    let (status, url) = (response.status(), response.url().to_string());
    let body = response.json::<serde_json::Value>().await.unwrap_or_else(|e| {
        // an error's page needn't be JSON; an OK's must, or the read failed after all
        if status == reqwest::StatusCode::OK {
            log_failure(&format!("{url}: 200 that isn't JSON: {}", causes(&e)));
        }
        serde_json::Value::Null
    });
    Answer { status: status.as_u16(), body }
}

/// A read of the network, logged when it fails: no answer at all, or an answer of the network's own error.
async fn read(url: String) -> Answer {
    let mut sent = http().get(&url).send().await;
    // a connection the network closed as it sat idle fails the first read on it: once more, on a new one. Not after
    // a timeout, which would only wait as long again
    if let Err(e) = &sent {
        if !e.is_timeout() {
            log_failure(&format!("GET {url}: tried again: {}", causes(e)));
            sent = http().get(&url).send().await;
        }
    }
    match sent {
        Ok(response) => {
            if response.status().is_server_error() {
                log_failure(&format!("GET {url}: {}", response.status()));
            }
            answer(response).await
        }
        Err(e) => {
            log_failure(&format!("GET {url}: no answer: {}", causes(&e)));
            Answer { status: 0, body: serde_json::Value::Null }
        }
    }
}

/// A public read: agents, standings, records, rewards. Status 0 when the network did not answer.
#[tauri::command]
async fn api_get(path: String) -> Answer {
    let Ok(url) = api_path(&path) else { return Answer { status: 400, body: serde_json::Value::Null } };
    read(url).await
}

/// The explorer's two public reads of a wallet's rewards, which the plane does not price: which are
/// ready to claim, and what each is worth. Only those two, and only for a wallet's address.
fn explorer_path(path: &str) -> Result<String, String> {
    let wallet = path.strip_prefix("/api/earned?wallet=").or_else(|| path.strip_prefix("/api/earned/value?wallet="));
    let rewards = wallet.is_some_and(|w| w.len() == 42 && w.starts_with("0x") && w[2..].chars().all(|c| c.is_ascii_hexdigit()));
    // an ENS name typed where a wallet goes, which the explorer's own search turns into its address
    let name = path.strip_prefix("/api/search?q=").is_some_and(ens_like);
    if rewards || name { Ok(format!("{}{}", explorer_base(), path)) } else { Err("not a rewards read or a name".into()) }
}

/// An ENS name in plain letters, digits and hyphens: two labels or more, nothing that could reach past a query.
fn ens_like(name: &str) -> bool {
    name.len() <= 255
        && name.split('.').count() >= 2
        && name.split('.').all(|label| !label.is_empty() && label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
}

#[tauri::command]
async fn explorer_get(path: String) -> Answer {
    let Ok(url) = explorer_path(&path) else { return Answer { status: 400, body: serde_json::Value::Null } };
    read(url).await
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
// The box: the IMD worker in Docker on this computer, as IMD Box runs it.
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
    for fixed in ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker"] {
        candidates.push(PathBuf::from(fixed));
    }
    // Docker Desktop's own on Windows, installed for this user or for all: its installer puts it on a PATH that an app
    // started before the install never sees
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join(r"Programs\DockerDesktop\resources\bin\docker.exe"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(programs).join(r"Docker\Docker\resources\bin\docker.exe"));
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
        engine_socket().is_some()
    }
    // a pipe with every connection taken is there all the same
    #[cfg(windows)]
    {
        engine_pipes().iter().any(|pipe| open_pipe(pipe).map_or_else(|e| e.raw_os_error() == Some(ERROR_PIPE_BUSY), |_| true))
    }
}

/// A connection to Docker's engine, to speak its API on: its socket on a Mac or Linux, its named pipe on Windows.
#[cfg(unix)]
fn engine_stream() -> Option<std::os::unix::net::UnixStream> {
    let stream = std::os::unix::net::UnixStream::connect(engine_socket()?).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(10 * 60))).ok();
    Some(stream)
}

#[cfg(windows)]
fn engine_stream() -> Option<std::fs::File> {
    engine_pipes().iter().find_map(|pipe| open_pipe(pipe).ok())
}

#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;

#[cfg(windows)]
fn open_pipe(pipe: &str) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().read(true).write(true).open(pipe)
}

/// The pipes Docker's engine answers on: DOCKER_HOST's, if it names one, then Docker Desktop's own, the one its CLI
/// uses first.
#[cfg(windows)]
fn engine_pipes() -> Vec<String> {
    let mut pipes = Vec::new();
    if let Some(pipe) = std::env::var("DOCKER_HOST").ok().and_then(|h| h.strip_prefix("npipe://").map(|p| p.replace('/', "\\"))) {
        pipes.push(pipe);
    }
    pipes.extend([r"\\.\pipe\dockerDesktopLinuxEngine".into(), r"\\.\pipe\docker_engine".into()]);
    pipes
}

/// The socket Docker's engine answers on: Docker Desktop's own, the system one, or DOCKER_HOST's.
#[cfg(unix)]
fn engine_socket() -> Option<PathBuf> {
    let mut sockets = Vec::new();
    if let Some(host) = std::env::var("DOCKER_HOST").ok().and_then(|h| h.strip_prefix("unix://").map(PathBuf::from)) {
        sockets.push(host);
    }
    if let Some(home) = std::env::var_os("HOME") {
        sockets.push(PathBuf::from(home).join(".docker/run/docker.sock"));
    }
    sockets.push(PathBuf::from("/var/run/docker.sock"));
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR") {
        sockets.push(PathBuf::from(run).join("docker.sock"));
    }
    sockets.into_iter().find(|socket| std::os::unix::net::UnixStream::connect(socket).is_ok())
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

/// The running box's id and its worker's device key, once read.
static DEVICE_KEY: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn box_state() -> BoxState {
    tauri::async_runtime::spawn_blocking(|| {
        if docker().is_none() {
            return BoxState { state: "no-docker", installed: false, device_key: None };
        }
        if !engine_listening() {
            return BoxState { state: "docker-down", installed: true, device_key: None };
        }
        // The box answering means the engine does: Docker's own check only when there is no box to ask.
        let inspected = run_docker(&["inspect", "-f", "{{.Id}} {{.State.Running}}", BOX_NAME], Duration::from_secs(10));
        if !inspected.as_ref().is_some_and(|(ok, _)| *ok) && !run_docker(&["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(10)).is_some_and(|(ok, _)| ok) {
            return BoxState { state: "docker-down", installed: true, device_key: None };
        }
        let installed = run_docker(&["image", "inspect", "--format", "{{.Id}}", BOX_IMAGE], Duration::from_secs(10)).is_some_and(|(ok, _)| ok);
        let (container, running) = match &inspected {
            Some((true, out)) => out.split_once(' ').map(|(id, up)| (id.to_string(), up == "true")).unwrap_or_default(),
            _ => (String::new(), false),
        };
        // The worker's key is the box's for its life: asked once per box, not on every look.
        let device_key = if running {
            let mut known = DEVICE_KEY.lock().unwrap_or_else(|e| e.into_inner());
            match known.as_ref() {
                Some((id, key)) if *id == container => Some(key.clone()),
                _ => {
                    let key = run_docker(&["exec", "-u", "imd", BOX_NAME, "imd", "whoami"], Duration::from_secs(20))
                        .filter(|(ok, out)| *ok && out.len() == 64 && out.chars().all(|c| c.is_ascii_hexdigit()))
                        .map(|(_, out)| out);
                    *known = key.clone().map(|key| (container, key));
                    key
                }
            }
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
const BOX_PUBLISHED: &str = "ghcr.io/identity-md/box:latest";
/// The one-off box that pairs, named so that a cancel can stop it.
const BOX_PAIRING: &str = "imd-worker-pair";
/// The one-off box that unlinks, named so that one left behind is cleared before the next.
const BOX_UNLINKING: &str = "imd-worker-unlink";
/// Docker Desktop's installer for this computer's chip, straight from Docker, so Install Docker downloads it rather
/// than opening a page that asks which chip it is for; on Linux, Docker's page.
fn docker_download() -> String {
    if cfg!(target_os = "macos") {
        format!("https://desktop.docker.com/mac/main/{}/Docker.dmg", chip())
    } else if cfg!(target_os = "windows") {
        format!("https://desktop.docker.com/win/main/{}/Docker%20Desktop%20Installer.exe", chip())
    } else {
        "https://www.docker.com/products/docker-desktop/".into()
    }
}

/// This computer's chip, as Docker names it. On Windows it's the PC's own, read from Windows' record of its
/// processor: an x64 build of this app on an Arm PC runs translated, and sees an x64 chip everywhere else.
fn chip() -> &'static str {
    #[cfg(target_os = "windows")]
    if windows_on_arm() {
        return "arm64";
    }
    if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" }
}

#[cfg(target_os = "windows")]
fn windows_on_arm() -> bool {
    registry_text(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "PROCESSOR_ARCHITECTURE").is_some_and(|chip| chip == "ARM64")
}

/// A string as Windows' own calls take it: UTF-16, ending in a zero.
#[cfg(target_os = "windows")]
fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.as_ref().encode_wide().chain(Some(0)).collect()
}

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
    /// "missing", "stopped" (installed, not running) or "running". On Windows, while the restart that turns WSL on is
    /// still to come, "restart" with Docker installed, to start after it, or "restart-wsl" with Docker to install after it.
    docker: &'static str,
    /// Windows: installing Docker here ends in a restart, as WSL isn't installed yet or waits on one.
    restart_ahead: bool,
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
async fn box_setup_state(app: tauri::AppHandle) -> Setup {
    #[cfg(target_os = "windows")]
    let restart = restart_waiting(&app);
    #[cfg(not(target_os = "windows"))]
    let restart = {
        let _ = app;
        false
    };
    let setup = setup_state(restart).await;
    // Docker running, the restart it waited on is behind it
    #[cfg(target_os = "windows")]
    if setup.docker == "running" {
        forget_restart(&app);
    }
    setup
}

async fn setup_state(restart: bool) -> Setup {
    tauri::async_runtime::spawn_blocking(move || {
        let none = |docker| Setup { docker, restart_ahead: false, image: false, worker: false, claude: false, device_key: None };
        if docker().is_none() {
            // a Docker that wouldn't install before the restart goes in after it
            #[cfg(target_os = "windows")]
            if restart && DOCKER_AFTER_RESTART.load(Ordering::Relaxed) {
                return none("restart-wsl");
            }
            return Setup { restart_ahead: restart || wsl_missing(), ..none("missing") };
        }
        // installed, and to start once Windows has turned WSL on
        if restart {
            return none("restart");
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
            restart_ahead: false,
            image: true,
            worker: lines.iter().any(|l| l == "worker"),
            claude: lines.iter().any(|l| l == "claude"),
            device_key: lines.into_iter().find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit())),
        }
    })
    .await
    .unwrap_or(Setup { docker: "missing", restart_ahead: false, image: false, worker: false, claude: false, device_key: None })
}

/// Docker's signing team: Docker Desktop is installed only when it is Docker's own signed app.
#[cfg(target_os = "macos")]
const DOCKER_TEAM: &str = "9BNSXJN65R";

/// Install Docker: Docker Desktop for this Mac's chip, downloaded with its progress shown, checked as Docker's
/// own signed app, put in Applications by Docker's own installer after one macOS password prompt, then opened.
/// The installer accepts Docker's terms, which the setup window states beside the button, and does Docker's
/// privileged setup for this user now, so Docker's first run asks for no password.
///
/// On Windows: WSL first, which Docker's Linux runs on, if it isn't there or is too old, after one prompt from
/// Windows; then Docker Desktop for this user alone, checked as Docker's own signed installer and installed by it
/// with no prompt at all, then opened. True when Windows needs a restart first, to turn on what WSL runs on.
/// On Linux, as before: Docker's page opens, and the setup window waits for Docker to run.
#[tauri::command]
async fn docker_install(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let _busy = Busy::new();
        let dir = std::env::temp_dir().join("imd-docker-install");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dmg = dir.join("Docker.dmg");
        download(&app, "docker", &docker_download(), &dmg).await?;
        let installer = app.clone();
        tauri::async_runtime::spawn_blocking(move || install_docker_from(&installer, &dir, &dmg)).await.map_err(|e| e.to_string())??;
        Ok(false)
    }
    #[cfg(target_os = "windows")]
    {
        let _busy = Busy::new();
        progress(&app, "docker", "Checking this PC…");
        let ready = app.clone();
        let restart = tauri::async_runtime::spawn_blocking(move || prepare_windows(&ready)).await.map_err(|e| e.to_string())??;
        // Docker goes in now even with WSL's restart to come, as Docker's own installer has it: one restart, at the
        // end, and Docker starts after it
        let installed: Result<(), String> = async {
            // a folder of its own, empty: Docker's installer won't run from one with other programs' files in it
            let dir = std::env::temp_dir().join("imd-docker-install");
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let installer = dir.join("Docker Desktop Installer.exe");
            progress(&app, "docker", "Starting the download…");
            download(&app, "docker", &docker_download(), &installer).await?;
            let installs = app.clone();
            tauri::async_runtime::spawn_blocking(move || install_docker_windows(&installs, &dir, &installer, restart)).await.map_err(|e| e.to_string())?
        }
        .await;
        match installed {
            Ok(()) => Ok(restart),
            // turned down before the restart: logged, and Docker goes in after the restart instead
            Err(e) if restart => {
                log_failure(&format!("Docker before WSL's restart: {e}"));
                DOCKER_AFTER_RESTART.store(true, Ordering::Relaxed);
                Ok(true)
            }
            Err(e) => Err(e),
        }
    }
    #[cfg(target_os = "linux")]
    docker_open(app).map(|_| false)
}

// ---------------------------------------------------------------------------------------------
// Windows: WSL, which Docker's Linux runs on, then Docker Desktop for this user alone, and a restart
// when Windows needs one between the two.
// ---------------------------------------------------------------------------------------------

/// Readies Windows for Docker, as Docker's own guide asks: Windows 10 22H2 or 11, virtualization on, and WSL
/// installed and new enough (2.1.5), with the Virtual Machine Platform it runs on. Installing or updating WSL takes
/// Windows' leave, once; turning the platform on takes a restart, after which setup opens again by itself. True
/// when that restart is needed.
#[cfg(target_os = "windows")]
fn prepare_windows(app: &tauri::AppHandle) -> Result<bool, String> {
    if windows_build().is_some_and(|build| build < 19045) {
        return Err("Docker needs Windows 10 22H2 or Windows 11. Update Windows, then try again.".into());
    }
    // an x64 build of this app on an Arm PC sees a translated processor: there Docker's installer checks for itself
    if !windows_on_arm() && !virtualization_on() {
        return Err("Virtualization is off on this PC. Turn it on in its BIOS or UEFI settings, then try again.".into());
    }
    // installed since Windows last started: all that's left of WSL is the restart that turns it on
    if restart_waiting(app) {
        return Ok(true);
    }
    let (version, platform) = (wsl_version(), virtual_machine_platform());
    if version.is_some_and(|v| v >= (2, 1, 5)) && platform != Some(false) {
        return Ok(false);
    }
    // turned on once already and still off after the restart that finishes it: said, rather than gone round again
    if platform == Some(false) && restarted_for_wsl(app) {
        return Err("Windows' Virtual Machine Platform is still off. Turn it on in Windows Features, restart, then try again.".into());
    }
    progress(app, "docker", "Waiting for your OK…");
    let install = version.is_none() || platform == Some(false);
    let code = run_elevated(app, &system32("wsl.exe"), if install { "--install --no-distribution" } else { "--update" }, || {
        progress(app, "docker", if install { "Installing WSL…" } else { "Updating WSL…" })
    })?;
    if code != 0 {
        return Err(format!("WSL didn't install ({code}). Try again, or run wsl --install in a terminal opened as administrator."));
    }
    // a platform turned on now runs from the next start of Windows; unknown, it's off where WSL wasn't installed
    let restart = platform == Some(false) || (platform.is_none() && version.is_none());
    if restart {
        remember_restart(app);
    }
    Ok(restart)
}

/// Docker Desktop installed by Docker's own installer, checked first as Docker's, for this Windows user alone: in
/// their own folders, with no administrator's leave and no service. Then opened, as Docker doesn't start itself.
#[cfg(target_os = "windows")]
fn install_docker_windows(app: &tauri::AppHandle, dir: &Path, installer: &Path, restart: bool) -> Result<(), String> {
    progress(app, "docker", "Verifying Docker…");
    if !docker_signed(installer) {
        let _ = std::fs::remove_dir_all(dir);
        return Err("That download isn't Docker's own signed installer, so nothing was installed.".into());
    }
    progress(app, "docker", "Installing Docker…");
    let installed = hidden(Command::new(installer)).args(["install", "--user", "--quiet", "--accept-license"]).spawn().map_err(|e| e.to_string()).and_then(|mut child| {
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.code().unwrap_or(-1)),
                Ok(None) if started.elapsed() > Duration::from_secs(20 * 60) => {
                    let _ = child.kill();
                    break Err("Docker's installer took over twenty minutes. Try again.".to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(500)),
                Err(e) => break Err(e.to_string()),
            }
        }
    });
    let _ = std::fs::remove_dir_all(dir);
    // its exit codes, as Docker's installer gives them: 3 is a Docker as new or newer here already
    match installed? {
        0 | 3 => {}
        2 => return Err("Docker's install was canceled.".into()),
        4 => return Err("Docker is already installed on this PC by your organization. Open Docker, then try again.".into()),
        -6 => return Err("Another installer is running. Wait for it to finish, then try again.".into()),
        code => return Err(format!("Docker's installer stopped ({code}). Its log is in %LOCALAPPDATA%\\Docker\\install-log.txt.")),
    }
    // WSL's restart still to come: Docker can't start before it, and starts after it with setup
    if restart {
        return Ok(());
    }
    forget_restart(app);
    progress(app, "docker", "Opening Docker…");
    docker_desktop().map(|desktop| Command::new(desktop).spawn()).transpose().map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether a download is Docker's own, as Windows checks a program before it runs it: its signature intact and
/// trusted, and on it Docker's certificate, known by the name and organization in its subject, which Docker keeps
/// as it renews the certificate itself.
#[cfg(target_os = "windows")]
fn docker_signed(file: &Path) -> bool {
    let script = "$s = Get-AuthenticodeSignature -LiteralPath $env:IMD_FILE; '' + $s.Status + '|' + $s.SignerCertificate.Subject";
    powershell(script, &[("IMD_FILE", file.as_os_str())]).is_some_and(|said| signed_by_docker(&said))
}

/// "Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, ST=California, C=US", as PowerShell says a signature of Docker's.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn signed_by_docker(said: &str) -> bool {
    let Some((status, subject)) = said.trim().split_once('|') else { return false };
    let parts: Vec<&str> = subject.split(", ").map(str::trim).collect();
    status == "Valid" && parts.contains(&"CN=Docker Inc") && parts.contains(&"O=Docker Inc")
}

/// A line of PowerShell, run out of sight, and what it printed when it succeeded. Its text has no double quotes, so
/// it reaches PowerShell as written; what it works on comes in by the environment.
#[cfg(target_os = "windows")]
fn powershell(script: &str, env: &[(&str, &std::ffi::OsStr)]) -> Option<String> {
    let mut command = hidden(Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe")));
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (name, value) in env {
        command.env(name, value);
    }
    let out = command.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn system32(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into())).join("System32").join(name)
}

/// The version WSL gives, or None where it isn't installed or is the one Windows came with, which knows no --version.
#[cfg(target_os = "windows")]
fn wsl_version() -> Option<(u32, u32, u32)> {
    let out = hidden(Command::new(system32("wsl.exe"))).arg("--version").env("WSL_UTF8", "1").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().find_map(version_in)
}

/// The first dotted number in a line, as `wsl --version` gives its own in any language: "WSL version: 2.6.1.0".
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn version_in(line: &str) -> Option<(u32, u32, u32)> {
    line.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|token| {
        let mut parts = token.split('.').map(|part| part.parse::<u32>().ok());
        Some((parts.next()??, parts.next()??, parts.next()??))
    })
}

/// Whether Windows' Virtual Machine Platform is on, as Windows' own management data has it, which needs no
/// administrator: None where that can't be read.
#[cfg(target_os = "windows")]
fn virtual_machine_platform() -> Option<bool> {
    let state = powershell("(Get-CimInstance -ClassName Win32_OptionalFeature -Filter 'Name=''VirtualMachinePlatform''').InstallState", &[])?;
    // 1 on, 2 off, 3 absent
    match state.as_str() {
        "1" => Some(true),
        "2" | "3" => Some(false),
        _ => None,
    }
}

/// Windows' build number: 19045 is Windows 10 22H2.
#[cfg(target_os = "windows")]
fn windows_build() -> Option<u32> {
    registry_text(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")?.parse().ok()
}

/// Whether the processor's virtualization is on in the firmware, or a hypervisor already runs, which hides it.
#[cfg(target_os = "windows")]
fn virtualization_on() -> bool {
    use windows_sys::Win32::System::Threading::{IsProcessorFeaturePresent, PF_VIRT_FIRMWARE_ENABLED};
    // CPUID's hypervisor bit, ECX 31 of leaf 1
    #[cfg(target_arch = "x86_64")]
    #[allow(unused_unsafe)]
    let hypervisor = (unsafe { std::arch::x86_64::__cpuid(1) }.ecx >> 31) & 1 == 1;
    #[cfg(not(target_arch = "x86_64"))]
    let hypervisor = false;
    let firmware = unsafe { IsProcessorFeaturePresent(PF_VIRT_FIRMWARE_ENABLED) } != 0;
    firmware || hypervisor
}

/// A text value of Windows' own, from the registry's machine half.
#[cfg(target_os = "windows")]
fn registry_text(key: &str, value: &str) -> Option<String> {
    registry_text_in(windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE, key, value)
}

#[cfg(target_os = "windows")]
fn registry_text_in(root: windows_sys::Win32::System::Registry::HKEY, key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let (key, value) = (wide(key), wide(value));
    let mut buffer = [0u16; 1024];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let read = unsafe { RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) };
    (read == 0).then(|| String::from_utf16_lossy(&buffer[..(size as usize / 2).saturating_sub(1)]))
}

/// Windows 11 keeps a new tray icon out of sight, behind the taskbar's ^, until its person brings it out. This app's
/// icon is its home and says how the agents are, so the first time Windows lists it, it's brought out, as its
/// person would in Settings, by the value Windows keeps for each icon there. Once only: hidden again by hand, it
/// stays hidden. Windows 10 keeps no such list, and its icon stays where Windows puts it.
#[cfg(target_os = "windows")]
fn bring_out_tray_icon(app: &tauri::AppHandle) {
    let Some(done) = app.path().app_local_data_dir().ok().map(|dir| dir.join("tray-icon")) else { return };
    if done.exists() {
        return;
    }
    std::thread::spawn(move || {
        // Windows lists an icon a moment after it first shows
        for _ in 0..30 {
            std::thread::sleep(Duration::from_secs(2));
            if let Some(brought_out) = tray_icon_listed() {
                let _ = done.parent().map(std::fs::create_dir_all);
                let _ = std::fs::write(&done, if brought_out { "brought out" } else { "as its person had it" });
                return;
            }
        }
    });
}

/// This app's icon in Windows' list of tray icons, by the program it names: Some(true) once brought out, Some(false)
/// where its person had chosen already, None while Windows hasn't listed it.
#[cfg(target_os = "windows")]
fn tray_icon_listed() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_DWORD, RRF_RT_REG_DWORD};
    let exe = std::env::current_exe().ok()?;
    // "IMD Agents\imd-agents.exe", the end of the path Windows keeps, which may begin with a known folder's id
    let ours = format!("{}\\{}", exe.parent()?.file_name()?.to_string_lossy(), exe.file_name()?.to_string_lossy()).to_lowercase();
    let mut list: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(r"Control Panel\NotifyIconSettings").as_ptr(), 0, KEY_READ | KEY_SET_VALUE, &mut list) } != 0 {
        return None;
    }
    let mut found = None;
    for index in 0.. {
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        let listed = unsafe { RegEnumKeyExW(list, index, name.as_mut_ptr(), &mut length, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
        if listed != 0 {
            break;
        }
        let entry = String::from_utf16_lossy(&name[..length as usize]);
        if !registry_text_in(list, &entry, "ExecutablePath").is_some_and(|path| path.to_lowercase().ends_with(&ours)) {
            continue;
        }
        let (entry, value) = (wide(&entry), wide("IsPromoted"));
        let (mut promoted, mut size) = (0u32, 4u32);
        let chosen = unsafe { RegGetValueW(list, entry.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut promoted as *mut u32).cast(), &mut size) } == 0;
        if !chosen {
            let on = 1u32;
            unsafe { RegSetKeyValueW(list, entry.as_ptr(), value.as_ptr(), REG_DWORD, (&on as *const u32).cast(), 4) };
        }
        found = Some(!chosen);
        break;
    }
    unsafe { RegCloseKey(list) };
    found
}

/// A program run with Windows' leave to change this PC, as an installer asks for it: Windows dims the screen and
/// names it and its publisher (UAC), the prompt in front of the setup window. Out of sight once allowed, and waited
/// for, up to twenty minutes, for its exit code. `allowed` runs once Windows has let it start.
#[cfg(target_os = "windows")]
fn run_elevated(app: &tauri::AppHandle, program: &Path, args: &str, allowed: impl FnOnce()) -> Result<u32, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
    let (verb, file, params) = (wide("runas"), wide(program), wide(args));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    // the prompt comes up over the window that asked for it, rather than flashing on the taskbar
    if let Some(Ok(hwnd)) = app.get_webview_window("setup").map(|win| win.hwnd()) {
        info.hwnd = hwnd.0 as _;
    }
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;
    // the shell asks for COM on the thread that calls it
    let com = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) } >= 0;
    let started = unsafe { ShellExecuteExW(&mut info) } != 0;
    let error = unsafe { GetLastError() };
    if com {
        unsafe { CoUninitialize() };
    }
    if !started || info.hProcess.is_null() {
        return Err(if error == ERROR_CANCELLED {
            "Nothing was installed: Windows' prompt was canceled. Try again and choose Yes.".into()
        } else {
            format!("Windows didn't start {} ({error}).", program.file_name().unwrap_or_default().to_string_lossy())
        });
    }
    allowed();
    let finished = unsafe { WaitForSingleObject(info.hProcess, 20 * 60 * 1000) } == WAIT_OBJECT_0;
    let mut code = 0u32;
    if finished {
        unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
    } else {
        unsafe { TerminateProcess(info.hProcess, 1) };
    }
    unsafe { CloseHandle(info.hProcess) };
    if finished { Ok(code) } else { Err("That took over twenty minutes. Try again.".into()) }
}

/// The restart Windows needs to turn on what WSL runs on, kept in a file in the app's data with the moment Windows
/// last started: once Windows has started again since, it's done, and the file says so, so a platform still off
/// after it isn't turned on again in a loop.
#[cfg(target_os = "windows")]
fn restart_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("restart-for-wsl"))
}

#[cfg(target_os = "windows")]
fn booted_at() -> u64 {
    unix_now().saturating_sub(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() } / 1000)
}

#[cfg(target_os = "windows")]
fn restart_waiting(app: &tauri::AppHandle) -> bool {
    let Some(file) = restart_file(app) else { return false };
    match std::fs::read_to_string(&file).ok().and_then(|said| said.trim().parse::<u64>().ok()) {
        // two minutes' grace, for a clock set right since
        Some(at) if booted_at() <= at + 120 => true,
        Some(_) => {
            let _ = std::fs::write(&file, "restarted");
            false
        }
        None => false,
    }
}

/// Docker's installer turned down before the restart that turns WSL on, so Docker goes in after it instead.
#[cfg(target_os = "windows")]
static DOCKER_AFTER_RESTART: AtomicBool = AtomicBool::new(false);

/// Whether WSL is still to install, which ends in a restart: looked at once, the first time setup asks.
#[cfg(target_os = "windows")]
fn wsl_missing() -> bool {
    static MISSING: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MISSING.get_or_init(|| wsl_version().is_none())
}

#[cfg(not(target_os = "windows"))]
fn wsl_missing() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn restarted_for_wsl(app: &tauri::AppHandle) -> bool {
    restart_file(app).and_then(|file| std::fs::read_to_string(file).ok()).is_some_and(|said| said.trim() == "restarted")
}

/// Remembers the restart, and has Windows open setup again after it: once, at the next sign-in, as Windows runs
/// what its RunOnce list names.
#[cfg(target_os = "windows")]
fn remember_restart(app: &tauri::AppHandle) {
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    if let Some(file) = restart_file(app) {
        let _ = file.parent().map(std::fs::create_dir_all);
        let _ = std::fs::write(&file, booted_at().to_string());
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let line = wide(format!("\"{}\" {SETUP}", exe.display()));
    let (key, name) = (wide(r"Software\Microsoft\Windows\CurrentVersion\RunOnce"), wide("IMD Agents setup"));
    unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, line.as_ptr().cast(), (line.len() * 2) as u32) };
}

#[cfg(target_os = "windows")]
fn forget_restart(app: &tauri::AppHandle) {
    if let Some(file) = restart_file(app) {
        let _ = std::fs::remove_file(file);
    }
}

/// Restarts Windows, from setup's button, only while the restart WSL needs is still to come. Windows asks any app
/// with unsaved work first, and setup opens again after.
#[tauri::command]
fn restart_pc(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !restart_waiting(&app) {
            return Err("Windows has no restart waiting.".into());
        }
        remember_restart(&app);
        let restarted = hidden(Command::new(system32("shutdown.exe"))).args(["/r", "/t", "0"]).status().is_ok_and(|status| status.success());
        if restarted { Ok(()) } else { Err("Windows didn't restart. Restart it from the Start menu.".into()) }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Only Windows restarts from setup.".into())
    }
}

/// Whether a disk image or an app is Docker's own: intact, and signed by Docker's team.
#[cfg(target_os = "macos")]
fn docker_signed(app: &Path) -> bool {
    let intact = Command::new("codesign").args(["--verify", "--strict"]).arg(app).status().is_ok_and(|status| status.success());
    let signer = Command::new("codesign").arg("-dv").arg(app).output().map(|out| String::from_utf8_lossy(&out.stderr).to_string()).unwrap_or_default();
    intact && signer.lines().any(|line| line == format!("TeamIdentifier={DOCKER_TEAM}"))
}

/// A download to a file, its progress said every few megabytes.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn download(app: &tauri::AppHandle, step: &'static str, url: &str, to: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut response = http_long().get(url).send().await.map_err(|_| "Couldn't reach Docker's download. Check the connection, then try again.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Docker's download answered {}. Try again in a few minutes.", response.status()));
    }
    let total = response.content_length();
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let (mut got, mut said) = (0u64, u64::MAX);
    while let Some(chunk) = response.chunk().await.map_err(|_| "The download stopped. Check the connection, then try again.".to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if said == u64::MAX || got - said >= 5_000_000 || Some(got) == total {
            said = got;
            progress(app, step, match total {
                Some(total) => format!("Downloading {} of {} MB", mb(got), mb(total)),
                None => format!("Downloading {} MB", mb(got)),
            });
        }
    }
    file.flush().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn install_docker_from(app: &tauri::AppHandle, dir: &Path, dmg: &Path) -> Result<(), String> {
    // Docker signs its disk image, and that signature covers everything in it: checked in about a second,
    // where checking the app inside read all two gigabytes of it, a minute or two on an older Mac
    progress(app, "docker", "Verifying Docker…");
    if !docker_signed(dmg) {
        let _ = std::fs::remove_dir_all(dir);
        return Err("That download isn't Docker's own signed installer, so nothing was installed.".into());
    }
    // its contents are checked by that signature already: opened without hdiutil's own slow pass over them
    let mount = dir.join("mount");
    let attached = Command::new("hdiutil").args(["attach", "-noverify", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"]).arg(&mount).arg(dmg).status();
    if !attached.is_ok_and(|status| status.success()) {
        let _ = std::fs::remove_dir_all(dir);
        return Err("Docker's download didn't open. Try again.".into());
    }
    let installed = (|| {
        let docker = mount.join("Docker.app");
        let user = std::env::var("USER").unwrap_or_default();
        if user.is_empty() || !user.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err("Couldn't tell which user to install Docker for.".into());
        }
        progress(app, "docker", "Waiting for your password…");
        let install = docker.join("Contents/MacOS/install");
        run_as_admin(app, &format!("'{}' --accept-license --user={user}", install.display()), "IMD Agents is installing Docker Desktop.", &dir.join("install"))
    })();
    if !Command::new("hdiutil").args(["detach", "-quiet"]).arg(&mount).status().is_ok_and(|status| status.success()) {
        let _ = Command::new("hdiutil").args(["detach", "-force", "-quiet"]).arg(&mount).status();
    }
    let _ = std::fs::remove_dir_all(dir);
    installed?;
    progress(app, "docker", "Opening Docker…");
    let _ = Command::new("open").args(["-a", "Docker"]).status();
    Ok(())
}

/// A command run as root after the macOS password box, asked from inside this app so the box names IMD Agents,
/// with its icon, rather than "osascript". The script has to run on the main thread, which it holds only while
/// the box is up: the command itself goes on in the background, and its exit code is waited for here.
#[cfg(target_os = "macos")]
fn run_as_admin(app: &tauri::AppHandle, shell: &str, prompt: &str, scratch: &Path) -> Result<(), String> {
    use objc2::AnyThread;
    use objc2_foundation::{NSAppleScript, NSString};
    let status = scratch.with_extension("status");
    let log = scratch.with_extension("log");
    let _ = std::fs::remove_file(&status);
    let quoted = |path: &Path| format!("'{}'", path.display());
    let background = format!("({shell}; echo $? > {}) > {} 2>&1 &", quoted(&status), quoted(&log));
    let source = format!(
        "do shell script \"{}\" with prompt \"{prompt}\" with administrator privileges",
        background.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let answer = match NSAppleScript::initWithSource(NSAppleScript::alloc(), &NSString::from_str(&source)) {
            None => Err("Couldn't ask for the password.".to_string()),
            Some(script) => {
                let mut error = None;
                unsafe { script.executeAndReturnError(Some(&mut error)) };
                match error {
                    None => Ok(()),
                    Some(error) if format!("{error:?}").contains("-128") => Err("Docker wasn't installed: the password was canceled.".to_string()),
                    Some(error) => Err(format!("The password box didn't open: {error:?}")),
                }
            }
        };
        let _ = tx.send(answer);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;
    // the installer runs as root now; done when it writes its exit code
    let started = std::time::Instant::now();
    app_progress_while_installing(app, &status, started)?;
    let code = std::fs::read_to_string(&status).unwrap_or_default();
    if code.trim() == "0" {
        return Ok(());
    }
    let said = std::fs::read_to_string(&log).unwrap_or_default();
    Err(format!("Docker's installer stopped: {}", said.trim().lines().last().unwrap_or("no reason given")))
}

/// Waits for Docker's installer, saying so, for up to ten minutes.
#[cfg(target_os = "macos")]
fn app_progress_while_installing(app: &tauri::AppHandle, status: &Path, started: std::time::Instant) -> Result<(), String> {
    progress(app, "docker", "Installing Docker…");
    while !status.exists() {
        if started.elapsed() > Duration::from_secs(10 * 60) {
            return Err("Docker's installer took over ten minutes. Try again.".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // written as it ends: a moment for the shell to finish writing it
    std::thread::sleep(Duration::from_millis(200));
    Ok(())
}

/// Docker Desktop: its installer when it is not installed, the app itself when it is not running.
#[tauri::command]
fn docker_open(app: tauri::AppHandle) -> Result<(), String> {
    if docker().is_none() {
        return app.opener().open_url(docker_download(), None::<&str>).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    let opened = Command::new("open").args(["-a", "Docker"]).status().is_ok_and(|status| status.success());
    // started and left to run, as the Start menu starts it
    #[cfg(target_os = "windows")]
    let opened = docker_desktop().is_some_and(|desktop| Command::new(desktop).spawn().is_ok());
    #[cfg(target_os = "linux")]
    let opened = Command::new("systemctl").args(["--user", "start", "docker-desktop"]).status().is_ok_and(|status| status.success());
    if opened { Ok(()) } else { Err("Open Docker yourself, then come back".into()) }
}

/// Docker Desktop's app on Windows: three folders up from its CLI, wherever it was installed.
#[cfg(target_os = "windows")]
fn docker_desktop() -> Option<PathBuf> {
    docker().and_then(|cli| Some(cli.parent()?.parent()?.parent()?.join("Docker Desktop.exe"))).filter(|path| path.is_file())
}

/// Downloads the published box and names it as `./box` names its own build, so either runs it. Asked of the
/// engine itself where it can be, so the download says how far it has got.
#[tauri::command]
async fn box_pull(app: tauri::AppHandle) -> Result<(), String> {
    let _busy = Busy::new();
    let through_engine = match engine_stream() {
        Some(stream) => {
            let total = published_size().await;
            let reporter = app.clone();
            Some(
                tauri::async_runtime::spawn_blocking(move || pull_through_engine(stream, "ghcr.io/identity-md/box", "latest", total, &mut |words| progress(&reporter, "pull", words)))
                    .await
                    .map_err(|e| e.to_string())?,
            )
        }
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        match through_engine {
            Some(Ok(())) => {}
            Some(Err(why)) => return Err(why),
            None => match run_docker(&["pull", BOX_PUBLISHED], Duration::from_secs(30 * 60)) {
                Some((true, _)) => {}
                Some((false, why)) => return Err(docker_failure(why, "could not download the box")),
                None => return Err("Docker is not installed".into()),
            },
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

/// The published box's size for this computer's chip, as the registry lists its layers: the whole a download counts
/// toward. None when the registry doesn't answer; the download then counts megabytes alone.
async fn published_size() -> Option<u64> {
    let client = http();
    let token: serde_json::Value = client.get("https://ghcr.io/token?scope=repository:identity-md/box:pull").send().await.ok()?.json().await.ok()?;
    let token = token["token"].as_str()?.to_string();
    let index: serde_json::Value = client
        .get("https://ghcr.io/v2/identity-md/box/manifests/latest")
        .bearer_auth(&token)
        .header("Accept", "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json")
        .send().await.ok()?.json().await.ok()?;
    let digest = index["manifests"].as_array()?.iter().find(|m| m["platform"]["os"] == "linux" && m["platform"]["architecture"] == chip())?["digest"].as_str()?.to_string();
    let manifest: serde_json::Value = client
        .get(format!("https://ghcr.io/v2/identity-md/box/manifests/{digest}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
        .send().await.ok()?.json().await.ok()?;
    Some(manifest["layers"].as_array()?.iter().filter_map(|layer| layer["size"].as_u64()).sum())
}

/// The pull, asked of the engine over its socket or pipe rather than of Docker's CLI, whose progress bars go only
/// to a terminal: it answers with a line of JSON per layer as each moves, which add up to how far it has got.
fn pull_through_engine(mut stream: impl std::io::Read + std::io::Write, image: &str, tag: &str, total: Option<u64>, say: &mut dyn FnMut(String)) -> Result<(), String> {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    // HTTP/1.0, so the answer streams plainly until the engine closes it, without chunking to undo
    let request = format!("POST /images/create?fromImage={}&tag={tag} HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n", image.replace('/', "%2F"));
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status).map_err(|e| e.to_string())?;
    if !status.split_whitespace().nth(1).is_some_and(|code| code == "200") {
        let mut rest = String::new();
        let _ = std::io::Read::read_to_string(&mut reader, &mut rest);
        let why = rest.lines().rev().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v["message"].as_str().map(str::to_string)));
        return Err(why.unwrap_or_else(|| status.trim().to_string()));
    }
    // past the headers
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    // each layer's bytes so far, and those done in full
    let mut layers: HashMap<String, (u64, u64, bool)> = HashMap::new();
    let mut said = (u64::MAX, false);
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        if let Some(why) = event["errorDetail"]["message"].as_str().or_else(|| event["error"].as_str()) {
            return Err(why.to_string());
        }
        // a layer's events carry its id; the first line carries the tag's, "latest: Pulling from …", and is no layer
        let status = event["status"].as_str().unwrap_or("");
        let Some(id) = event["id"].as_str().filter(|_| !status.starts_with("Pulling from")) else { continue };
        let entry = layers.entry(id.to_string()).or_insert((0, 0, false));
        match status {
            "Downloading" => {
                entry.0 = event["progressDetail"]["current"].as_u64().unwrap_or(entry.0);
                entry.1 = event["progressDetail"]["total"].as_u64().unwrap_or(entry.1);
            }
            "Download complete" | "Verifying Checksum" => entry.2 = true,
            "Extracting" | "Pull complete" | "Already exists" => entry.2 = true,
            _ => {}
        }
        let got: u64 = layers.values().map(|(current, size, done)| if *done && *size > 0 { *size } else { *current }).sum();
        let unpacking = !layers.is_empty() && layers.values().all(|(_, _, done)| *done);
        let step = mb(got);
        if (step, unpacking) != said {
            said = (step, unpacking);
            say(if unpacking {
                "Unpacking…".to_string()
            } else {
                match total {
                    Some(total) if total > 0 => format!("Downloading {} of {} MB", step.min(mb(total)), mb(total)),
                    _ => format!("Downloading {step} MB"),
                }
            });
        }
    }
    Ok(())
}

/// Installs the worker and Claude Code into the box's volume, as `./box setup` does before its shell.
#[tauri::command]
async fn box_install(app: tauri::AppHandle) -> Result<(), String> {
    // installing or pairing may give the worker a new key: read it fresh
    *DEVICE_KEY.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, Read};
        let mut args: Vec<String> = vec!["run".into(), "--rm".into()];
        args.extend(box_flags());
        args.extend([BOX_IMAGE.to_string(), "imd-box-setup".into()]);
        let mut command = docker_command().ok_or("Docker is not installed")?;
        command.args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let mut stderr = child.stderr.take();
        // what setup.sh says it is doing, a line at a time, under the step
        if let Some(stdout) = child.stdout.take() {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                let words = if line.starts_with("Installing Claude Code") {
                    "Installing Claude Code…"
                } else if line.starts_with("Installing the IMD worker") {
                    "Installing the IMD worker…"
                } else if line.starts_with("Connecting the browser") {
                    "Setting up its browser…"
                } else {
                    continue;
                };
                progress(&app, "install", words);
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        let mut why = String::new();
        if let Some(err) = stderr.as_mut() {
            let _ = err.read_to_string(&mut why);
        }
        Err(docker_failure(why, "could not install the worker"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude's sign-in is Claude's own, in a terminal: a window opens on Claude Code inside the box,
/// with one line saying what to type. The panel sees it done when the sign-in file appears.
#[tauri::command]
fn box_sign_in() -> Result<(), String> {
    // what to answer, said before Claude Code asks: after the sign-in it asks whether to trust the box's home,
    // and No ends the session with the sign-in kept. No apostrophes: it is echoed inside single quotes
    let say = "Sign in to Claude for your IMD agent, in your browser. When it then asks whether you trust this folder, choose No, exit. Your sign-in stays in the box.";
    #[cfg(unix)]
    let (docker, flags) = (
        docker().ok_or("Docker is not installed")?.to_string_lossy().to_string(),
        // quoted, for the seccomp profile's path, which a temporary folder can put a space in
        box_flags().iter().map(|flag| format!("'{flag}'")).collect::<Vec<_>>().join(" "),
    );
    #[cfg(target_os = "macos")]
    {
        let line = format!("clear; echo '{say}'; echo; '{docker}' run -it --rm {flags} {BOX_IMAGE} claude; exit");
        let script = format!("tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell", line.replace('\\', "\\\\").replace('"', "\\\""));
        let out = Command::new("osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            // -1743: the Mac's Automation prompt was answered Don't Allow, and Terminal never opens
            let said = String::from_utf8_lossy(&out.stderr);
            return Err(if said.contains("-1743") {
                "Your Mac didn't let IMD Agents open Terminal. Allow it in System Settings, Privacy & Security, Automation, then try again.".into()
            } else {
                format!("Terminal didn't open: {}", said.trim())
            });
        }
    }
    // a console window of its own, in Terminal or the classic console as Windows is set: Docker's CLI run in it
    // directly, so each argument reaches it whole, and the box says what to answer before Claude Code starts
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut command = docker_command().ok_or("Docker is not installed")?;
        command.creation_flags(CREATE_NEW_CONSOLE).args(["run", "-it", "--rm"]).args(box_flags());
        command.args([BOX_IMAGE, "sh", "-c", &format!("echo '{say}'; echo; exec claude")]);
        command.spawn().map_err(|e| e.to_string())?;
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

/// How a pairing ended, for a setup window opened again while it waited, and for the panel: the agent it connected,
/// or why it didn't.
#[derive(Serialize, Clone)]
struct PairEnded {
    token_id: Option<String>,
    error: Option<String>,
}

/// The pairing under way, while `imd pair` waits for a wallet: its code and page. Setup opened again shows this one
/// rather than making a new one, which would end it, and its link may already be with a friend.
static PAIRING: std::sync::Mutex<Option<PairingCode>> = std::sync::Mutex::new(None);

fn set_pairing(pairing: Option<PairingCode>) {
    *PAIRING.lock().unwrap_or_else(|e| e.into_inner()) = pairing;
}

/// The pairing under way, if there is one.
#[tauri::command]
fn pairing_pending() -> Option<PairingCode> {
    PAIRING.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Pairs the box with the wallet that holds an agent: `imd pair` in a one-off box, its code and page
/// handed to the panel as soon as it prints them, then its answer once the wallet has signed. Connected, the
/// agent starts at once, so a seat approved while no one is at the window, as a friend's can be, goes to work.
#[tauri::command]
async fn box_pair(app: tauri::AppHandle, runtime: String) -> Result<Paired, String> {
    if !RUNTIMES.contains(&runtime.as_str()) {
        return Err("unknown runtime".into());
    }
    // installing or pairing may give the worker a new key: read it fresh
    *DEVICE_KEY.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let _busy = Busy::new();
    let answer = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || pair_and_start(&app, &runtime)
    })
    .await
    .map_err(|e| e.to_string())?;
    let ended = match &answer {
        Ok(paired) => PairEnded { token_id: paired.token_id.clone(), error: None },
        Err(why) => PairEnded { token_id: None, error: Some(why.clone()) },
    };
    let _ = app.emit("box-pair-ended", ended);
    answer
}

fn pair_and_start(app: &tauri::AppHandle, runtime: &str) -> Result<Paired, String> {
    let answer = (|| {
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
                let pairing = PairingCode { code: code.clone(), url: line.to_string() };
                set_pairing(Some(pairing.clone()));
                let _ = app.emit("box-pairing", pairing);
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
    })();
    set_pairing(None);
    // connected is running: the box starts now, unless its seat must be registered first. A start that fails is
    // left to setup's last screen, whose Start says why
    if let Ok(paired) = &answer {
        if paired.register.is_none() {
            progress(app, "pair", "Starting your agent…");
            let _ = run_box(runtime);
        }
    }
    answer
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

/// Copies the network's pairing link for this box, for its person to send to a friend whose seat it will run, who
/// approves it from their own wallet: the network's own page, never another.
#[tauri::command]
fn copy_pairing(url: String) -> Result<(), String> {
    if !pairing_link(&url) {
        return Err("not a pairing link".into());
    }
    copy_text(&url)
}

/// The network's pairing page for one code, exactly as `imd pair` prints it.
fn pairing_link(url: &str) -> bool {
    url.strip_prefix(&format!("{}/pair?code=", api_base())).is_some_and(pairing_code)
}

/// imdLend, the market where seats are lent, which the network doesn't run.
const LEND: &str = "https://imdlend.com";

/// Opens one of imdLend's pages, and no other: its pairing page, for a seat borrowed there, which takes the box's code
/// from its link; a new listing, for a seat of this wallet's to lend; the lender's vaults, where a lent seat is withdrawn
/// or lent again; the borrower's lendings; or its rewards, where a vault's are claimed for its owner and its operator at
/// once.
#[tauri::command]
fn open_lend(app: tauri::AppHandle, page: String, code: Option<String>, seat: Option<String>) -> Result<(), String> {
    let url = match page.as_str() {
        "pair" => {
            let code = code.filter(|c| pairing_code(c)).ok_or("not a pairing code")?;
            format!("{LEND}/run/pair?code={code}")
        }
        "vaults" => format!("{LEND}/lend/vaults"),
        "run" => format!("{LEND}/run"),
        "list" => {
            let seat = seat.filter(|s| seat_number(s)).ok_or("not a seat number")?;
            format!("{LEND}/lend/new?seat={seat}")
        }
        "rewards" => format!("{LEND}/rewards"),
        _ => return Err("not an imdLend page".into()),
    };
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// imdLend's market on Ethereum, which made every vault, and so can say whether an address is one.
const LEND_MARKET: &str = "0x2008b60c94e97a0f5315fc90a0aafe9e3bd78f7d";

/// What imdLend fixed when it made a vault: who lent the seat, who runs it, and the lender's share in basis points.
/// None of it ever changes.
#[derive(Serialize, Debug, PartialEq)]
struct Terms {
    owner: String,
    operator: String,
    owner_bps: u16,
}

/// When a seat's latest lending in its vault began and ends (or ended), in seconds. The vault counts it as on until its
/// end (`isNftLent`), so the clock says when it's over.
#[derive(Serialize, Debug, PartialEq)]
struct Span {
    started_at: u64,
    ends_at: u64,
}

/// A vault's terms, read from its code where the vault itself reads them (`Clones.fetchCloneArgs`): a clone's 45 bytes
/// pointing at imdLend's vault code, then the lender, the borrower and the share, a word each. Any other code, a wallet's
/// delegation or another contract, is no vault.
fn clone_terms(code: &str) -> Option<Terms> {
    if code.len() != 282 || !code.starts_with("363d3d373d3d3d363d73") || code.get(60..90) != Some("5af43d82803e903d91602b57fd5bf3") {
        return None;
    }
    let args = code.get(90..)?;
    let owner_bps = word_u64(args, 2).and_then(|b| u16::try_from(b).ok())?;
    Some(Terms { owner: word_address(args, 0)?, operator: word_address(args, 1)?, owner_bps })
}

/// Whether a seat's holder is one of imdLend's vaults, and its terms if so: one read of its code, then the market's word
/// that the vault for those terms lives at that address, so a contract that only looks like a vault isn't taken for one.
/// Neither answer ever changes, so the app asks once per holder. None when the holder isn't a vault; an error when the
/// chain couldn't be read, which says nothing either way.
#[tauri::command]
async fn lend_vault(holder: String) -> Result<Option<Terms>, String> {
    let holder = holder.to_ascii_lowercase();
    if !hex_address(&holder) {
        return Err("not an address".into());
    }
    let Some(terms) = rpc("eth_getCode", serde_json::json!([holder, "latest"])).await?.as_deref().and_then(clone_terms) else { return Ok(None) };
    let at = format!("b369ec51{:0>64}{:0>64}{:064x}", &terms.owner[2..], &terms.operator[2..], terms.owner_bps);
    let made = eth_call(LEND_MARKET, &at).await?.and_then(|w| word_address(&w, 0));
    Ok((made.as_deref() == Some(holder.as_str())).then_some(terms))
}

/// A seat's latest lending in a vault the app has checked: one call, `getLending`. None for a seat the vault never lent.
#[tauri::command]
async fn lend_span(vault: String, seat: String) -> Result<Option<Span>, String> {
    let vault = vault.to_ascii_lowercase();
    if !hex_address(&vault) || !seat_number(&seat) {
        return Err("not a vault and a seat".into());
    }
    let token = format!("{:064x}", seat.parse::<u64>().map_err(|e| e.to_string())?);
    let span = eth_call(&vault, &format!("b3277d3e{token}")).await?.ok_or("no answer to getLending")?;
    let (Some(started_at), Some(ends_at)) = (word_u64(&span, 0), word_u64(&span, 1)) else { return Err("an unreadable lending".into()) };
    Ok((started_at > 0).then_some(Span { started_at, ends_at }))
}

/// An address as 0x and 40 hex digits.
fn hex_address(text: &str) -> bool {
    text.len() == 42 && text.starts_with("0x") && text[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// One call to a contract on Ethereum: what it returned, or nothing when it refused, as a contract without that function
/// does.
async fn eth_call(to: &str, data: &str) -> Result<Option<String>, String> {
    rpc("eth_call", serde_json::json!([{ "to": to, "data": format!("0x{data}") }, "latest"])).await
}

/// One read of Ethereum, through the explorer's endpoint: what it returned, as lowercase hex without its 0x; nothing when
/// it returned nothing or a call was refused; an error when it couldn't be asked.
async fn rpc(method: &str, params: serde_json::Value) -> Result<Option<String>, String> {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let response = http().post(format!("{}/api/rpc/1", explorer_base())).json(&body).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the chain's endpoint answered {}", response.status()));
    }
    let answer: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if let Some(error) = answer.get("error") {
        // the call ran and the contract refused it: an answer, not a failure to ask
        let said = error.to_string().to_ascii_lowercase();
        return if said.contains("revert") { Ok(None) } else { Err(said) };
    }
    let result = answer.get("result").and_then(|r| r.as_str()).and_then(|r| r.strip_prefix("0x")).ok_or("no result")?;
    if !result.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("an answer that isn't hex".into());
    }
    Ok((!result.is_empty()).then(|| result.to_ascii_lowercase()))
}

/// The `index`th 32-byte word of a call's answer.
fn word(hex: &str, index: usize) -> Option<&str> {
    hex.get(index * 64..(index + 1) * 64)
}

/// A word holding an address, as 0x and 40 hex digits.
fn word_address(hex: &str, index: usize) -> Option<String> {
    let word = word(hex, index)?;
    word[..24].bytes().all(|b| b == b'0').then(|| format!("0x{}", &word[24..]))
}

/// A word holding a number that fits 64 bits: a time, a share, a yes or no.
fn word_u64(hex: &str, index: usize) -> Option<u64> {
    let word = word(hex, index)?;
    if !word[..48].bytes().all(|b| b == b'0') {
        return None;
    }
    u64::from_str_radix(&word[48..], 16).ok()
}

/// A seat's number, and nothing else, to go in a link.
fn seat_number(seat: &str) -> bool {
    (1..=6).contains(&seat.len()) && seat.chars().all(|c| c.is_ascii_digit())
}

/// A pairing code as the network makes them: four to sixteen capitals and digits, nothing to escape in a link.
fn pairing_code(code: &str) -> bool {
    (4..=16).contains(&code.len()) && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// Text onto the clipboard, by the computer's own tool for it.
fn copy_text(text: &str) -> Result<(), String> {
    use std::io::Write;
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/pbcopy");
    #[cfg(windows)]
    let mut command = hidden(Command::new("clip"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        Command::new("wl-copy")
    } else {
        let mut command = Command::new("xclip");
        command.args(["-selection", "clipboard"]);
        command
    };
    let mut child = command.stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("no input")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("the clipboard said {status}")) }
}

/// Stops a pairing that is waiting for a signature.
#[tauri::command]
async fn box_pair_cancel() {
    set_pairing(None);
    let _ = tauri::async_runtime::spawn_blocking(|| run_docker(&["rm", "-f", BOX_PAIRING], Duration::from_secs(30))).await;
}

/// What the box's worker can run on.
const RUNTIMES: [&str; 4] = ["claude", "codex", "claude,grok", "codex,grok"];

/// Makes the box and starts it, exactly as `./box start` does: nothing of this computer mounted, every
/// capability dropped but the few the firewall needs before it hands over to the worker's own user.
fn run_box(runtime: &str) -> Result<(), String> {
    let _ = run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(30));
    let mut args: Vec<String> = ["run", "-d", "--name", BOX_NAME, "--restart", "unless-stopped"].iter().map(|s| s.to_string()).collect();
    args.extend(box_flags());
    args.extend([BOX_IMAGE, "imd", "start", "--runtime", runtime, "--auto-update"].iter().map(|s| s.to_string()));
    match run_docker(&args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(120)) {
        Some((true, _)) => Ok(()),
        Some((false, why)) => Err(docker_failure(why, "could not start")),
        None => Err("Docker is not installed".into()),
    }
}

/// Whether a box was made with the flags this app gives one, read from `docker inspect` as its security
/// options and how many paths of /proc it masks: a seccomp profile of its own, and none masked. One made
/// by an older IMD Agents has neither, and its worker's read jail cannot start.
fn sealed(inspect: &str) -> bool {
    let (options, masked) = inspect.trim().rsplit_once(' ').unwrap_or(("", ""));
    options.contains("seccomp=") && masked == "0"
}

/// Starts the box, made new each time, so it always has the flags above.
#[tauri::command]
async fn box_start(runtime: String) -> Result<(), String> {
    if !RUNTIMES.contains(&runtime.as_str()) {
        return Err("unknown runtime".into());
    }
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(move || run_box(&runtime))
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

/// Takes this computer off its seat before the seat is listed, as imdLend asks of every lender: its box removed, then
/// `imd unlink`, signed with this computer's own key, in a one-off box. Removed, the box doesn't start again by itself.
#[tauri::command]
async fn box_unlink() -> Result<(), String> {
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(|| {
        match run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(60)) {
            Some((true, _)) => {}
            Some((false, why)) if why.contains("No such container") => {}
            Some((false, why)) => return Err(why),
            None => return Err("Docker is not installed".into()),
        }
        let _ = run_docker(&["rm", "-f", BOX_UNLINKING], Duration::from_secs(30));
        let mut args: Vec<String> = vec!["run".into(), "--rm".into(), "--name".into(), BOX_UNLINKING.into()];
        args.extend(box_flags());
        args.extend([BOX_IMAGE.to_string(), "imd".into(), "unlink".into()]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_docker(&args, Duration::from_secs(90)) {
            Some((true, _)) => Ok(()),
            Some((false, why)) => Err(why.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("this computer could not be unlinked").to_string()),
            None => Err("Docker is not installed".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restarts this computer's agent: the same box, started again. It runs with `--auto-update`, so a
/// restart is also how it takes the newest worker. A box made without the sandbox's flags, as an older
/// IMD Agents made them, is made again with them, so Restart is also what lets its read jail start.
#[tauri::command]
async fn box_restart(runtime: String) -> Result<(), String> {
    if !RUNTIMES.contains(&runtime.as_str()) {
        return Err("unknown runtime".into());
    }
    let _busy = Busy::new();
    tauri::async_runtime::spawn_blocking(move || {
        let made = run_docker(&["inspect", "--format", "{{json .HostConfig.SecurityOpt}} {{len .HostConfig.MaskedPaths}}", BOX_NAME], Duration::from_secs(10));
        match made {
            None => Err("Docker is not installed".into()),
            Some((true, out)) if sealed(&out) => match run_docker(&["restart", "--time", "30", BOX_NAME], Duration::from_secs(90)) {
                Some((true, _)) => Ok(()),
                Some((false, why)) => Err(why),
                None => Err("Docker is not installed".into()),
            },
            // made without the sandbox's flags, or gone: the worker stops as a restart stops it, and the box is made again
            _ => {
                let _ = run_docker(&["stop", "--time", "30", BOX_NAME], Duration::from_secs(60));
                run_box(&runtime)
            }
        }
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
/// The panel at its tallest, with its inset: the page shows no more than 720 points of it.
const PANEL_TALLEST: f64 = 720.0 + INSET_TOP + INSET_BOTTOM;

/// The window is as tall as the panel shows, its inset included. A resize alone keeps a window's bottom
/// edge on macOS, so the edge by the icon is put back: the top under a menu bar, the bottom over a taskbar.
/// Windows resizes no window under the panel: see `clip_panel`.
#[tauri::command]
fn fit_panel(window: tauri::WebviewWindow, height: f64) {
    let height = height.clamp(80.0 + INSET_TOP + INSET_BOTTOM, PANEL_TALLEST);
    #[cfg(target_os = "windows")]
    {
        PANEL_HEIGHT.store(height.to_bits(), Ordering::Relaxed);
        clip_panel(&window, height);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let scale = window.scale_factor().unwrap_or(1.0);
        let before = window.outer_position().ok().zip(window.outer_size().ok());
        let _ = window.set_size(LogicalSize::new(PANEL_WIDTH + 2.0 * INSET_SIDE, height));
        if let Some((position, size)) = before {
            let y = if PANEL_ABOVE.load(Ordering::Relaxed) { position.y as f64 + size.height as f64 - height * scale } else { position.y as f64 };
            let _ = window.set_position(PhysicalPosition::new(position.x as f64, y));
        }
    }
}

/// Windows: how tall the panel last showed, its inset included, for its region on the next opening.
#[cfg(target_os = "windows")]
static PANEL_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Windows: a window resized under WebView2 shows its old page for a frame at the new size, so the panel grows
/// and shrinks in a window that stays at its tallest. Only the window's region follows it: the part Windows draws
/// and sends clicks to, the panel and its inset at the end by the taskbar. Clicks on the rest reach what's behind.
#[cfg(target_os = "windows")]
fn clip_panel(window: &tauri::WebviewWindow, height: f64) {
    use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    let (Ok(hwnd), Ok(size), Ok(scale)) = (window.hwnd(), window.outer_size(), window.scale_factor()) else { return };
    let (width, tallest) = (size.width as i32, size.height as i32);
    let tall = ((height * scale).round() as i32).min(tallest);
    let top = if PANEL_ABOVE.load(Ordering::Relaxed) { tallest - tall } else { 0 };
    // the window owns a region once it has it, and lets the last one go
    unsafe { SetWindowRgn(hwnd.0 as _, CreateRectRgn(0, top, width, top + tall), 1) };
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
                // Settings offers it at once; on its own, it waits for a quiet moment
                let _ = app.emit("update-available", update.version.clone());
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

/// Asked when Settings opens: a newer release, by its version, if there is one.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Option<String> {
    let update = app.updater().ok()?.check().await.ok().flatten()?;
    Some(update.version)
}

/// Update in Settings: the newer release, installed now rather than at the next quiet moment, and the app
/// started again on it. The same signed update the app would install on its own.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?.ok_or("This is the newest version")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

/// The setup window: its own window, which stays open beside Finder and Docker while they are in use, where
/// the panel closes as soon as anything else is clicked. While it is open, IMD Agents is in the Dock and the
/// app switcher, to come back to; closed, it is a menu bar app again. Async, so the window is made off the main
/// thread, where making one waits on the main thread and never ends on Windows.
#[tauri::command]
async fn open_setup(app: tauri::AppHandle) -> Result<(), String> {
    let panel = app.get_webview_window("panel");
    let screen = panel.as_ref().and_then(|p| p.current_monitor().ok().flatten()).or_else(|| app.primary_monitor().ok().flatten());
    if let Some(panel) = &panel {
        let _ = panel.hide();
    }
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let win = tauri::WebviewWindowBuilder::new(&app, "setup", tauri::WebviewUrl::App("setup.html".into()))
        .title("IMD Agents")
        .inner_size(460.0, 556.0)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // it opens where the panel was, its outer edge on the panel's: under the menu bar on a Mac, over the taskbar's
    // icons on Windows. What setup opens (Docker's installer, the password box, Terminal) comes up in the middle,
    // beside it rather than over it
    match screen.filter(|_| cfg!(any(target_os = "macos", target_os = "windows"))) {
        Some(screen) => {
            let scale = screen.scale_factor();
            let size = win.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((460.0 * scale, 556.0 * scale));
            let (x, y, _) = by_the_icon(&screen, size);
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        None => {
            let _ = win.center();
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let _ = handle.emit("setup-progress", Option::<String>::None);
        }
    });
    Ok(())
}

/// Docker's terms, which its installer accepts for this computer's person: the setup window links to them.
#[tauri::command]
fn open_docker_terms(app: tauri::AppHandle) -> Result<(), String> {
    app.opener().open_url("https://www.docker.com/legal/docker-subscription-service-agreement/", None::<&str>).map_err(|e| e.to_string())
}

/// The setup window's height, asked by its page: it keeps one, and makes up whatever the window keeps for itself.
#[tauri::command]
fn fit_setup(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.set_size(tauri::LogicalSize::new(460.0, height.clamp(200.0, 900.0)));
    }
}

/// Help with setting an agent up, on imd.fun's page for the app.
#[tauri::command]
fn open_setup_help(app: tauri::AppHandle) -> Result<(), String> {
    app.opener().open_url("https://imd.fun/app/#help", None::<&str>).map_err(|e| e.to_string())
}

/// The room left where Docker and the box will live, in bytes: setup's first screen says so only when it's short of
/// what setup takes. None where it can't tell.
#[tauri::command]
async fn free_space() -> Option<u64> {
    tauri::async_runtime::spawn_blocking(free_bytes).await.ok().flatten()
}

/// The home folder's disk, as POSIX df gives it: a header, then the disk's line, its fourth column the 1024-byte
/// blocks free.
#[cfg(unix)]
fn free_bytes() -> Option<u64> {
    let home = std::env::var("HOME").ok()?;
    let out = Command::new("df").args(["-Pk", &home]).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let kib: u64 = text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
    Some(kib * 1024)
}

/// The disk of the user's local app data, where Docker Desktop keeps its own disk on Windows.
#[cfg(windows)]
fn free_bytes() -> Option<u64> {
    let dir = wide(std::env::var_os("LOCALAPPDATA")?);
    let mut free = 0u64;
    let read = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(dir.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (read != 0).then_some(free)
}

/// Claude's plans: the box thinks with Claude Code, which comes with every paid plan, and setup's first screen
/// links them for someone without one.
#[tauri::command]
fn open_claude_plans(app: tauri::AppHandle) -> Result<(), String> {
    app.opener().open_url("https://claude.com/pricing", None::<&str>).map_err(|e| e.to_string())
}

/// Light, dark, or the computer's own: every window of the app, its pages following through their color scheme.
#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: String) {
    app.set_theme(match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    });
}

/// A short sound for what an agent just did, when Sounds is on: `taken` as it starts a job, `paid` as one is
/// accepted. The computer's own sounds: the Mac's, played as Finder plays them, and Windows' notification sounds;
/// on Linux, none yet.
#[tauri::command]
fn play_sound(kind: String) {
    #[cfg(target_os = "macos")]
    {
        let name = match kind.as_str() {
            "taken" => "Pop",
            "paid" => "Glass",
            _ => return,
        };
        if let Ok(mut child) = Command::new("/usr/bin/afplay").args(["-v", "0.7", &format!("/System/Library/Sounds/{name}.aiff")]).spawn() {
            // waited on, so no finished player is left behind
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_FILENAME, SND_NODEFAULT};
        let name = match kind.as_str() {
            "taken" => "Windows Notify Messaging.wav",
            "paid" => "Windows Notify Calendar.wav",
            _ => return,
        };
        let media = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into())).join("Media");
        let file = wide(media.join(name));
        // played to its end on a thread of its own, which holds the file's name while it plays
        std::thread::spawn(move || unsafe { PlaySoundW(file.as_ptr(), std::ptr::null_mut(), SND_FILENAME | SND_NODEFAULT) });
    }
    #[cfg(target_os = "linux")]
    let _ = kind;
}

/// imd.fun's page of agent seats: setup's first screen links it, for someone who doesn't hold one yet.
#[tauri::command]
fn open_seats(app: tauri::AppHandle) -> Result<(), String> {
    app.opener().open_url("https://imd.fun/seats/", None::<&str>).map_err(|e| e.to_string())
}

/// Setup finished: its window closes and the panel opens on the agent now running here.
#[tauri::command]
fn setup_done(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.close();
    }
    show_panel(&app);
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

// A menu bar panel on macOS is an NSPanel: one that takes the keyboard without making the app active, so it
// opens over a full screen app instead of sending you back to the desktop.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(TrayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

/// Turns the panel into a menu-like NSPanel: on every Space, full screen ones too, at the menu level.
#[cfg(target_os = "macos")]
fn float_over_full_screen(win: &tauri::WebviewWindow) {
    use tauri_nspanel::{CollectionBehavior, StyleMask, WebviewWindowExt};
    let Ok(panel) = win.to_panel::<TrayPanel<tauri::Wry>>() else { return };
    // NSPopUpMenuWindowLevel
    panel.set_level(101);
    panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().stationary().ignores_cycle().full_screen_auxiliary().value());
    let _ = panel.set_style_mask(StyleMask::empty().nonactivating_panel().value());
}

/// Shows the panel and tells the page, which plays it in from the side its icon is on.
fn open_panel(win: &tauri::WebviewWindow, above: bool) {
    PANEL_ABOVE.store(above, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        match win.app_handle().get_webview_panel("panel") {
            Ok(panel) => panel.show_and_make_key(),
            Err(_) => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // the region again, on the side the icon is on now and at this screen's scale
        #[cfg(target_os = "windows")]
        clip_panel(win, Some(f64::from_bits(PANEL_HEIGHT.load(Ordering::Relaxed))).filter(|h| *h > 0.0).unwrap_or(518.0));
        let _ = win.show();
        // kept off the taskbar each time, as Windows can forget it for a window made hidden (tauri#10422)
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(true);
        let _ = win.set_focus();
    }
    let _ = win.emit("panel-shown", above);
}

/// Opens the panel where there is no click on its icon to place it by: the app opened by hand or again, setup done,
/// or the menu on a Linux tray that only shows menus. In the corner of the screen where its icon usually is.
fn show_panel(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("panel") else { return };
    let mut above = false;
    // A panel never shown yet has no screen of its own: the primary one, which holds the menu bar or the taskbar.
    if let Some(monitor) = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten()) {
        let scale = monitor.scale_factor();
        let height = win.outer_size().map(|s| s.height as f64).unwrap_or(518.0 * scale) - (INSET_TOP + INSET_BOTTOM) * scale;
        let (x, y, foot) = by_the_icon(&monitor, (PANEL_WIDTH * scale, height));
        let _ = win.set_position(PhysicalPosition::new(x - INSET_SIDE * scale, y - INSET_TOP * scale));
        above = foot;
    }
    open_panel(&win, above);
}

/// Where a window of this size goes on a screen, by the corner its icon is in, as `corner` places it.
fn by_the_icon(monitor: &tauri::Monitor, size: (f64, f64)) -> (f64, f64, bool) {
    let (screen, area) = (monitor.position(), monitor.work_area());
    let work = (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64);
    corner((screen.x as f64, screen.y as f64), work, monitor.scale_factor(), size, cfg!(target_os = "windows"))
}

/// The corner a window goes in, beside the app's icon: top right, under a menu bar; on Windows, the end of the
/// taskbar its icons sit at, wherever the taskbar is, found where the work area stops short of the screen. The
/// window's top left in physical pixels, kept on the screen, and whether it sits at the foot, growing upward.
fn corner(screen: (f64, f64), work: (f64, f64, f64, f64), scale: f64, size: (f64, f64), windows: bool) -> (f64, f64, bool) {
    let (x, y, width, height) = work;
    let (top, left) = (windows && y > screen.1, windows && x > screen.0);
    let foot = windows && !top;
    let across = if left { x + 12.0 * scale } else { x + width - size.0 - 12.0 * scale };
    let down = if foot { y + height - size.1 - 12.0 * scale } else { y + 6.0 * scale };
    (across.max(x), down.max(y), foot)
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

/// The panel plugin on macOS; elsewhere a plugin that does nothing.
#[cfg(target_os = "macos")]
fn tauri_plugin_nspanel_init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_nspanel::init()
}
#[cfg(not(target_os = "macos"))]
fn tauri_plugin_nspanel_init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("nspanel").build()
}

/// What the login item passes, so a start at login stays in the tray while one by hand opens the panel.
const AT_LOGIN: &str = "--at-login";
/// What Windows passes after the restart setup asked for, so setup opens again where it left off.
const SETUP: &str = "--setup";

/// Opened, or opened again while running: setup after its restart, nothing at login, otherwise the panel, as a
/// menu bar manager may hide the icon.
fn opened_with(app: &tauri::AppHandle, args: &[String]) {
    if args.iter().any(|arg| arg == SETUP) {
        tauri::async_runtime::spawn(open_setup(app.clone()));
    } else if !args.iter().any(|arg| arg == AT_LOGIN) {
        show_panel(app);
    }
}

/// Open at login, on or off: the login item the autostart plugin keeps. On Windows its line names this app's path
/// unquoted, which Windows can't start from a folder with a space in its name, as the app's own has, so the line is
/// written again, quoted.
#[tauri::command]
fn set_open_at_login(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if !on {
        return app.autolaunch().disable().map_err(|e| e.to_string());
    }
    app.autolaunch().enable().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let line = wide(format!("\"{}\" {AT_LOGIN}", exe.display()));
        let (key, name) = (wide(r"Software\Microsoft\Windows\CurrentVersion\Run"), wide(&app.package_info().name));
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, line.as_ptr().cast(), (line.len() * 2) as u32) };
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opened again while running, on Windows and Linux: no second icon, the panel or setup opens instead.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| opened_with(app, &args)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![AT_LOGIN])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_nspanel_init())
        .invoke_handler(tauri::generate_handler![
            api_get, explorer_get, agent_svg, link_start, link_poll, link_reopen, seat_pause, unlink,
            box_state, box_start, box_stop, box_restart, worker_releases, open_explorer,
            box_setup_state, docker_open, box_pull, box_install, box_sign_in, box_pair, box_pair_cancel, pairing_pending, open_pairing, open_lend, lend_vault, lend_span, box_unlink, copy_pairing, hide_panel, fit_panel, quit, set_tray_state, update_check, update_install,
            docker_install, open_setup, setup_done, open_docker_terms, fit_setup, open_setup_help, open_seats, open_claude_plans, free_space, play_sound, set_theme,
            restart_pc, set_open_at_login
        ])
        .setup(|app| {
            // The log of what went wrong, and a panic's place in it before the app goes.
            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = LOG.set(dir.join("imd-agents.log"));
            }
            let before = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let at = info.location().map(|place| format!("{}:{}:{}", place.file(), place.line(), place.column())).unwrap_or_default();
                let payload = info.payload();
                let said = payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_default();
                log_failure(&format!("panic at {at}: {said}"));
                before(info);
            }));

            // A menu bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Windows: the panel's window at its tallest for good, its region showing as much as the panel needs
            #[cfg(target_os = "windows")]
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH + 2.0 * INSET_SIDE, PANEL_TALLEST));
            }
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("panel") {
                float_over_full_screen(&win);
            }

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
                    "open" => show_panel(app),
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
            #[cfg(target_os = "windows")]
            bring_out_tray_icon(app.handle());

            opened_with(app.handle(), &std::env::args().collect::<Vec<_>>());
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
                match _app.get_webview_window("setup") {
                    Some(win) => {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    None => show_panel(_app),
                }
            }
        });
}

#[cfg(test)]
mod tests {
    /// The plane's reads come compressed and reuse one connection. Needs the network.
    #[test]
    #[ignore]
    fn reads_compressed() {
        tauri::async_runtime::block_on(async {
            let response = super::http().get(format!("{}/swarm", super::api_base())).send().await.expect("swarm");
            assert!(response.content_length().is_none(), "body was decoded from a compressed one");
            let body: serde_json::Value = response.json().await.expect("json");
            assert!(body.is_object());
        });
    }

    /// Docker's own app passes the check the installer runs; anything else, such as this app, doesn't.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn knows_dockers_own_app() {
        assert!(super::docker_signed(std::path::Path::new("/Applications/Docker.app")));
        assert!(!super::docker_signed(std::path::Path::new("/System/Applications/Calculator.app")));
    }

    /// The engine's own pull, on a small image, saying how far it got. Needs Docker running.
    #[test]
    #[ignore]
    fn pulls_through_the_engine() {
        let mut said = Vec::new();
        super::pull_through_engine(super::engine_stream().expect("Docker running"), "library/hello-world", "latest", None, &mut |words| said.push(words)).expect("pulled");
        println!("said {said:?}");
        assert!(super::pull_through_engine(super::engine_stream().expect("Docker running"), "library/no-such-image-imd", "latest", None, &mut |_| {}).is_err());
    }

    /// The engine's socket or pipe, stood in for: what it answers, and what was asked of it.
    struct StandIn {
        answer: std::io::Cursor<Vec<u8>>,
        asked: Vec<u8>,
    }

    impl std::io::Read for StandIn {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.answer.read(buf)
        }
    }

    impl std::io::Write for StandIn {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.asked.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn engine(status: &str, lines: &[&str]) -> StandIn {
        let answer = format!("HTTP/1.0 {status}\r\nContent-Type: application/json\r\n\r\n{}\n", lines.join("\n"));
        StandIn { answer: std::io::Cursor::new(answer.into_bytes()), asked: Vec::new() }
    }

    #[test]
    fn a_pull_counts_its_layers_then_unpacks() {
        // as the engine streams a pull: the tag's line first, then each layer's, then the digest's, with no id
        let lines = [
            r#"{"status":"Pulling from identity-md/box","id":"latest"}"#,
            r#"{"status":"Pulling fs layer","progressDetail":{},"id":"a1"}"#,
            r#"{"status":"Pulling fs layer","progressDetail":{},"id":"b2"}"#,
            r#"{"status":"Downloading","progressDetail":{"current":50000000,"total":100000000},"id":"a1"}"#,
            r#"{"status":"Downloading","progressDetail":{"current":120000000,"total":300000000},"id":"b2"}"#,
            r#"{"status":"Download complete","progressDetail":{},"id":"a1"}"#,
            r#"{"status":"Download complete","progressDetail":{},"id":"b2"}"#,
            r#"{"status":"Extracting","progressDetail":{"current":1,"total":2},"id":"a1"}"#,
            r#"{"status":"Pull complete","progressDetail":{},"id":"a1"}"#,
            r#"{"status":"Pull complete","progressDetail":{},"id":"b2"}"#,
            r#"{"status":"Digest: sha256:00"}"#,
            r#"{"status":"Status: Downloaded newer image for ghcr.io/identity-md/box:latest"}"#,
        ];
        let mut said = Vec::new();
        pull_through_engine(engine("200 OK", &lines), "ghcr.io/identity-md/box", "latest", Some(400_000_000), &mut |words| said.push(words)).expect("pulled");
        assert_eq!(said, ["Downloading 0 of 400 MB", "Downloading 50 of 400 MB", "Downloading 170 of 400 MB", "Downloading 220 of 400 MB", "Unpacking…"]);
    }

    #[test]
    fn a_pull_says_what_the_engine_refused() {
        let mut stream = engine("404 Not Found", &[r#"{"message":"pull access denied for ghcr.io/identity-md/nothing"}"#]);
        let why = pull_through_engine(&mut stream, "ghcr.io/identity-md/nothing", "latest", None, &mut |_| {}).unwrap_err();
        assert_eq!(why, "pull access denied for ghcr.io/identity-md/nothing");
        assert!(String::from_utf8_lossy(&stream.asked).starts_with("POST /images/create?fromImage=ghcr.io%2Fidentity-md%2Fnothing&tag=latest HTTP/1.0\r\n"));
    }

    #[test]
    fn imdlends_page_takes_only_a_pairing_code() {
        assert!(super::pairing_code("QX7M4KD2"));
        // nothing that would change the link it rides in, and nothing the network wouldn't make
        for not in ["qx7m4kd2", "QX7", "QX7M 4KD2", "QX7M4KD2&seat=1", "QX7M4KD2/../x", "ÄX7M4KD2"] {
            assert!(!super::pairing_code(not), "{not}");
        }
    }

    #[test]
    fn reads_a_vaults_answers_word_by_word() {
        // as seat #494's vault answered getLending and OWNER on 2026-10-26
        let span = format!("{:064x}{:064x}", 1792269179u64, 1792873979u64);
        assert_eq!((super::word_u64(&span, 0), super::word_u64(&span, 1)), (Some(1792269179), Some(1792873979)));
        let owner = "000000000000000000000000047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";
        assert_eq!(super::word_address(owner, 0).as_deref(), Some("0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7"));
        // a word too big for what it should hold, or not there at all, is no answer
        assert_eq!(super::word_u64(owner, 0), None);
        assert_eq!(super::word_u64(&span, 2), None);
    }

    /// Seat #494's vault's code, as it stood on 2026-10-26: the clone, imdLend's vault code, then its lender, borrower
    /// and 30%.
    const VAULT_494: &str = concat!(
        "363d3d373d3d3d363d73", "9a70dd32e29be73add3b8d1d34a47fbc082e963e", "5af43d82803e903d91602b57fd5bf3",
        "000000000000000000000000047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7",
        "00000000000000000000000056fb0edf4e2fdfa3d82c5707312ed3d2a6ff5c24",
        "0000000000000000000000000000000000000000000000000000000000000bb8",
    );

    fn terms_494() -> super::Terms {
        super::Terms { owner: "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7".into(), operator: "0x56fb0edf4e2fdfa3d82c5707312ed3d2a6ff5c24".into(), owner_bps: 3000 }
    }

    #[test]
    fn reads_a_vaults_terms_from_its_code() {
        assert_eq!(super::clone_terms(VAULT_494), Some(terms_494()));
        // a wallet, a wallet delegating its code, a clone without terms, one cut short, and another contract's code
        let delegated = "ef0100612373d7003d694220f7800eeaf8e3924c0951d3";
        let bare = &VAULT_494[..90];
        let short = &VAULT_494[..280];
        let other = VAULT_494.replacen("5af43d", "5af43e", 1);
        for code in ["", delegated, bare, short, &other] {
            assert_eq!(super::clone_terms(code), None, "{code}");
        }
    }

    /// Seat #494's lending, the first on imdLend, read from its vault and checked against the market. Needs the network.
    #[test]
    #[ignore]
    fn reads_a_real_imdlend_vault() {
        let vault = "0x251a8fe7b3f712716c0e5206d0aec17a68cc4d83";
        assert_eq!(tauri::async_runtime::block_on(super::lend_vault(vault.into())), Ok(Some(terms_494())));
        let span = tauri::async_runtime::block_on(super::lend_span(vault.into(), "494".into()));
        assert_eq!(span, Ok(Some(super::Span { started_at: 1792269179, ends_at: 1792873979 })));
        // a seat the vault never lent
        assert_eq!(tauri::async_runtime::block_on(super::lend_span(vault.into(), "88".into())), Ok(None));
        // a wallet is no vault, delegating its code or not, and neither is a contract that isn't one: the seats themselves
        for holder in ["0xfe35e15be885750d9b2363cbb6abdd57ac9c4c40", "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7", "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d"] {
            assert_eq!(tauri::async_runtime::block_on(super::lend_vault(holder.into())), Ok(None), "{holder}");
        }
    }

    #[test]
    fn imdlends_listing_takes_only_a_seat_number() {
        assert!(super::seat_number("88"));
        for not in ["", "8a", "88&x=1", "1234567", "-1"] {
            assert!(!super::seat_number(not), "{not}");
        }
    }

    #[test]
    fn a_friend_is_sent_only_the_networks_pairing_link() {
        assert!(super::pairing_link("https://api.imd.fun/pair?code=QX7M4KD2"));
        for not in ["https://imd.fun.evil/pair?code=QX7M4KD2", "https://api.imd.fun/pair?code=QX7M4KD2&x=1", "https://api.imd.fun/pair?register=12", "QX7M4KD2"] {
            assert!(!super::pairing_link(not), "{not}");
        }
    }

    #[test]
    fn only_dockers_own_signature_installs() {
        assert!(super::signed_by_docker("Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, ST=California, C=US"));
        assert!(super::signed_by_docker("Valid|CN=Docker Inc, O=Docker Inc, L=Palo Alto, ST=California, C=US, SERIALNUMBER=4817464\r\n"));
        for bad in [
            "NotSigned|",
            "HashMismatch|CN=Docker Inc, O=Docker Inc, L=Palo Alto, ST=California, C=US",
            "Valid|CN=Docker Inc Ltd, O=Docker Inc Ltd, C=GB",
            "Valid|CN=Not Docker, O=Docker Inc",
            "Valid|CN=Docker Inc, O=Someone Else",
            "",
        ] {
            assert!(!super::signed_by_docker(bad), "{bad}");
        }
    }

    #[test]
    fn reads_wsls_version_in_any_language() {
        assert_eq!(super::version_in("WSL version: 2.6.1.0"), Some((2, 6, 1)));
        assert_eq!(super::version_in("WSL-Version: 2.1.5.0"), Some((2, 1, 5)));
        assert_eq!(super::version_in("Version de WSL : 2.0.14.0"), Some((2, 0, 14)));
        assert_eq!(super::version_in("Copyright (c) Microsoft Corporation. All rights reserved."), None);
        assert_eq!(super::version_in("WSL 2"), None);
        assert!(super::version_in("WSL version: 2.1.4.0").unwrap() < (2, 1, 5));
    }

    #[test]
    fn the_panel_opens_by_the_icon() {
        let panel = (720.0, 1000.0);
        // a Mac at 2x: top right, under the menu bar, 12 points in and 6 down
        assert_eq!(super::corner((0.0, 0.0), (0.0, 50.0, 3024.0, 1914.0), 2.0, panel, false), (3024.0 - 720.0 - 24.0, 62.0, false));
        // Windows at 1.5x, the taskbar along the bottom: over its icons, at the foot
        let (screen, bottom) = ((0.0, 0.0), (0.0, 0.0, 2880.0, 1728.0));
        assert_eq!(super::corner(screen, bottom, 1.5, panel, true), (2880.0 - 720.0 - 18.0, 1728.0 - 1000.0 - 18.0, true));
        // the taskbar along the top: under it, at the right
        assert_eq!(super::corner(screen, (0.0, 72.0, 2880.0, 1728.0), 1.5, panel, true), (2142.0, 81.0, false));
        // down the left side: its icons are at its foot
        assert_eq!(super::corner(screen, (96.0, 0.0, 2784.0, 1800.0), 1.5, panel, true), (114.0, 782.0, true));
        // down the right side, and on a second screen to the left of the first
        assert_eq!(super::corner((-1920.0, 0.0), (-1920.0, 0.0, 1856.0, 1080.0), 1.0, (360.0, 500.0), true), (-1920.0 + 1856.0 - 360.0 - 12.0, 1080.0 - 500.0 - 12.0, true));
        // a window taller than the room keeps its top on the screen
        assert_eq!(super::corner(screen, bottom, 1.5, (720.0, 2000.0), true).1, 0.0);
    }

    #[test]
    #[ignore]
    fn reads_the_published_box_size() {
        let size = tauri::async_runtime::block_on(super::published_size());
        println!("published box {size:?} bytes");
        assert!(size.is_some_and(|s| s > 100_000_000));
    }

    #[test]
    fn reads_only_a_plain_ens_name_from_the_explorer() {
        assert!(super::explorer_path("/api/search?q=vitalik.eth").is_ok());
        assert!(super::explorer_path("/api/search?q=taylor.fyi").is_ok());
        assert!(super::explorer_path("/api/search?q=agent-12.imd.eth").is_ok());
        for bad in ["/api/search?q=vitalik", "/api/search?q=a.eth&part=published", "/api/search?q=../x.eth", "/api/search?q=Vitalik.eth", "/api/search?q=a..eth"] {
            assert!(super::explorer_path(bad).is_err(), "{bad}");
        }
    }

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
    fn a_box_without_the_sandbox_flags_is_told_apart() {
        // as `docker inspect` prints them: one made by this app, one by IMD Agents 0.1.0, one with /proc masked
        assert!(super::sealed(r#"["no-new-privileges:true","seccomp={\"defaultAction\": \"SCMP_ACT_ERRNO\"}"] 0"#));
        assert!(!super::sealed(r#"["no-new-privileges:true"] 12"#));
        assert!(!super::sealed(r#"["no-new-privileges:true","seccomp={}"] 12"#));
        assert!(!super::sealed(""));
    }

    #[test]
    fn only_api_paths_are_read() {
        assert!(api_path("/seats/12?collaborators=0").is_ok());
        for bad in ["https://evil.test/x", "//evil.test", "/../admin", "/a\\b", "/a b"] {
            assert!(api_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_log_dates_its_lines_in_utc() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc(1_709_208_000), "2024-02-29T12:00:00Z");
        assert_eq!(utc(1_792_877_131), "2026-10-24T21:25:31Z");
    }

    #[test]
    fn the_log_starts_again_past_a_megabyte() {
        let dir = std::env::temp_dir().join(format!("imd-agents-log-{}", nonce()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("imd-agents.log");
        std::fs::write(&log, vec![b'x'; 1_000_001]).unwrap();
        log_in(&log, "GET https://api.imd.fun/swarm: no answer:\nline two");
        let kept = std::fs::read_to_string(&log).unwrap();
        assert_eq!(kept.lines().count(), 1, "one line, its own line breaks flattened");
        assert!(kept.ends_with("no answer: line two\n") && kept.as_bytes()[4] == b'-' && kept.contains("Z GET "), "{kept}");
        assert_eq!(std::fs::metadata(dir.join("imd-agents.old.log")).unwrap().len(), 1_000_001);
        let _ = std::fs::remove_dir_all(dir);
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
            let s = setup_state(false).await;
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
