//! The Gibbous server bundled with the app (resources/gibbous-server: Node 22 + the server + the web app, staged by
//! scripts/bundle-server.mjs). The app starts it when no Gibbous server answers on the local port, stops it on quit,
//! or hands it to a per-user login service ("Keep Gibbous running in the background": a systemd user unit on Linux,
//! a Scheduled Task on Windows) that runs `<this app> --serve`, so the service always runs the installed app's copy
//! and updates with it. A Gibbous you installed yourself (scripts/install-service.*) is never touched: the app uses
//! it when it answers and offers no background option of its own.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The bundle inside the app's resources, when this build has one.
pub fn bundle_dir(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    let d = resource_dir?.join("gibbous-server");
    node_bin(&d).is_file().then_some(d)
}

pub fn node_bin(bundle: &Path) -> PathBuf {
    bundle.join("node").join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// How to start the server: the POSIX `run` launcher (login-shell PATH, port from login-url) or node directly.
pub fn command(bundle: &Path, port: Option<u16>, log_to_home: bool) -> Command {
    let mut c = if cfg!(windows) {
        let mut c = Command::new(node_bin(bundle));
        c.arg("--disable-warning=ExperimentalWarning").arg(bundle.join("app").join("server").join("main.ts"));
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.arg(bundle.join("run"));
        if log_to_home {
            c.env("GIBBOUS_LOG", "1");
        }
        c
    };
    if let Some(p) = port {
        c.env("GIBBOUS_PORT", p.to_string());
    }
    c.env_remove("GIBBOUS_URL").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Output goes where the service install puts it: GIBBOUS_HOME/gibbous.log.
fn log_file(home: &Path) -> Option<std::fs::File> {
    let _ = std::fs::create_dir_all(home);
    std::fs::OpenOptions::new().create(true).append(true).open(home.join("gibbous.log")).ok()
}

#[derive(Default)]
pub struct LocalServer {
    child: Mutex<Option<Child>>,
    starts: Mutex<Vec<Instant>>,
}

impl LocalServer {
    pub fn running(&self) -> bool {
        let mut c = self.child.lock().unwrap();
        match c.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *c = None;
                false
            }
            None => false,
        }
    }

    /// Start the bundled server (at most 5 times a minute, so a crash loop doesn't spin).
    pub fn start(&self, bundle: &Path, home: &Path, port: u16) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        {
            let mut s = self.starts.lock().unwrap();
            s.retain(|t| t.elapsed() < Duration::from_secs(60));
            if s.len() >= 5 {
                return Err("the bundled server keeps exiting; see gibbous.log".into());
            }
            s.push(Instant::now());
        }
        let mut c = command(bundle, Some(port), false);
        c.env("GIBBOUS_HOME", home);
        if let Some(f) = log_file(home) {
            if let Ok(f2) = f.try_clone() {
                c.stdout(f).stderr(f2);
            }
        }
        let child = c.spawn().map_err(|e| format!("couldn't start the bundled server: {e}"))?;
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    /// Stop the server this app started (never one it found running). SIGTERM on Unix so it saves and exits.
    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        #[cfg(unix)]
        {
            // `sh run` execs node, so the pid is node's.
            let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// `gibbous --serve`: run the bundled server in the foreground (the login service's entry point).
pub fn serve(bundle: &Path) -> i32 {
    let mut c = command(bundle, None, true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = c.exec(); // replaces this process: systemd tracks node itself
        eprintln!("gibbous --serve: {e}");
        1
    }
    #[cfg(windows)]
    {
        let home = std::env::var_os("GIBBOUS_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".gibbous")));
        if let Some(f) = home.as_deref().and_then(log_file) {
            if let Ok(f2) = f.try_clone() {
                c.stdout(f).stderr(f2);
            }
        }
        match c.status() {
            Ok(s) => s.code().unwrap_or(1),
            Err(e) => {
                eprintln!("gibbous --serve: {e}");
                1
            }
        }
    }
}

// ── login service ────────────────────────────────────────────────────────────
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub const SERVICE: &str = if cfg!(windows) { "Gibbous app server" } else { "gibbous-app.service" };

/// The executable a service should run: the AppImage itself (its mount point changes every run), else this binary.
pub fn app_exe() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok())
}

#[cfg(target_os = "linux")]
fn unit_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|d| d.join("systemd").join("user"))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// systemd user unit for `<exe> --serve` (same shape as scripts/install-service.sh's, its own name).
pub fn unit_text(exe: &Path) -> String {
    format!(
        "[Unit]\nDescription=Gibbous (server bundled with the Gibbous app)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=\"{}\" --serve\nRestart=always\nRestartSec=5\n# hermes serve is started detached: keep it running when Gibbous restarts or stops.\nKillMode=process\n\n[Install]\nWantedBy=default.target\n",
        exe.display().to_string().replace('"', "\\\"")
    )
}

