// The web app, full screen. Everything here is the native half of the shell contract (ios/README.md).
import UIKit
import WebKit
import SafariServices
import UserNotifications
import Network

/// WKUserContentController retains its handlers; this breaks the cycle with the view controller.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ t: WKScriptMessageHandler) { target = t }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  static let handlers = ["gibbousNotify", "gibbousBadge", "gibbousHaptic", "gibbousShare", "gibbousOpen", "gibbousPush", "gibbousRoute", "gibbousServer"]

  private(set) var web: WKWebView!
  private let splash = UIImageView(image: UIImage(named: "Logo"))
  private let unreachable = UnreachableView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private var lastURL: URL?
  /// The main frame finished loading a signed-in page: events can go to window.gibbousNative.
  private var pageReady = false
  private let monitor = NWPathMonitor()
  private var retryTimer: Timer?

  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Theme.bg

    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()  // the sign-in cookie lives here and survives relaunches
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.allowsInlinePredictions = false  // no grey word guesses in the prompt box (like the Mac app)
    config.dataDetectorTypes = []
    let uc = config.userContentController
    let weak = WeakHandler(self)
    for h in Self.handlers { uc.add(weak, name: h) }
    uc.addUserScript(WKUserScript(source: shellScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    uc.addUserScript(WKUserScript(source: noZoomScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    #if DEBUG
    uc.add(weak, name: "gibbousDebug")
    uc.addUserScript(WKUserScript(source: debugScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    #endif

    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    // No white flash: transparent until the page paints its own #16181d.
    web.isOpaque = false
    web.backgroundColor = Theme.bg
    web.underPageBackgroundColor = Theme.bg
    web.allowsBackForwardNavigationGestures = false  // the page has its own back-swipe
    web.allowsLinkPreview = false
    #if DEBUG
    web.isInspectable = true  // Safari → Develop → Simulator/iPhone
    #endif
    let sv = web.scrollView
    sv.contentInsetAdjustmentBehavior = .never  // edge to edge; the page pads with env(safe-area-inset-*)
    sv.bounces = false
    sv.alwaysBounceVertical = false
    sv.alwaysBounceHorizontal = false
    sv.minimumZoomScale = 1
    sv.maximumZoomScale = 1
    sv.pinchGestureRecognizer?.isEnabled = false
    sv.backgroundColor = Theme.bg
    // keyboardDismissMode stays .none: the page manages its own scrollers. No refresh control either.

    view.addSubview(web)
    web.translatesAutoresizingMaskIntoConstraints = false
    // The keyboard shrinks the web view (and so the page's innerHeight): nothing is covered, nothing scrolls.
    // usesBottomSafeArea = false keeps the page under the home indicator while the keyboard is down.
    view.keyboardLayoutGuide.usesBottomSafeArea = false
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: view.topAnchor),
      web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      web.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
    ])

    // The launch screen's icon stays until the page has painted, so cold start is one continuous dark screen.
    splash.contentMode = .scaleAspectFit
    splash.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(splash)
    NSLayoutConstraint.activate([
      splash.centerXAnchor.constraint(equalTo: view.centerXAnchor), splash.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      splash.widthAnchor.constraint(equalToConstant: 128), splash.heightAnchor.constraint(equalToConstant: 128),
    ])

    unreachable.isHidden = true
    unreachable.onRetry = { [weak self] in self?.retry() }
    unreachable.onChangeServer = { RootViewController.shared?.showConnect() }
    view.addSubview(unreachable)
    unreachable.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      unreachable.topAnchor.constraint(equalTo: view.topAnchor), unreachable.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      unreachable.leadingAnchor.constraint(equalTo: view.leadingAnchor), unreachable.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    spinner.color = Theme.dust
    spinner.hidesWhenStopped = true
    spinner.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(spinner)
    NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)])

    // Back online (Wi-Fi joined, Tailscale up): try again right away. Only on a change to "satisfied", not the
    // monitor's first report.
    var was: NWPath.Status?
    monitor.pathUpdateHandler = { [weak self] p in
      defer { was = p.status }
      guard p.status == .satisfied, was != nil, was != .satisfied else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.retryIfNeeded() }
    }
    monitor.start(queue: .main)
    #if DEBUG
    watchDebugScripts()
    #endif
  }

  deinit { monitor.cancel(); retryTimer?.invalidate() }

  // ── loading ──────────────────────────────────────────────────────────
  func load(_ url: URL) {
    loadViewIfNeeded()
    lastURL = url
    pageReady = false
    log.notice("load \(url.path, privacy: .public)")
    web.load(URLRequest(url: url))
  }

  /// Retry reloads the app at the last route, never a stale sign-in link.
  func retry() {
    guard let o = Server.origin else { RootViewController.shared?.showConnect(); return }
    let u = lastURL.map { $0.path == "/login" ? $0 : Server.homeURL(o) } ?? Server.homeURL(o)
    unreachable.setBusy(true)
    load(u)
  }
  func retryIfNeeded() { if !unreachable.isHidden || web.url == nil { retry() } }

  private func showUnreachable(_ e: NSError) {
    pageReady = false
    hideSplash()
    let host = Server.origin?.host ?? "your Mac"
    let detail: String
    switch e.code {
    case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff:
      detail = "This iPhone is offline. Gibbous will reconnect as soon as it's back online."
    case NSURLErrorAppTransportSecurityRequiresSecureConnection:
      detail = "\(host) needs an https address. Use the Tailscale sign-in link from Settings → Devices."
    case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorSecureConnectionFailed:
      detail = "\(host) answered with a certificate this iPhone doesn't trust."
    default:
      detail = "\(host) isn't answering. Check that the Mac is awake, Gibbous is running and Tailscale is on for both devices."
    }
    unreachable.show(detail: detail)
    if retryTimer == nil {
      // A Mac waking up doesn't change this phone's network path: keep knocking quietly.
      retryTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.retryIfNeeded() }
    }
  }
  private func hideUnreachable() {
    retryTimer?.invalidate(); retryTimer = nil
    if !unreachable.isHidden { UIView.animate(withDuration: 0.2, animations: { self.unreachable.alpha = 0 }) { _ in self.unreachable.isHidden = true; self.unreachable.alpha = 1 } }
    unreachable.setBusy(false)
  }
  private func hideSplash() {
    guard splash.alpha > 0 else { return }
    UIView.animate(withDuration: 0.25, delay: 0.1, options: [.beginFromCurrentState]) { self.splash.alpha = 0 }
  }

  func resume() {
    if !unreachable.isHidden { retry(); return }
    if pageReady { send(["type": "resume"]) } else if web.url == nil { retry() }
  }

  /// A tapped notification: `#/…` or `/#/…`. Live page → it navigates itself; otherwise load that route.
  func openFromNotification(_ url: String) {
    let hash = url.hasPrefix("/#") ? String(url.dropFirst()) : url
    guard Server.isRoute(hash) else { return }
    if pageReady { send(["type": "open", "url": url]) }
    else if let o = Server.origin { Server.route = hash; load(Server.homeURL(o)) }
  }

  /// window.gibbousNative?.(event)
  func send(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.gibbousNative?.(\(json)); void 0") { _, e in if let e { log.error("gibbousNative failed: \(e.localizedDescription, privacy: .public)") } }
  }

  // ── scripts ──────────────────────────────────────────────────────────
  private func shellScript() -> String {
    let info = Bundle.main.infoDictionary ?? [:]
    let v = info["CFBundleShortVersionString"] as? String ?? "0", b = info["CFBundleVersion"] as? String ?? "0"
    // <html> doesn't exist yet at document start in WebKit: set the dataset as soon as it does.
    return """
    (() => { window.__gibbousShell = { platform: 'ios', version: \(String(reflecting: v)), build: \(String(reflecting: b)) };
      const apply = () => { const d = document.documentElement; if (!d) return false; d.dataset.shell = 'ios'; return true; };
      if (!apply()) new MutationObserver((_, o) => { if (apply()) o.disconnect(); }).observe(document, { childList: true }); })()
    """
  }
  /// The page allows zoom (it's also a website); in the app a focused small-font field must not zoom the page.
  private let noZoomScript = """
  (() => { const m = document.querySelector('meta[name=viewport]'); if (m && !/maximum-scale/.test(m.content)) m.content += ', maximum-scale=1, user-scalable=no'; })()
  """
  #if DEBUG
  /// Debug builds log layout facts (innerHeight vs the keyboard, the shell flag) to os_log for the simulator checks.
  private let debugScript = """
  (() => { const post = (why) => { try { const d = document.documentElement, vv = window.visualViewport, ta = document.querySelector('textarea[aria-label=Message], textarea[aria-label="First message"]');
      webkit.messageHandlers.gibbousDebug.postMessage({ why, innerHeight, vvHeight: vv && vv.height, vvTop: vv && vv.offsetTop, scrollY,
        shell: d && d.dataset.shell, shellObj: JSON.stringify(window.__gibbousShell), hash: location.hash,
        composerBottom: ta ? Math.round(ta.getBoundingClientRect().bottom) : null, focused: document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName) }); } catch (e) {} };
    window.__gibbousDebugPost = post;
    addEventListener('resize', () => post('resize')); addEventListener('load', () => setTimeout(() => post('load'), 500));
    addEventListener('error', e => webkit.messageHandlers.gibbousDebug.postMessage({ why: 'error', message: String(e.message) }));
    addEventListener('unhandledrejection', e => webkit.messageHandlers.gibbousDebug.postMessage({ why: 'rejection', message: String(e.reason) })); })()
  """
  /// Debug builds: a script dropped into the app's Documents/debug.js (from the Mac: `simctl get_app_container … data`)
  /// runs in the page and its result is logged. Lets the simulator checks drive the page without taps or URL prompts.
  private var debugTimer: Timer?
  private func watchDebugScripts() {
    let f = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("debug.js")
    debugTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      guard let js = try? String(contentsOf: f, encoding: .utf8) else { return }
      try? FileManager.default.removeItem(at: f)
      self?.debugEval(js)
    }
  }
  func debugEval(_ js: String) {
    web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
      switch r {
      case .success(let v): log.notice("debug eval → \(String(describing: v), privacy: .public)")
      case .failure(let e): log.error("debug eval failed: \(e.localizedDescription, privacy: .public)")
      }
    }
  }
  #endif

  // ── page → native ────────────────────────────────────────────────────
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    // Only the Gibbous server's own pages may drive the shell.
    guard m.frameInfo.isMainFrame, Server.isSameOrigin(m.frameInfo.request.url ?? web.url, Server.origin) else { return }
    let d = m.body as? [String: Any] ?? [:]
    switch m.name {
    case "gibbousNotify": notify(d)
    case "gibbousBadge": setBadge((d["count"] as? Int) ?? (m.body as? Int) ?? 0)
    case "gibbousHaptic": haptic(d["style"] as? String ?? "light")
    case "gibbousShare": share(d)
    case "gibbousOpen": if let s = d["url"] as? String, let u = URL(string: s, relativeTo: web.url)?.absoluteURL { openExternal(u) }
    case "gibbousPush": registerPush()
    case "gibbousRoute": if let r = d["route"] as? String, Server.isRoute(r) { Server.route = r }
    case "gibbousServer": RootViewController.shared?.showConnect()
    case "gibbousDebug": log.notice("page \(String(describing: d), privacy: .public)")
    default: break
    }
  }

  private func notify(_ d: [String: Any]) {
    // In the foreground the page shows its own toast; the shell only speaks for a backgrounded app.
    guard UIApplication.shared.applicationState != .active else { log.notice("notify skipped: app is active"); return }
    // With APNs registered the server pushes the same notification; posting it locally too would show it twice.
    guard !UIApplication.shared.isRegisteredForRemoteNotifications else { log.notice("notify skipped: APNs delivers it"); return }
    let content = UNMutableNotificationContent()
    content.title = d["title"] as? String ?? "Gibbous"
    content.body = d["body"] as? String ?? ""
    content.sound = .default
    content.userInfo = ["url": d["url"] as? String ?? ""]
    if let tag = d["tag"] as? String, !tag.isEmpty { content.threadIdentifier = tag }
    let id = (d["tag"] as? String).map { "\($0)-\(UUID().uuidString)" } ?? UUID().uuidString
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { e in
      if let e { log.error("notify failed: \(e.localizedDescription, privacy: .public)") } else { log.notice("notification posted") }
    }
  }

  private func setBadge(_ n: Int) {
    UNUserNotificationCenter.current().setBadgeCount(max(0, n)) { e in if let e { log.error("badge failed: \(e.localizedDescription, privacy: .public)") } }
  }

  private func haptic(_ style: String) {
    switch style {
    case "selection": UISelectionFeedbackGenerator().selectionChanged()
    case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
    case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
    case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
    default:
      let s: UIImpactFeedbackGenerator.FeedbackStyle = ["medium": .medium, "heavy": .heavy, "soft": .soft, "rigid": .rigid][style] ?? .light
      UIImpactFeedbackGenerator(style: s).impactOccurred()
    }
  }

  private func registerPush() {
    #if DEBUG
    let env = "sandbox"
    #else
    let env = "production"
    #endif
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] ok, e in
      DispatchQueue.main.async {
        guard let self else { return }
        guard ok else {
          self.send(["type": "pushError", "message": e?.localizedDescription ?? "Notifications are turned off for Gibbous in iOS Settings → Notifications."])
          return
        }
        let app = UIApplication.shared.delegate as? AppDelegate
        app?.onPushToken = { [weak self] r in
          DispatchQueue.main.async {
            switch r {
            case .success(let t): self?.send(["type": "pushToken", "token": t, "env": env])
            case .failure(let e): self?.send(["type": "pushError", "message": e.localizedDescription])
            }
          }
        }
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  // ── share / open ─────────────────────────────────────────────────────
  private func share(_ d: [String: Any]) {
    let text = d["text"] as? String, title = d["title"] as? String
    if let s = d["url"] as? String, let u = URL(string: s, relativeTo: web.url)?.absoluteURL, Server.isSameOrigin(u, Server.origin) {
      downloadAndShare(u, filename: d["filename"] as? String)
      return
    }
    var items: [Any] = []
    if let text, !text.isEmpty { items.append(text) }
    if let s = d["url"] as? String, let u = URL(string: s) { items.append(u) }
    if items.isEmpty, let title { items.append(title) }
    guard !items.isEmpty else { return }
    presentShare(items, cleanup: nil)
  }

  /// A server file (/api/media?path=…): fetched with the web view's sign-in cookie, saved under its own name, shared.
  private func downloadAndShare(_ u: URL, filename: String?) {
    spinner.startAnimating()
    web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
      let host = u.host?.lowercased() ?? ""
      let mine = cookies.filter { let dom = $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")); return host == dom || host.hasSuffix("." + dom) }
      var req = URLRequest(url: u)
      req.httpShouldHandleCookies = false
      HTTPCookie.requestHeaderFields(with: mine).forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
      URLSession.shared.downloadTask(with: req) { tmp, resp, err in
        var out: URL?
        var failure = err?.localizedDescription
        if let tmp, let http = resp as? HTTPURLResponse {
          if http.statusCode == 200 {
            let name = Self.safeName(filename ?? http.suggestedFilename ?? u.lastPathComponent)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)")
            do {
              try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
              let dest = dir.appendingPathComponent(name)
              try FileManager.default.moveItem(at: tmp, to: dest)
              out = dest
            } catch { failure = error.localizedDescription }
          } else { failure = "The server answered \(http.statusCode)." }
        }
        DispatchQueue.main.async {
          self.spinner.stopAnimating()
          if let out {
            log.notice("share sheet for \(out.lastPathComponent, privacy: .public)")
            self.presentShare([out]) { try? FileManager.default.removeItem(at: out.deletingLastPathComponent()) }
          } else {
            log.error("share download failed: \(failure ?? "?", privacy: .public)")
            let a = UIAlertController(title: "Couldn't get that file", message: failure, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            self.present(a, animated: true)
          }
        }
      }.resume()
    }
  }
  private static func safeName(_ n: String) -> String {
    let s = n.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespaces)
    return s.isEmpty || s == "." || s == ".." ? "file" : s
  }
  private func presentShare(_ items: [Any], cleanup: (() -> Void)?) {
    let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
    vc.popoverPresentationController?.sourceView = view
    vc.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
    vc.completionWithItemsHandler = { _, _, _, _ in cleanup?() }
    topPresenter().present(vc, animated: true)
  }
  private func topPresenter() -> UIViewController { var v: UIViewController = self; while let p = v.presentedViewController { v = p }; return v }

  func openExternal(_ u: URL) {
    if let s = u.scheme?.lowercased(), s == "http" || s == "https" {
      let sf = SFSafariViewController(url: u)
      sf.preferredControlTintColor = Theme.tide
      sf.preferredBarTintColor = Theme.bg
      sf.dismissButtonStyle = .close
      topPresenter().present(sf, animated: true)
    } else {
      UIApplication.shared.open(u)
    }
  }

  // ── navigation policy ────────────────────────────────────────────────
  private static let files: Set<String> = ["/api/media", "/api/image"]

  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let u = a.request.url, let s = u.scheme?.lowercased() else { return decisionHandler(.allow) }
    if ["about", "blob", "data"].contains(s) { return decisionHandler(.allow) }
    let main = a.targetFrame?.isMainFrame ?? true
    if s == "http" || s == "https" {
      if Server.isSameOrigin(u, Server.origin) {
        // A file opened as a page would replace the app with no way back: hand it to the share sheet instead.
        if main, Self.files.contains(u.path) { downloadAndShare(u, filename: nil); return decisionHandler(.cancel) }
        return decisionHandler(.allow)
      }
      if !main { return decisionHandler(.allow) }  // embeds (video players, previews) inside the page
      openExternal(u)
      return decisionHandler(.cancel)
    }
    // mailto:, tel:, vscode://, …
    UIApplication.shared.open(u)
    decisionHandler(.cancel)
  }

  func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    guard r.isForMainFrame, let http = r.response as? HTTPURLResponse else { return decisionHandler(.allow) }
    if http.statusCode == 401 {
      // /login?token=… with a token the server no longer accepts (rotated, or a different server).
      decisionHandler(.cancel)
      RootViewController.shared?.showConnect(message: "That sign-in link wasn't accepted. Scan the current code in Settings → Devices on your Mac.")
      return
    }
    if http.statusCode == 421 {
      decisionHandler(.cancel)
      RootViewController.shared?.showConnect(message: "The server doesn't answer to \(http.url?.host ?? "that address"). Use the sign-in link from Settings → Devices.")
      return
    }
    let attachment = (http.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment")
    if (attachment || !r.canShowMIMEType), let u = http.url, Server.isSameOrigin(u, Server.origin) {
      decisionHandler(.cancel)
      downloadAndShare(u, filename: http.suggestedFilename)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
    hideUnreachable()
    guard Server.isSameOrigin(w.url, Server.origin) else { hideSplash(); return }
    // The page itself renders its own sign-in form when the cookie is missing or expired; in the app that's the
    // native connect screen instead. Any /api/ route answers 401 then (server/main.ts).
    w.callAsyncJavaScript("const r = await fetch('/api/image', { cache: 'no-store', credentials: 'same-origin' }); return r.status", arguments: [:], in: nil, in: .page) { [weak self] r in
      guard let self else { return }
      if case .success(let v) = r, (v as? Int) == 401 || (v as? NSNumber)?.intValue == 401 {
        log.notice("signed out: back to the connect screen")
        self.pageReady = false
        RootViewController.shared?.showConnect(message: "You're signed out. Scan the sign-in code again to continue.")
        return
      }
      self.pageReady = true
      self.hideSplash()
    }
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
    let err = e as NSError
    log.notice("provisional navigation failed: \(err.domain, privacy: .public) \(err.code)")
    // Cancelled loads (our own policy decisions, a new load replacing this one) aren't failures.
    guard err.domain == NSURLErrorDomain, err.code != NSURLErrorCancelled else { unreachable.setBusy(false); return }
    showUnreachable(err)
  }
  func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) {
    let err = e as NSError
    if err.domain == NSURLErrorDomain, err.code != NSURLErrorCancelled, !pageReady { showUnreachable(err) }
  }

  // iOS kills a backgrounded web content process to save memory; without this the app comes back blank.
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    log.notice("web content process terminated: reloading")
    pageReady = false
    if let o = Server.origin { load(Server.homeURL(o)) }
  }

  // target=_blank / window.open
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url {
      if Server.isSameOrigin(u, Server.origin) { if Self.files.contains(u.path) { downloadAndShare(u, filename: nil) } else { w.load(URLRequest(url: u)) } }
      else { openExternal(u) }
    }
    return nil
  }

  // ── JS dialogs (Gibbous uses confirm/prompt) ─────────────────────────
  private func dialogAllowed() -> Bool { view.window != nil && UIApplication.shared.applicationState == .active }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    guard dialogAllowed() else { return completionHandler() }
    let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    topPresenter().present(a, animated: true)
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    guard dialogAllowed() else { return completionHandler(false) }
    let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    topPresenter().present(a, animated: true)
  }
  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    guard dialogAllowed() else { return completionHandler(nil) }
    let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
    a.addTextField { $0.text = d }
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
    topPresenter().present(a, animated: true)
  }
}
