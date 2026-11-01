// Muriel in Rust: a Tauri window (the system web view instead of Electron's own Chromium) around Muriel's
// player UI. The music backend (search, stream lookups, the audio proxy, cache, lyrics) runs as a sidecar
// process; this file starts it, waits until it listens, and gives the page the same bridge Electron's
// preload.js did.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backend {
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    token: String,
    #[serde(default)]
    data_dir: String,
    #[serde(default)]
    default_data_dir: String,
    #[serde(default)]
    library_dir: String,
}

struct AppState {
    backend: Backend,
    child: Mutex<Option<Child>>,
    tray_on_close: AtomicBool,
    quitting: AtomicBool,
}

const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "webm", "wma", "alac", "aiff", "aif"];

/// Node to run the backend with: the copy bundled next to the app, else the one on PATH.
fn node_binary(resources: Option<&Path>) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(dir) = resources {
        let bundled = dir.join("backend").join(exe);
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(exe)
}

/// Where the backend's entry.js lives: bundled resources in a build, rust/backend while developing.
fn backend_dir(resources: Option<&Path>) -> PathBuf {
    if let Some(dir) = resources {
        let p = dir.join("backend");
        if p.join("entry.js").exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("backend")
}

/// Reads the sidecar's stdout until its one JSON "ready" line; other lines are its own log output.
fn parse_ready_line(line: &str) -> Option<Backend> {
    let t = line.trim();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Backend>(t).ok().filter(|b| b.ready || b.error.is_some())
}

fn start_backend(resources: Option<&Path>) -> Result<(Child, Backend), String> {
    let dir = backend_dir(resources);
    let mut cmd = Command::new(node_binary(resources));
    cmd.arg(dir.join("entry.js"))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the backend ({}): {e}", node_binary(resources).display()))?;
    let stdout = child.stdout.take().ok_or("no backend stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(b) = parse_ready_line(&line) {
                    let _ = tx.send(b);
                    sent = true;
                    continue;
                }
            }
            if cfg!(debug_assertions) {
                println!("[backend] {line}");
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(b) if b.ready => Ok((child, b)),
        Ok(b) => {
            let _ = child.kill();
            Err(b.error.unwrap_or_else(|| "backend failed".into()))
        }
        Err(_) => {
            let _ = child.kill();
            Err("the backend did not start within 20 s".into())
        }
    }
}

fn stop_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(mut child) = state.child.lock().unwrap().take() {
            // closing stdin makes entry.js exit by itself; kill it if it hasn't shortly after
            drop(child.stdin.take());
            for _ in 0..20 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn close_window(app: AppHandle, state: tauri::State<AppState>) {
    if state.tray_on_close.load(Ordering::Relaxed) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    } else {
        state.quitting.store(true, Ordering::Relaxed);
        app.exit(0);
    }
}

#[tauri::command]
fn set_tray_on_close(enabled: bool, state: tauri::State<AppState>) {
    state.tray_on_close.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    stop_backend(&app);
    app.restart();
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only web links".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String, state: tauri::State<AppState>) -> Result<(), String> {
    // only Muriel's own data folder
    if path != state.backend.data_dir {
        return Err("not allowed".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    success: bool,
    canceled: bool,
    error: Option<String>,
}

/// A file name the dialog may suggest: no folders, no characters Windows refuses, always .json.
fn safe_json_name(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|s| s.to_str()).unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').to_string();
    let n = if cleaned.is_empty() { "muriel.json".to_string() } else { cleaned };
    if n.to_lowercase().ends_with(".json") { n } else { format!("{n}.json") }
}

#[tauri::command]
async fn save_text_file(app: AppHandle, name: String, text: String) -> SaveResult {
    if text.len() > 64 * 1024 * 1024 {
        return SaveResult { success: false, canceled: false, error: Some("Nothing to save".into()) };
    }
    let picked = app
        .dialog()
        .file()
        .set_file_name(safe_json_name(&name))
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return SaveResult { success: false, canceled: true, error: None };
    };
    match std::fs::write(&path, text) {
        Ok(_) => SaveResult { success: true, canceled: false, error: None },
        Err(_) => SaveResult { success: false, canceled: false, error: Some("Couldn't write the file there".into()) },
    }
}

#[derive(Serialize, Debug, PartialEq)]
struct ImportedFile {
    id: String,
    file: String,
    ext: String,
    name: String,
}

fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn audio_files_in(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if p.is_dir() {
            audio_files_in(&p, out, depth + 1);
        } else if is_audio(&p) {
            out.push(p);
        }
    }
}

/// The same id main.js gives an imported file (sha1 of name + size), so libraries stay compatible.
fn import_id(file_name: &str, size: u64) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(format!("{file_name}{size}").as_bytes());
    format!("local_{}", &h.digest().to_string()[..12])
}

fn import_into_library(sources: &[PathBuf], library: &Path) -> Vec<ImportedFile> {
    let _ = std::fs::create_dir_all(library);
    let mut out = Vec::new();
    for src in sources {
        let Ok(meta) = std::fs::metadata(src) else { continue };
        let file_name = src.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let id = import_id(&file_name, meta.len());
        let file = format!("{id}.{ext}");
        let dst = library.join(&file);
        if !dst.exists() && std::fs::copy(src, &dst).is_err() {
            continue;
        }
        let name = src.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        out.push(ImportedFile { id, file, ext, name });
    }
    out
}

