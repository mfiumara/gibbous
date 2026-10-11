// Gibbous for macOS: a native window around the local Gibbous server (WKWebView), with native notifications.
// Build: scripts/build-mac-app.sh (local ad-hoc, unsandboxed), the GibbousMac target in ios/project.yml (App Sandbox,
// TestFlight), or scripts/release-mac.sh (Developer ID DMG). Everything here must stay sandbox-safe: no file access
// outside ~/Downloads, files the user picks, and the read-only ~/.gibbous exception (which App Store builds don't
// have). The one subprocess, the bundled server (LocalServer below), only exists in the Developer ID DMG.
import Cocoa
import WebKit
import UserNotifications
import ServiceManagement
import Carbon.HIToolbox

// Esc belongs to the page (close, cancel, leave the message box). AppKit's default would take an unhandled Esc out of
// full screen; ⌃⌘F, the green button and View → Enter Full Screen still toggle it.
final class Window: NSWindow {
  override func cancelOperation(_ sender: Any?) {}
  // An Esc the page didn't preventDefault (a native <dialog> closing itself did that) also reaches the window's
  // keyDown, which leaves full screen. Swallow it here too.
  override func keyDown(with e: NSEvent) { if e.keyCode == 53 { return }; super.keyDown(with: e) }
}

// The page, minus the browser: no pinch zoom, swipes or link previews, and a context menu without Reload/Back/
// Inspect. Remembers the last mouse-down so a drag the page asks for (gibbousWindow {drag}) can start from it.
final class Web: WKWebView {
  var lastMouseDown: NSEvent?
  override func mouseDown(with e: NSEvent) { lastMouseDown = e; super.mouseDown(with: e) }
  static let browserItems: Set<String> = ["Reload", "GoBack", "GoForward", "InspectElement", "OpenLinkInNewWindow", "DownloadLinkedFile",
    "OpenImageInNewWindow", "DownloadImage", "OpenFrameInNewWindow", "OpenMediaInNewWindow", "DownloadMedia"].reduce(into: []) { $0.insert("WKMenuItemIdentifier" + $1) }
  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
    super.willOpenMenu(menu, with: event)
    if event.modifierFlags.contains(.option) { return }  // ⌥-right-click keeps the full menu (Inspect Element) for debugging
    menu.items.filter { Web.browserItems.contains($0.identifier?.rawValue ?? "") }.forEach(menu.removeItem)
    // Tidy the separators left behind; an empty menu (chrome, no selection) simply doesn't open.
    var prevSep = true
    for i in menu.items { if i.isSeparatorItem && prevSep { menu.removeItem(i) } else { prevSep = i.isSeparatorItem } }
    if menu.items.last?.isSeparatorItem == true { menu.removeItem(menu.items.last!) }
  }
}

// A saved route must look like one the server's /login?next= accepts, or it would land on home anyway.
func isRoute(_ h: String) -> Bool { h.range(of: #"^#/[\w/?=&%.~-]*$"#, options: .regularExpression) != nil }

// The user's real home. In the App Sandbox NSHomeDirectory()/homeDirectoryForCurrentUser point into the container.
let realHome = URL(fileURLWithPath: getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } } ?? NSHomeDirectory())
let gibbousHome = realHome.appendingPathComponent(".gibbous")