/// The user's own Gibbous service (scripts/install-service.sh / .ps1), which the app leaves alone.
pub fn own_service() -> bool {
    #[cfg(target_os = "linux")]
    return unit_dir().is_some_and(|d| d.join("gibbous.service").exists());
    #[cfg(windows)]
    return task_exists("Gibbous");
    #[allow(unreachable_code)]
    false
}

pub fn background_enabled() -> bool {
    #[cfg(target_os = "linux")]
    return unit_dir().is_some_and(|d| d.join(SERVICE).exists());
    #[cfg(windows)]
    return task_exists(SERVICE);
    #[allow(unreachable_code)]
    false
}

#[cfg(windows)]
fn hidden(c: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
}

#[cfg(windows)]
fn task_exists(name: &str) -> bool {
    hidden(Command::new("schtasks").args(["/Query", "/TN", name])).status().is_ok_and(|s| s.success())
}

#[cfg(windows)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Turn the login service on (the app's own server must be stopped first: same port) or off.
pub fn set_background(on: bool) -> Result<(), String> {
    let exe = app_exe().ok_or("can't find the app's executable")?;
    #[cfg(target_os = "linux")]
    {
        let dir = unit_dir().ok_or("no home directory")?;
        let unit = dir.join(SERVICE);
        let ctl = |args: &[&str]| Command::new("systemctl").arg("--user").args(args).status().map_err(|e| e.to_string());
        if on {
            if Command::new("systemctl").args(["--user", "show-environment"]).stdout(Stdio::null()).status().map_or(true, |s| !s.success()) {
                return Err("No systemd user session here, so Gibbous can't run in the background on its own.".into());
            }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&unit, unit_text(&exe)).map_err(|e| e.to_string())?;
            ctl(&["daemon-reload"])?;
            if !ctl(&["enable", "--now", SERVICE])?.success() {
                return Err("systemctl --user enable --now gibbous-app.service failed".into());
            }
        } else {
            let _ = ctl(&["disable", "--now", SERVICE]);
            let _ = std::fs::remove_file(&unit);
            let _ = ctl(&["daemon-reload"]);
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        // Same task shape as scripts/install-service.ps1 (at logon, restart on failure, no time limit), own name.
        let script = if on {
            format!(
                "$ErrorActionPreference='Stop'; $u=\"$env:USERDOMAIN\\$env:USERNAME\"; \
                 $a=New-ScheduledTaskAction -Execute {exe} -Argument '--serve'; \
                 $t=New-ScheduledTaskTrigger -AtLogOn -User $u; \
                 $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew; \
                 $p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; \
                 Register-ScheduledTask -TaskName {name} -Action $a -Trigger $t -Settings $s -Principal $p -Force -Description 'Gibbous: the server bundled with the Gibbous app' | Out-Null; \
                 Start-ScheduledTask -TaskName {name}",
                exe = ps_quote(&exe.display().to_string()),
                name = ps_quote(SERVICE)
            )
        } else {
            format!(
                "Stop-ScheduledTask -TaskName {name} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName {name} -Confirm:$false -ErrorAction SilentlyContinue",
                name = ps_quote(SERVICE)
            )
        };
        let ok = hidden(Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script]))
            .status()
            .map_err(|e| e.to_string())?
            .success();
        if !ok && on {
            return Err("Couldn't create the Scheduled Task".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (on, exe);
        Err("not supported here".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_runs_the_app_with_serve() {
        let u = unit_text(Path::new("/opt/Gibbous/gibbous"));
        assert!(u.contains("ExecStart=\"/opt/Gibbous/gibbous\" --serve\n"));
        assert!(u.contains("KillMode=process"));
    }

    #[test]
    fn bundle_needs_node() {
        let d = std::env::temp_dir().join(format!("gibbous-bundle-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(bundle_dir(Some(d.clone())).is_none());
        let b = d.join("gibbous-server");
        std::fs::create_dir_all(b.join("node")).unwrap();
        std::fs::write(node_bin(&b), b"").unwrap();
        assert_eq!(bundle_dir(Some(d.clone())), Some(b));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn command_sets_the_port_and_drops_gibbous_url() {
        let c = command(Path::new("/b"), Some(7995), false);
        let envs: Vec<_> = c.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        assert!(envs.contains(&("GIBBOUS_PORT".into(), Some("7995".into()))));
        assert!(envs.contains(&("GIBBOUS_URL".into(), None)));
    }
}
