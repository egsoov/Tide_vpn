// tide — десктоп-клиент. Системная часть: запуск ядра sing-box, режимы «прокси» и «весь трафик» (TUN),
// загрузка подписки, запросы к API ядра, значок в трее.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const PROXY_PORT: &str = "17890";
const CLASH: &str = "127.0.0.1:17891";

#[derive(Default)]
struct Core {
    child: Option<Child>,
    proxy_mode: bool,
    tun_root: bool,
}

struct AppState(Mutex<Core>);

#[derive(Serialize)]
struct SubResp {
    status: u16,
    body: String,
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
struct Status {
    running: bool,
    tun: bool,
}

// ---------- пути ----------

fn singbox_path() -> PathBuf {
    let exe = std::env::current_exe().expect("exe path");
    let dir = exe.parent().expect("exe dir").to_path_buf();
    dir.join(if cfg!(windows) { "sing-box.exe" } else { "sing-box" })
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn tun_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // отдельная папка: файлы, созданные ядром с правами администратора, не мешают обычному режиму
    let d = data_dir(app)?.join("tun");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn log_tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n")
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ---------- системный прокси: аварийная очистка ----------

#[cfg(target_os = "macos")]
fn clear_stale_proxy() {
    let out = match Command::new("networksetup").arg("-listallnetworkservices").output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return,
    };
    for svc in out.lines().skip(1).filter(|l| !l.starts_with('*') && !l.trim().is_empty()) {
        let cur = Command::new("networksetup").args(["-getwebproxy", svc]).output();
        let cur = cur.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        if cur.contains("127.0.0.1") && cur.contains(&format!("Port: {}", PROXY_PORT)) {
            for flag in ["-setwebproxystate", "-setsecurewebproxystate", "-setsocksfirewallproxystate"] {
                let _ = Command::new("networksetup").args([flag, svc, "off"]).status();
            }
        }
    }
}

#[cfg(windows)]
fn clear_stale_proxy() {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let cur = hidden(Command::new("reg").args(["query", key, "/v", "ProxyServer"])).output();
    let cur = cur.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    if cur.contains(&format!("127.0.0.1:{}", PROXY_PORT)) {
        let _ = hidden(Command::new("reg").args(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"])).status();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn clear_stale_proxy() {}

// ---------- режим «весь трафик» на macOS: ядро с правами администратора ----------
// Ядро запускается один раз через запрос пароля. Рядом работает сторож: пока существует файл run.flag,
// ядро живёт; приложение удаляет файл — сторож останавливает ядро. Второй раз пароль не нужен.

#[cfg(target_os = "macos")]
fn q(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', r"'\''"))
}

#[cfg(target_os = "macos")]
fn pid_alive(pid: &str) -> bool {
    Command::new("ps").args(["-p", pid]).stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn mac_tun_start(bin: &Path, dir: &Path, cfg: &Path) -> Result<(), String> {
    let flag = dir.join("run.flag");
    let pidf = dir.join("core.pid");
    let log = dir.join("sing-box.log");
    let _ = fs::remove_file(&pidf);
    fs::write(&flag, "1").map_err(|e| e.to_string())?;
    let shell = format!(
        "( {bin} run -c {cfg} -D {dir} > {log} 2>&1 < /dev/null & P=$!; echo $P > {pidf}; \
         while [ -f {flag} ] && kill -0 $P 2>/dev/null; do sleep 1; done; kill $P 2>/dev/null ) > /dev/null 2>&1 < /dev/null &",
        bin = q(bin), cfg = q(cfg), dir = q(dir), log = q(&log), pidf = q(&pidf), flag = q(&flag)
    );
    let script = format!(
        "do shell script \"{}\" with prompt \"tide включает VPN для всего трафика\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = Command::new("osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_file(&flag);
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if err.contains("-128") { "Отменено".into() } else { err });
    }
    for _ in 0..20 {
        sleep(Duration::from_millis(150));
        if pidf.exists() {
            break;
        }
    }
    sleep(Duration::from_millis(1500));
    let pid = fs::read_to_string(&pidf).unwrap_or_default().trim().to_string();
    if pid.is_empty() || !pid_alive(&pid) {
        let _ = fs::remove_file(&flag);
        return Err(format!("Ядро остановилось:\n{}", log_tail(&log)));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_tun_stop(dir: &Path) {
    let _ = fs::remove_file(dir.join("run.flag"));
    let pid = fs::read_to_string(dir.join("core.pid")).unwrap_or_default().trim().to_string();
    if pid.is_empty() {
        return;
    }
    for _ in 0..40 {
        if !pid_alive(&pid) {
            break;
        }
        sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "macos")]
fn mac_tun_running(dir: &Path) -> bool {
    let pid = fs::read_to_string(dir.join("core.pid")).unwrap_or_default().trim().to_string();
    dir.join("run.flag").exists() && !pid.is_empty() && pid_alive(&pid)
}

// ---------- остановка ----------

fn stop_core(app: &AppHandle, core: &mut Core) {
    if let Some(mut c) = core.child.take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(c.id() as i32, libc::SIGTERM); // ядро само уберёт системный прокси
        }
        let mut done = false;
        for _ in 0..30 {
            if let Ok(Some(_)) = c.try_wait() {
                done = true;
                break;
            }
            if cfg!(windows) {
                break;
            }
            sleep(Duration::from_millis(100));
        }
        if !done {
            let _ = c.kill();
            let _ = c.wait();
        }
        if core.proxy_mode {
            clear_stale_proxy();
        }
    }
    if core.tun_root {
        #[cfg(target_os = "macos")]
        {
            if let Ok(d) = tun_dir(app) {
                mac_tun_stop(&d);
            }
        }
        core.tun_root = false;
    }
    let _ = app;
}

// ---------- команды для интерфейса ----------

#[tauri::command]
async fn fetch_sub(url: String) -> Result<SubResp, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SubResp, String> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
        match agent.get(&url).set("User-Agent", "tide-desktop/1.0").call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => {
                let status = r.status();
                let mut headers = HashMap::new();
                for n in r.headers_names() {
                    if let Some(v) = r.header(&n) {
                        headers.insert(n.to_lowercase(), v.to_string());
                    }
                }
                let body = r.into_string().map_err(|e| e.to_string())?;
                Ok(SubResp { status, body, headers })
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clash(method: String, path: String, body: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
        let req = agent.request(&method, &format!("http://{}{}", CLASH, path));
        let res = match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(&b),
            None => req.call(),
        };
        match res {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r.into_string().map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>, config: String, tun: bool) -> Result<(), String> {
    let mut core = state.0.lock().map_err(|e| e.to_string())?;
    stop_core(&app, &mut core);
    let bin = singbox_path();
    if !bin.exists() {
        return Err(format!("Не найдено ядро: {}", bin.display()));
    }

    #[cfg(target_os = "macos")]
    {
    if tun {
        let dir = tun_dir(&app)?;
        let cfg = dir.join("config.json");
        fs::write(&cfg, &config).map_err(|e| e.to_string())?;
        mac_tun_start(&bin, &dir, &cfg)?;
        core.tun_root = true;
        core.proxy_mode = false;
        return Ok(());
    }
    }

    let dir = if tun { tun_dir(&app)? } else { data_dir(&app)? };
    let cfg = dir.join("config.json");
    let log = dir.join("sing-box.log");
    fs::write(&cfg, &config).map_err(|e| e.to_string())?;
    let logf = fs::File::create(&log).map_err(|e| e.to_string())?;
    let logf2 = logf.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&bin);
    cmd.arg("run").arg("-c").arg(&cfg).arg("-D").arg(&dir);
    cmd.stdin(Stdio::null()).stdout(logf).stderr(logf2);
    let mut child = hidden(&mut cmd).spawn().map_err(|e| e.to_string())?;
    sleep(Duration::from_millis(1500));
    if let Ok(Some(_)) = child.try_wait() {
        let tail = log_tail(&log);
        let hint = if tun && (tail.contains("Access is denied") || tail.contains("access denied") || tail.contains("permission")) {
            "\n\nДля режима «Весь трафик» запустите tide от имени администратора."
        } else {
            ""
        };
        return Err(format!("Ядро остановилось:\n{}{}", tail, hint));
    }
    core.child = Some(child);
    core.proxy_mode = !tun;
    core.tun_root = false;
    Ok(())
}

#[tauri::command]
async fn disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state.0.lock().map_err(|e| e.to_string())?;
    stop_core(&app, &mut core);
    Ok(())
}

#[tauri::command]
async fn status(app: AppHandle, state: State<'_, AppState>) -> Result<Status, String> {
    let mut core = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(c) = core.child.as_mut() {
        if let Ok(Some(_)) = c.try_wait() {
            core.child = None;
            if core.proxy_mode {
                clear_stale_proxy();
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if core.tun_root {
            if let Ok(d) = tun_dir(&app) {
                if !mac_tun_running(&d) {
                    core.tun_root = false;
                }
            }
        }
    }
    let _ = &app;
    Ok(Status { running: core.child.is_some() || core.tun_root, tun: core.tun_root || (core.child.is_some() && !core.proxy_mode) })
}

#[tauri::command]
async fn core_log(app: AppHandle) -> Result<String, String> {
    let a = log_tail(&data_dir(&app)?.join("sing-box.log"));
    let b = log_tail(&tun_dir(&app)?.join("sing-box.log"));
    Ok(format!("{}\n{}", a, b))
}

#[tauri::command]
fn platform() -> String {
    std::env::consts::OS.to_string()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(Mutex::new(Core::default())))
        .invoke_handler(tauri::generate_handler![fetch_sub, clash, connect, disconnect, status, core_log, platform])
        .setup(|app| {
            let handle = app.handle().clone();
            // после аварийного выхода: остановить старое ядро и вернуть сеть
            #[cfg(target_os = "macos")]
            {
                if let Ok(d) = tun_dir(&handle) {
                    mac_tun_stop(&d);
                }
            }
            let _ = &handle;
            clear_stale_proxy();

            let show = MenuItem::with_id(app, "show", "Открыть tide", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Подключить / отключить", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
            let mut tray = TrayIconBuilder::with_id("tide")
                .tooltip("tide")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "toggle" => {
                        let _ = app.emit("tray-toggle", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // крестик прячет окно, VPN продолжает работать; выход — через трей
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("не удалось запустить tide");

    app.run(|handle, event| match event {
        RunEvent::Exit => {
            let state = handle.state::<AppState>();
            if let Ok(mut core) = state.0.lock() {
                stop_core(handle, &mut core);
            };
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        _ => {}
    });
}