// Zero-setup sign-in: ~/.gibbous/login-url (written by the server: its port and token) and secret.json. Readable
// unsandboxed and in the TestFlight build (read-only ~/.gibbous exception); an App Store build can't read them,
// gets no token, and the page shows its own Sign in screen (paste the link once; the cookie lasts a year).
func localLink() -> URL? {
  guard let s = try? String(contentsOf: gibbousHome.appendingPathComponent("login-url"), encoding: .utf8) else { return nil }
  return URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines))
}
func localToken() -> String {
  let secret = gibbousHome.appendingPathComponent("secret.json")
  if let t = (try? JSONSerialization.jsonObject(with: Data(contentsOf: secret))).flatMap({ ($0 as? [String: Any])?["accessToken"] as? String }), !t.isEmpty { return t }
  return localLink().flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value } ?? ""
}
func origin(_ u: URL) -> URL? {
  guard let s = u.scheme?.lowercased(), s == "http" || s == "https", let h = u.host else { return nil }
  var c = URLComponents(); c.scheme = s; c.host = h; c.port = u.port
  return c.url
}
// Server: $GIBBOUS_URL, else the local server's own link (follows a changed port), else the origin of the last
// pasted sign-in link, else the default port.
var base: URL = ProcessInfo.processInfo.environment["GIBBOUS_URL"].flatMap(URL.init(string:))
  ?? localLink().flatMap(origin)
  ?? UserDefaults.standard.string(forKey: "server").flatMap(URL.init(string:))
  ?? URL(string: "http://127.0.0.1:7878")!

func loginURL(next: String = "") -> URL {
  let token = localToken()
  // No token readable: open the app directly. A saved cookie signs in; otherwise the page shows Sign in.
  if token.isEmpty { return URL(string: base.absoluteString.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression) + "/" + next)! }
  var c = URLComponents(url: base.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
  // Encoded by hand: URLComponents leaves & and = in values, which would split a route like #/search?q=a&b.
  let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
  let enc = { (v: String) in v.addingPercentEncoding(withAllowedCharacters: safe) ?? "" }
  c.percentEncodedQuery = "token=\(enc(token))&next=\(enc(next))"
  return c.url!
}

// ── bundled server (Developer ID DMG only) ──────────────────────────────
// The DMG app carries Node + the Gibbous server in Contents/Resources/gibbous-server (scripts/bundle-server.mjs,
// embedded by scripts/mac-embed-server.sh). On launch: a server already answering on the local port (your own
// install, or the background agent) is used as is; otherwise the app starts its bundled one with the same data
// (~/.gibbous) and stops it on quit, unless "Keep Gibbous running in the background" registered the login agent
// (Contents/Library/LaunchAgents/dev.gibbous.desktop.server.plist via SMAppService).
let bundledServer: URL? = {
  guard ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] == nil,
        let u = Bundle.main.resourceURL?.appendingPathComponent("gibbous-server/run"),
        FileManager.default.isExecutableFile(atPath: u.path) else { return nil }
  return u
}()

final class LocalServer {
  private var proc: Process?
  private var stopping = false
  private var starts: [Date] = []
  let agent = SMAppService.agent(plistName: "dev.gibbous.desktop.server.plist")

  var available: Bool { bundledServer != nil }
  /// The server the app talks to is this Mac's (not a pasted remote one, not $GIBBOUS_URL).
  var isLocal: Bool { ProcessInfo.processInfo.environment["GIBBOUS_URL"] == nil && ["127.0.0.1", "localhost", "::1"].contains(base.host ?? "") }
  /// A Gibbous you installed yourself (scripts/install-service.sh): the app never starts a second one, and never
  /// touches that service.
  var ownService: Bool { FileManager.default.fileExists(atPath: realHome.appendingPathComponent("Library/LaunchAgents/dev.gibbous.server.plist").path) }
  var background: Bool { agent.status == .enabled }
  var running: Bool { proc?.isRunning == true }

