//! IMD Agents: every IMD agent a wallet holds, from the menu bar (macOS) or the tray (Windows, Linux).
//!
//! The webview draws; this side does everything that touches the network, the key or Docker, so the
//! page never holds a credential and never gets a general "sign this" or "fetch that URL" power:
//! - reads go to the IMD API by path only, never to a URL the page names;
//! - the app's key is P-256, kept in the OS credential store (Keychain, Credential Manager, Secret
//!   Service), and signs exactly three things: a pause, a resume and an unlink;
//! - the box is started and stopped with the same `docker run` the box repository's script uses.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::EncodePublicKey;
use serde::Serialize;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition,
};
use tauri_plugin_opener::OpenerExt;

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
    candidates.into_iter().find(|p| p.is_file())
}

fn run_docker(args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let binary = docker()?;
    let mut command = hidden(Command::new(&binary));
    command.args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    // Docker Desktop's credential helpers live beside the CLI; keep its directory on PATH for them.
    if let Some(dir) = binary.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        dirs.insert(0, dir.to_path_buf());
        if let Ok(joined) = std::env::join_paths(dirs) {
            command.env("PATH", joined);
        }
    }
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
        if !run_docker(&["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(10)).is_some_and(|(ok, _)| ok) {
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

/// Starts the box exactly as `./box start` does: nothing of this computer mounted, every capability
/// dropped but the few the firewall needs before it hands over to the worker's own user.
#[tauri::command]
async fn box_start(runtime: String) -> Result<(), String> {
    if !["claude", "codex", "claude,grok", "codex,grok"].contains(&runtime.as_str()) {
        return Err("unknown runtime".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _ = run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(30));
        let volume = format!("{BOX_VOLUME}:/home/imd");
        let args = [
            "run", "-d", "--name", BOX_NAME, "--restart", "unless-stopped",
            "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--cap-add", "CHOWN",
            "--security-opt", "no-new-privileges:true",
            "--cpus", "4", "--memory", "6g", "--pids-limit", "2048",
            "-v", &volume,
            BOX_IMAGE, "imd", "start", "--runtime", &runtime, "--auto-update",
        ];
        match run_docker(&args, Duration::from_secs(120)) {
            Some((true, _)) => Ok(()),
            Some((false, why)) => Err(why.lines().last().unwrap_or("could not start").to_string()),
            None => Err("Docker is not installed".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the box: the job it holds goes back to the network, as `./box stop` does.
#[tauri::command]
async fn box_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| match run_docker(&["rm", "-f", BOX_NAME], Duration::from_secs(60)) {
        Some((true, _)) => Ok(()),
        Some((false, why)) if why.contains("No such container") => Ok(()),
        Some((false, why)) => Err(why),
        None => Err("Docker is not installed".into()),
    })
    .await
    .map_err(|e| e.to_string())?
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

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
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

/// Opens the panel where there is no click to place it by: from the menu, on a Linux tray that only shows
/// menus. Top right of the screen, under where a status area usually is.
fn show_panel_top_right(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if let Ok(Some(monitor)) = win.current_monitor().or_else(|_| win.primary_monitor()) {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = win.outer_size().map(|s| s.width as f64).unwrap_or(360.0 * scale);
        let x = area.position.x as f64 + area.size.width as f64 - width - 12.0 * scale;
        let _ = win.set_position(PhysicalPosition::new(x, area.position.y as f64 + 12.0 * scale));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// Shows the panel under the icon (macOS, a top menu bar) or above it (Windows and Linux taskbars),
/// kept inside the screen the icon is on.
fn toggle_panel(app: &tauri::AppHandle, cursor: PhysicalPosition<f64>) {
    let Some(win) = app.get_webview_window("panel") else { return };
    if win.is_visible().unwrap_or(false) {
        PANEL_HIDDEN_AT_MS.store(now_ms(), Ordering::Relaxed);
        let _ = win.hide();
        return;
    }
    if now_ms().saturating_sub(PANEL_HIDDEN_AT_MS.load(Ordering::Relaxed)) < REOPEN_GUARD_MS {
        return;
    }
    let scale = win.scale_factor().unwrap_or(2.0);
    let size = win.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((360.0 * scale, 480.0 * scale));
    let margin = 8.0 * scale;
    let screen = win
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                cursor.x >= p.x as f64 && cursor.x < (p.x as f64 + s.width as f64) && cursor.y >= p.y as f64 && cursor.y < (p.y as f64 + s.height as f64)
            })
        })
        .or_else(|| win.primary_monitor().ok().flatten())
        .map(|m| {
            let a = m.work_area();
            (a.position.x as f64, a.position.y as f64, a.size.width as f64, a.size.height as f64)
        });
    let (x, y) = match screen {
        Some((sx, sy, sw, sh)) => {
            let x = (cursor.x - size.0 / 2.0).clamp(sx + margin, sx + sw - size.0 - margin);
            // In the top half the bar is above: open below the icon. In the bottom half, above it.
            let below = cursor.y < sy + sh / 2.0;
            let y = if below { (cursor.y + 6.0 * scale).max(sy + margin) } else { (cursor.y - size.1 - margin).max(sy + margin) };
            (x, y.min(sy + sh - size.1 - margin))
        }
        None => (cursor.x - size.0 / 2.0, cursor.y + 6.0 * scale),
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            api_get, agent_svg, link_start, link_poll, link_reopen, seat_pause, unlink,
            box_state, box_start, box_stop, open_explorer, hide_panel, quit, set_tray_state
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
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                        toggle_panel(tray.app_handle(), position);
                    }
                })
                .build(app)?;
            app.manage(TrayHandle(tray));

            // Development only: IMD_AGENTS_SHOW=1 opens the panel at launch, top right, for looking at it
            // without hunting for the icon (a menu bar manager may hide it).
            #[cfg(debug_assertions)]
            if std::env::var_os("IMD_AGENTS_SHOW").is_some() {
                if let (Some(win), Ok(Some(monitor))) = (app.get_webview_window("panel"), app.primary_monitor()) {
                    let scale = monitor.scale_factor();
                    let x = monitor.position().x as f64 + monitor.size().width as f64 - 380.0 * scale;
                    let _ = win.set_position(PhysicalPosition::new(x, 40.0 * scale));
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running IMD Agents");
}

#[cfg(test)]
mod tests {
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