#[tauri::command]
async fn import_audio_files(app: AppHandle, folder: bool, state: tauri::State<'_, AppState>) -> Result<Vec<ImportedFile>, String> {
    let picker = app.dialog().file();
    let sources: Vec<PathBuf> = if folder {
        let dirs = picker.blocking_pick_folders().unwrap_or_default();
        let mut all = Vec::new();
        for d in dirs.into_iter().filter_map(|d| d.into_path().ok()) {
            audio_files_in(&d, &mut all, 0);
        }
        all
    } else {
        picker
            .add_filter("Audio", AUDIO_EXTS)
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .collect()
    };
    Ok(import_into_library(&sources, Path::new(&state.backend.library_dir)))
}

fn init_script(b: &Backend, version: &str) -> String {
    let info = serde_json::json!({
        "port": b.port,
        "token": b.token,
        "dataDir": b.data_dir,
        "defaultDataDir": b.default_data_dir,
        "version": version,
    });
    format!("window.__MURIEL__ = {info};\n{}", include_str!("../shim.js"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let resources = app.path().resource_dir().ok();
            let (child, backend) = match start_backend(resources.as_deref()) {
                Ok(v) => v,
                Err(e) => {
                    app.dialog().message(format!("Muriel couldn't start its music backend:\n{e}")).title("Muriel RS").blocking_show();
                    std::process::exit(1);
                }
            };
            let version = app.package_info().version.to_string();
            let script = init_script(&backend, &version);
            app.manage(AppState {
                backend,
                child: Mutex::new(Some(child)),
                tray_on_close: AtomicBool::new(cfg!(not(target_os = "linux"))),
                quitting: AtomicBool::new(false),
            });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Muriel")
                .inner_size(1280.0, 820.0)
                .min_inner_size(360.0, 500.0)
                .decorations(false)
                .background_color(tauri::window::Color(0, 0, 0, 255))
                .initialization_script(&script)
                .build()?;

            let show = MenuItem::with_id(app, "show", "Show Muriel", true, None::<&str>)?;
            let play = MenuItem::with_id(app, "playpause", "Play / Pause", true, None::<&str>)?;
            let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &play, &next, &quit])?;
            let mut tray = TrayIconBuilder::with_id("tray").tooltip("Muriel").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, ev| match ev.id().as_ref() {
                "show" => show_main(app),
                "playpause" => {
                    let _ = app.emit("media-command", "playpause");
                }
                "next" => {
                    let _ = app.emit("media-command", "next");
                }
                "quit" => {
                    app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
                    app.exit(0);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, ev| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let st = app.state::<AppState>();
                if st.tray_on_close.load(Ordering::Relaxed) && !st.quitting.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            close_window,
            set_tray_on_close,
            restart_app,
            open_url,
            open_path,
            copy_text,
            save_text_file,
            import_audio_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building Muriel RS")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_backend(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_is_found_among_log_lines() {
        assert!(parse_ready_line("devsize internal server running on http://127.0.0.1:38472").is_none());
        let b = parse_ready_line(r#"{"ready":true,"port":38472,"token":"abc","dataDir":"/d","defaultDataDir":"/d","libraryDir":"/d/library"}"#).unwrap();
        assert_eq!(b.port, 38472);
        assert_eq!(b.token, "abc");
        assert_eq!(b.library_dir, "/d/library");
        let e = parse_ready_line(r#"{"ready":false,"error":"EADDRINUSE"}"#).unwrap();
        assert_eq!(e.error.as_deref(), Some("EADDRINUSE"));
        assert!(parse_ready_line(r#"{"something":"else"}"#).is_none());
    }

    #[test]
    fn json_names_are_safe() {
        assert_eq!(safe_json_name("../../evil"), "evil.json");
        assert_eq!(safe_json_name("my:list"), "my_list.json");
        assert_eq!(safe_json_name(""), "muriel.json");
        assert_eq!(safe_json_name(".hidden.json"), "hidden.json");
    }

    #[test]
    fn import_ids_match_the_electron_build() {
        // node -e "console.log('local_'+require('crypto').createHash('sha1').update('song.mp3'+1234).digest('hex').slice(0,12))"
        assert_eq!(import_id("song.mp3", 1234), format!("local_{}", &sha1_smol::Sha1::from("song.mp31234").digest().to_string()[..12]));
    }

    #[test]
    fn import_copies_audio_into_the_library() {
        let base = std::env::temp_dir().join(format!("muriel-rs-test-{}", std::process::id()));
        let src = base.join("src");
        let lib = base.join("lib");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.mp3"), b"abc").unwrap();
        std::fs::write(src.join("sub").join("b.FLAC"), b"defg").unwrap();
        std::fs::write(src.join("notes.txt"), b"x").unwrap();
        let mut found = Vec::new();
        audio_files_in(&src, &mut found, 0);
        assert_eq!(found.len(), 2);
        let out = import_into_library(&found, &lib);
        assert_eq!(out.len(), 2);
        for f in &out {
            assert!(lib.join(&f.file).exists());
        }
        assert!(out.iter().any(|f| f.ext == "flac" && f.name == "b"));
        let _ = std::fs::remove_dir_all(base);
    }
}