  /// Any HTTP answer on the local port means a server is up (the sign-in route answers 401 without a token).
  func answering(_ done: @escaping (Bool) -> Void) {
    var r = URLRequest(url: base.appendingPathComponent("login"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
    r.httpMethod = "HEAD"
    URLSession.shared.dataTask(with: r) { _, res, _ in done(res is HTTPURLResponse) }.resume()
  }

  /// Start the bundled server unless one answers already, or another start is on its way (your login service, the
  /// background agent). The page load retries until it answers.
  func ensure() {
    guard available, isLocal, !ownService, !background, !running else { return }
    answering { up in if !up { DispatchQueue.main.async { self.start() } } }
  }

  private func start() {
    guard let run = bundledServer, !running else { return }
    starts = starts.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
    guard starts.count <= 5 else { NSLog("gibbous: bundled server keeps exiting; see ~/.gibbous/gibbous.log"); return }
    stopping = false
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = [run.path]
    var env = ProcessInfo.processInfo.environment
    env["GIBBOUS_PORT"] = String(base.port ?? 7878)
    env.removeValue(forKey: "GIBBOUS_URL")
    p.environment = env
    try? FileManager.default.createDirectory(at: gibbousHome, withIntermediateDirectories: true)
    let logURL = gibbousHome.appendingPathComponent("gibbous.log")
    if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
    if let log = try? FileHandle(forWritingTo: logURL) { log.seekToEndOfFile(); p.standardOutput = log; p.standardError = log }
    p.standardInput = FileHandle.nullDevice
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.proc = nil
        // Crashed (not quit, not handed to the agent): start again, a few times a minute at most.
        if !self.stopping { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.ensure() } }
      }
    }
    do { try p.run(); proc = p } catch { NSLog("gibbous: couldn't start the bundled server: \(error)") }
  }

  /// Stop the server this app started (never one it found running).
  func stop() {
    stopping = true
    guard let p = proc, p.isRunning else { return }
    p.terminate()  // SIGTERM: the server saves state and exits; hermes serve keeps running (detached)
    let deadline = Date().addingTimeInterval(4)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    proc = nil
  }

  /// "Keep Gibbous running in the background": hand the server to the login agent (runs the copy inside this app,
  /// so it updates with the app), or take it back.
  func setBackground(_ on: Bool) throws {
    if on {
      stop()
      try agent.register()
      if agent.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    } else {
      try agent.unregister()
      starts = []
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.ensure() }
    }
  }
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: Web!
  let defaults = UserDefaults.standard
  let server = LocalServer()

  func applicationDidFinishLaunching(_ n: Notification) {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "gibbousNotify")
    config.userContentController.add(self, name: "gibbousBadge")
    config.userContentController.add(self, name: "gibbousWindow")
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    config.preferences.isElementFullscreenEnabled = true  // the video player's full-screen button
    if #available(macOS 14.0, *) { config.allowsInlinePredictions = false }  // no grey word guesses in the prompt box
    web = Web(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints; the sidebar shows the glass below
    web.allowsMagnification = false
    web.allowsLinkPreview = false
    web.allowsBackForwardNavigationGestures = false

    // Like Notes/Finder: the content runs under the title bar and the traffic lights sit in the sidebar. The page
    // reserves the strip itself ([data-shell=mac] in styles.css, height from --titlebar) and drops it in full screen.
    window = Window(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = "Gibbous"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    if #available(macOS 11.0, *) { window.titlebarSeparatorStyle = .none }
    window.tabbingMode = .disallowed  // no “Show Tab Bar”: one window
    window.delegate = self
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(red: 0x16 / 255, green: 0x18 / 255, blue: 0x1d / 255, alpha: 1)
    // Sidebar glass behind the whole page: the page is transparent over the sidebar and paints the main pane solid.
    let glass = NSVisualEffectView()
    glass.material = .sidebar
    glass.blendingMode = .behindWindow
    glass.state = .followsWindowActiveState
    window.contentView = glass
    glass.addSubview(web)
    web.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: glass.topAnchor), web.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: glass.leadingAnchor), web.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
    ])
    installShellScript()
    window.setFrameAutosaveName("GibbousMain")
    if !window.setFrameUsingName("GibbousMain") { window.center() }
    window.makeKeyAndOrderFront(nil)
    if defaults.bool(forKey: "fullScreen") { DispatchQueue.main.async { if !self.window.styleMask.contains(.fullScreen) { self.window.toggleFullScreen(nil) } } }

    buildMenu()
    buildStatusItem()
    registerHotKey()
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    server.ensure()
    web.load(URLRequest(url: loginURL(next: lastRoute)))
  }
  func applicationWillTerminate(_ n: Notification) { if !server.background { server.stop() } }

  // Where you were: the page reports every route change, and launch (or a reconnect) reopens it.
  var lastRoute: String { let r = defaults.string(forKey: "route") ?? ""; return isRoute(r) ? r : "" }

  // ── shell ⇄ page ─────────────────────────────────────────────────────────
  // Runs before any page script on every load (reloads too), so the first paint already has the title-bar inset.
  func shellScript() -> String {
    let titlebar = max(0, Int((window.frame.height - window.contentLayoutRect.height).rounded()))
    let fs = window.styleMask.contains(.fullScreen)
    // At document start WebKit has no <html> element yet (documentElement is null), so setting attributes directly threw
    // and the page never knew it was in the app. Leave the values on window (main.tsx applies them before the first
    // render) and also set them as soon as <html> exists.
    return "(() => { window.__gibbousShell = { titlebar: \(titlebar), fullscreen: \(fs) }; const apply = () => { const d = document.documentElement; if (!d) return false; d.dataset.shell = 'mac'; d.style.setProperty('--titlebar', '\(titlebar)px'); \(fs ? "d.dataset.fullscreen = ''" : "delete d.dataset.fullscreen"); return true; }; if (!apply()) new MutationObserver((_, o) => { if (apply()) o.disconnect(); }).observe(document, { childList: true }); })()"
  }
  func installShellScript() {
    let u = web.configuration.userContentController
    u.removeAllUserScripts()
    u.addUserScript(WKUserScript(source: shellScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }
  // Full screen hides the traffic lights, so the page drops the strip; “will” so it moves with the transition.
  func fullScreen(_ on: Bool) {
    web.evaluateJavaScript(on ? "document.documentElement.dataset.fullscreen = ''" : "delete document.documentElement.dataset.fullscreen")
  }
  func windowWillEnterFullScreen(_ n: Notification) { fullScreen(true) }
  func windowWillExitFullScreen(_ n: Notification) { fullScreen(false) }
  func windowDidEnterFullScreen(_ n: Notification) { defaults.set(true, forKey: "fullScreen"); installShellScript() }
  func windowDidExitFullScreen(_ n: Notification) { defaults.set(false, forKey: "fullScreen"); installShellScript() }

  // window.webkit.messageHandlers.gibbousWindow.postMessage({drag} | {theme} | {route}) from web/src/macBridge.ts
  func windowMessage(_ d: [String: Any]) {
    if d["drag"] != nil { dragOrZoom() }
    if let t = d["theme"] as? String { window.appearance = NSAppearance(named: t == "light" ? .aqua : .darkAqua) }
    if let r = d["route"] as? String, isRoute(r) { defaults.set(r, forKey: "route") }
  }
  // Empty header space acts as a title bar: drag moves the window, a double-click does what System Settings says
  // (Desktop & Dock → “Double-click a window's title bar to”). The page only asks when the press wasn't on a control.
  func dragOrZoom() {
    guard let e = web.lastMouseDown, e.type == .leftMouseDown, ProcessInfo.processInfo.systemUptime - e.timestamp < 1,
          !window.styleMask.contains(.fullScreen) else { return }
    if e.clickCount == 2 {
      switch defaults.string(forKey: "AppleActionOnDoubleClick") {
      case "Minimize": window.miniaturize(nil)
      case "None": break
      default: window.zoom(nil)
      }
    } else if e.clickCount == 1, NSEvent.pressedMouseButtons & 1 != 0 {  // released already: it was a click, not a drag
      window.performDrag(with: e)
    }
  }

  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

  // The server may still be starting (launchd); keep retrying instead of showing an error page. Only for "can't reach
  // the server" errors: a download or an editor link also ends a navigation with an error, and reloading the whole
  // app for those threw away what you were doing.
  func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
    let err = e as NSError
    let unreachable: Set<Int> = [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotFindHost, NSURLErrorNotConnectedToInternet]
    guard err.domain == NSURLErrorDomain, unreachable.contains(err.code) else { return }
    server.ensure()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { w.load(URLRequest(url: loginURL(next: self.lastRoute))) }
  }

  // Gibbous pages stay in the window; web links open in the default browser, app links (vscode://, cursor://,
  // mailto:) in their app, and downloads (<a download>, attachments) save to ~/Downloads instead of replacing the app.
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if a.shouldPerformDownload { return decisionHandler(.download) }
    // A file route opened as a page would replace the app with no way back: save it instead.
    if a.targetFrame?.isMainFrame != false, let u = a.request.url, u.host == base.host, ["/api/media", "/api/image"].contains(u.path) { return decisionHandler(.download) }
    if let u = a.request.url, let s = u.scheme?.lowercased() {
      if (s == "http" || s == "https") && u.host != base.host { NSWorkspace.shared.open(u); return decisionHandler(.cancel) }
      if !["http", "https", "about", "blob", "data"].contains(s) { NSWorkspace.shared.open(u); return decisionHandler(.cancel) }
    }
    decisionHandler(.allow)
  }
  func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    // A stale token (server re-keyed) answers 401 at /login: show the page's Sign in screen, not a JSON error.
    if let h = r.response as? HTTPURLResponse, h.statusCode == 401, r.isForMainFrame, h.url?.path == "/login" {
      decisionHandler(.cancel); w.load(URLRequest(url: base)); return
    }
    let attachment = ((r.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment")
    decisionHandler(attachment || !r.canShowMIMEType ? .download : .allow)
  }
  func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
  func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }
  func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler: @escaping (URL?) -> Void) {
    // Sandboxed, this is the container's Downloads: a symlink to ~/Downloads (files.downloads.read-write).
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath()
    let stem = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var url = dir.appendingPathComponent(name), n = 1
    while FileManager.default.fileExists(atPath: url.path) { n += 1; url = dir.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)") }
    downloads[ObjectIdentifier(d)] = url
    completionHandler(url)
  }
  var downloads: [ObjectIdentifier: URL] = [:]
  func downloadDidFinish(_ d: WKDownload) {
    // Bounce the Dock's Downloads stack, like Safari does.
    if let url = downloads.removeValue(forKey: ObjectIdentifier(d)) { DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path) }
  }
  func download(_ d: WKDownload, didFailWithError e: Error, resumeData: Data?) { downloads.removeValue(forKey: ObjectIdentifier(d)) }
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { NSWorkspace.shared.open(u) }
    return nil
  }

  // JS dialogs (Gibbous uses confirm/prompt) and <input type=file>.
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }
  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert(); a.messageText = p; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); field.stringValue = d ?? ""
    a.accessoryView = field; a.window.initialFirstResponder = field
    completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel(); panel.allowsMultipleSelection = p.allowsMultipleSelection; panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // window.webkit.messageHandlers.gibbousNotify.postMessage({title, body, url})
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    if m.name == "gibbousBadge" { setBadge((m.body as? Int) ?? 0); return }
    guard let d = m.body as? [String: Any] else { return }
    if m.name == "gibbousWindow" { windowMessage(d); return }
    let content = UNMutableNotificationContent()
    content.title = d["title"] as? String ?? "Gibbous"
    content.body = d["body"] as? String ?? ""
    content.sound = .default
    content.userInfo = ["url": d["url"] as? String ?? ""]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let url = r.notification.request.content.userInfo["url"] as? String ?? ""
    let hash = url.replacingOccurrences(of: "/#", with: "#")
    NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    if hash.hasPrefix("#") { web.evaluateJavaScript("location.hash = \(String(reflecting: hash))") }
    done()
  }
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) { done([.banner, .sound]) }

  // Menu commands that drive the page go through window.gibbousMenu (web/src/macBridge.ts). Their shortcuts are the
  // page's own: WebKit offers a key to the page first and only hands it to the menu when the page didn't take it,
  // so ⌘N/⌘K/⌘\ still run exactly once (macBridge.ts also skips a command whose key the page just handled).
  func buildMenu() {
    let main = NSMenu()
    @discardableResult func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu { let i = NSMenuItem(); let m = NSMenu(title: title); items.forEach(m.addItem); i.submenu = m; main.addItem(i); return m }
    func item(_ t: String, _ s: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: s, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
    func action(_ t: String, _ s: Selector) -> NSMenuItem { let i = item(t, s, ""); i.target = self; return i }
    func page(_ t: String, _ cmd: String, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = item(t, #selector(pageCommand(_:)), k, mods); i.representedObject = cmd; i.target = self; return i }
    sub("Gibbous", [item("About Gibbous", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""), .separator(), page("Settings…", "settings", ","), action("Sign In with Link…", #selector(signInWithLink)), .separator(),
                    item("Hide Gibbous", #selector(NSApplication.hide(_:)), "h"), item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
                    item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""), .separator(), item("Quit Gibbous", #selector(NSApplication.terminate(_:)), "q")])
    sub("File", [page("New Thread", "new", "n"), .separator(), item("Close Window", #selector(NSWindow.performClose(_:)), "w")])
    sub("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                 item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"), item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a"),
                 .separator(), page("Find in Thread…", "find", "f")])
    sub("View", [page("Toggle Sidebar", "sidebar", "s", [.command, .control]), page("Toggle Side Panel", "panel", "\\"), .separator(),
                 item("Reload", #selector(reload), "r"), .separator(), item("Toggle Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
    sub("Go", [item("Back", #selector(goBack), "["), item("Home", #selector(goHome), "h", [.command, .shift]), page("Inbox", "inbox", "i", [.command, .shift]), .separator(),
               page("Search or Jump To…", "palette", "k")])
    sub("Thread", [page("Stop the Running Turn", "stop", "."), page("Allow the Pending Approval", "approve", "a", [.command, .shift])])
    NSApp.windowsMenu = sub("Window", [item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"), item("Zoom", #selector(NSWindow.zoom(_:)), ""), .separator(),
                                      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "")])
    NSApp.helpMenu = sub("Help", [page("Keyboard Shortcuts", "help", "/")])
    NSApp.mainMenu = main
  }
  @objc func pageCommand(_ sender: NSMenuItem) { run(sender.representedObject as? String ?? "") }
  // Pages from an older build have no gibbousMenu yet: routes still work by hash, thread commands by their event.
  func run(_ cmd: String) {
    let hash = ["new": "#/new", "settings": "#/settings", "inbox": "#/inbox"][cmd]
    let fallback = hash.map { "location.hash = '\($0)'" } ?? "dispatchEvent(new CustomEvent('gibbous:\(cmd)'))"
    web.evaluateJavaScript("window.gibbousMenu ? window.gibbousMenu('\(cmd)') : \(fallback)")
  }
  func applicationDockMenu(_ s: NSApplication) -> NSMenu? {
    let m = NSMenu()
    for (t, a) in [("New Thread", #selector(newThread)), ("Inbox", #selector(openInbox))] { let i = NSMenuItem(title: t, action: a, keyEquivalent: ""); i.target = self; m.addItem(i) }
    return m
  }
  // Paste a sign-in link (Settings → Devices on a signed-in device, or ~/.gibbous/login-url) or a bare token. The
  // only sign-in an App Store build has besides the page's own screen; also points the app at another server.
  @objc func signInWithLink() {
    let a = NSAlert(); a.messageText = "Sign in with a link"
    a.informativeText = "Paste the sign-in link from Settings → Devices on a signed-in device, or from ~/.gibbous/login-url on this Mac."
    a.addButton(withTitle: "Sign In"); a.addButton(withTitle: "Cancel")
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24)); field.placeholderString = "Sign-in link or token"
    a.accessoryView = field; a.window.initialFirstResponder = field
    guard a.runModal() == .alertFirstButtonReturn else { return }
    let raw = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    var token = raw
    if let u = URL(string: raw), let o = origin(u) {
      token = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value ?? ""
      base = o; defaults.set(o.absoluteString, forKey: "server")
    }
    var c = URLComponents(url: base.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
    c.queryItems = [URLQueryItem(name: "token", value: token)]
    c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    web.load(URLRequest(url: c.url!))
  }

  // Reload always lands back in the app: reloading a stray page (a file, an error) would keep you stuck on it.
  @objc func reload() { if web.url?.path.hasPrefix("/api/") == true { goHome() } else { web.reload() } }
  @objc func goBack() { if web.canGoBack { web.goBack() } else { goHome() } }
  @objc func goHome() { defaults.removeObject(forKey: "route"); web.load(URLRequest(url: loginURL())) }

  // ── menu bar + Dock badge: how many agents wait on you ──────────────────
  var status: NSStatusItem!
  func buildStatusItem() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status.button?.title = "◐"
    let m = NSMenu()
    m.addItem(NSMenuItem(title: "Open Gibbous", action: #selector(showWindow), keyEquivalent: ""))
    m.addItem(NSMenuItem(title: "New thread  ⌃⌥Space", action: #selector(newThread), keyEquivalent: ""))
    m.addItem(NSMenuItem(title: "Inbox", action: #selector(openInbox), keyEquivalent: ""))
    m.addItem(.separator())
    let login = NSMenuItem(title: "Launch at login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    m.addItem(login)
    if server.available {
      let bg = NSMenuItem(title: "Keep Gibbous running in the background", action: #selector(toggleBackground(_:)), keyEquivalent: "")
      bg.state = server.background ? .on : .off
      // Your own install (scripts/install-service.sh) already runs it at login; the app leaves that service alone.
      if server.ownService { bg.action = nil; bg.toolTip = "Your own Gibbous service already runs at login" }
      else { bg.toolTip = "Agents keep working and notifications keep coming after you quit the app" }
      m.addItem(bg)
    }
    m.addItem(.separator())
    m.addItem(NSMenuItem(title: "Quit Gibbous", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    m.items.forEach { $0.target = $0.action == #selector(NSApplication.terminate(_:)) ? nil : self }
    status.menu = m
  }
  func setBadge(_ n: Int) {
    NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    status.button?.title = n > 0 ? "◐ \(n)" : "◐"
  }
  @objc func showWindow() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
  @objc func newThread() { showWindow(); run("new") }
  @objc func openInbox() { showWindow(); run("inbox") }
  @objc func toggleBackground(_ item: NSMenuItem) {
    do { try server.setBackground(!server.background) }
    catch { let a = NSAlert(); a.messageText = "Couldn't change the background server"; a.informativeText = error.localizedDescription; a.runModal() }
    item.state = server.background ? .on : .off
  }
  @objc func toggleLogin(_ item: NSMenuItem) {
    do {
      if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister(); item.state = .off }
      else { try SMAppService.mainApp.register(); item.state = .on }
    } catch { let a = NSAlert(); a.messageText = "Couldn't change launch at login"; a.informativeText = error.localizedDescription; a.runModal() }
  }

  // ── global hotkey ⌃⌥Space → new thread (Carbon hotkeys need no accessibility permission) ──
  func registerHotKey() {
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x47424253), id: 1) // 'GBBS'
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, ctx in
      let me = Unmanaged<App>.fromOpaque(ctx!).takeUnretainedValue()
      DispatchQueue.main.async { me.newThread() }
      return noErr
    }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
  }
}

// @main rather than top-level code: Xcode compiles a non-main.swift file as a library (scripts/build-mac-app.sh passes
// -parse-as-library to match).
@main enum Main {
  static let delegate = App()
  static func main() {
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}
