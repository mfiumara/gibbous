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

let base = URL(string: ProcessInfo.processInfo.environment["GIBBOUS_URL"] ?? "http://127.0.0.1:7878")!

func loginURL(next: String = "") -> URL {
  let secret = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".gibbous/secret.json")
  let token = (try? JSONSerialization.jsonObject(with: Data(contentsOf: secret))) .flatMap { ($0 as? [String: Any])?["accessToken"] as? String } ?? ""
  var c = URLComponents(url: base.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
  c.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "next", value: next)]
  return c.url!
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ n: Notification) {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "gibbousNotify")
    config.userContentController.add(self, name: "gibbousBadge")
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    config.preferences.isElementFullscreenEnabled = true  // the video player's full-screen button
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints

    window = Window(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Gibbous"
    window.titlebarAppearsTransparent = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(red: 0x16 / 255, green: 0x18 / 255, blue: 0x1d / 255, alpha: 1)
    // The page gets exactly the visible content area: pinned below the (transparent) title bar, so no window state
    // (zoomed, full screen) can extend it under the title strip and clip the top and bottom of the app.
    let box = NSView()
    window.contentView = box
    box.addSubview(web)
    web.translatesAutoresizingMaskIntoConstraints = false
    let visible = window.contentLayoutGuide as! NSLayoutGuide
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: visible.topAnchor), web.bottomAnchor.constraint(equalTo: box.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: box.leadingAnchor), web.trailingAnchor.constraint(equalTo: box.trailingAnchor),
    ])
    window.setFrameAutosaveName("GibbousMain")
    if !window.setFrameUsingName("GibbousMain") { window.center() }
    window.makeKeyAndOrderFront(nil)

    buildMenu()
    buildStatusItem()
    registerHotKey()
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    web.load(URLRequest(url: loginURL()))
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
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { w.load(URLRequest(url: loginURL())) }
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

  func buildMenu() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) { let i = NSMenuItem(); let m = NSMenu(title: title); items.forEach(m.addItem); i.submenu = m; main.addItem(i) }
    func item(_ t: String, _ s: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: s, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
    sub("Gibbous", [item("Hide Gibbous", #selector(NSApplication.hide(_:)), "h"), .separator(), item("Quit Gibbous", #selector(NSApplication.terminate(_:)), "q")])
    sub("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                 item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"), item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
    sub("View", [item("Back", #selector(goBack), "["), item("Home", #selector(goHome), "h", [.command, .shift]), .separator(), item("Reload", #selector(reload), "r"), item("Toggle Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
    sub("Window", [item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"), item("Close", #selector(NSWindow.performClose(_:)), "w")])
    NSApp.mainMenu = main
  }
  // Reload always lands back in the app: reloading a stray page (a file, an error) would keep you stuck on it.
  @objc func reload() { if web.url?.path.hasPrefix("/api/") == true { goHome() } else { web.reload() } }
  @objc func goBack() { if web.canGoBack { web.goBack() } else { goHome() } }
  @objc func goHome() { web.load(URLRequest(url: loginURL())) }

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
  @objc func newThread() { showWindow(); web.evaluateJavaScript("location.hash = '#/new'") }
  @objc func openInbox() { showWindow(); web.evaluateJavaScript("location.hash = '#/inbox'") }
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
