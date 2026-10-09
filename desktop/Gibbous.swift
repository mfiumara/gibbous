// Gibbous for macOS: a native window around the local Gibbous server (WKWebView), with native notifications.
// Build: scripts/build-mac-app.sh
import Cocoa
import WebKit
import UserNotifications
import ServiceManagement
import Carbon.HIToolbox

// Esc belongs to the page (close, cancel, leave the message box). AppKit's default would take an unhandled Esc out of
// full screen; ⌃⌘F, the green button and View → Enter Full Screen still toggle it.
final class Window: NSWindow {
  override func cancelOperation(_ sender: Any?) {}
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

let base = URL(string: ProcessInfo.processInfo.environment["GIBBOUS_URL"] ?? "http://127.0.0.1:7878")!

func loginURL(next: String = "") -> URL {
  let secret = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".gibbous/secret.json")
  let token = (try? JSONSerialization.jsonObject(with: Data(contentsOf: secret))) .flatMap { ($0 as? [String: Any])?["accessToken"] as? String } ?? ""
  var c = URLComponents(url: base.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
  // Encoded by hand: URLComponents leaves & and = in values, which would split a route like #/search?q=a&b.
  let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
  let enc = { (v: String) in v.addingPercentEncoding(withAllowedCharacters: safe) ?? "" }
  c.percentEncodedQuery = "token=\(enc(token))&next=\(enc(next))"
  return c.url!
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: Web!
  let defaults = UserDefaults.standard

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
    web.load(URLRequest(url: loginURL(next: lastRoute)))
  }

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
    let attachment = ((r.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment")
    decisionHandler(attachment || !r.canShowMIMEType ? .download : .allow)
  }
  func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
  func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }
  func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
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
    func page(_ t: String, _ cmd: String, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = item(t, #selector(pageCommand(_:)), k, mods); i.representedObject = cmd; i.target = self; return i }
    sub("Gibbous", [item("About Gibbous", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""), .separator(), page("Settings…", "settings", ","), .separator(),
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

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
