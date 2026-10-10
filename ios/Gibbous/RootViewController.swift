// Swaps between the connect screen and the web app, and routes app-level events (URLs, notification taps, resume).
import UIKit

final class RootViewController: UIViewController {
  static weak var shared: RootViewController?
  private var web: WebViewController?
  private var current: UIViewController?

  override func viewDidLoad() {
    super.viewDidLoad()
    RootViewController.shared = self
    view.backgroundColor = Theme.bg
    #if DEBUG
    // Simulator checks: `simctl launch … -GibbousConnect <sign-in link>` signs in without the camera or a URL prompt.
    if let l = UserDefaults.standard.string(forKey: "GibbousConnect"), let link = Server.parseLink(l) { connect(link); return }
    #endif
    if let o = Server.origin { showWeb(Server.homeURL(o)) } else { showConnect() }
  }

  override var childForStatusBarStyle: UIViewController? { current }
  override var childForHomeIndicatorAutoHidden: UIViewController? { current }

  private func swap(to vc: UIViewController) {
    guard vc !== current else { return }
    let old = current
    addChild(vc)
    vc.view.frame = view.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(vc.view)
    vc.didMove(toParent: self)
    current = vc
    setNeedsStatusBarAppearanceUpdate()
    guard let old else { return }
    vc.view.alpha = 0
    UIView.animate(withDuration: 0.22, animations: { vc.view.alpha = 1 }) { _ in
      old.willMove(toParent: nil); old.view.removeFromSuperview(); old.removeFromParent()
    }
  }

  func showWeb(_ url: URL) {
    let w = web ?? WebViewController()
    web = w
    swap(to: w)
    w.load(url)
  }

  /// The native sign-in screen: first run, the page's gibbousServer, an expired session, or "Change server".
  func showConnect(message: String? = nil) {
    let c = ConnectViewController(message: message, canCancel: web != nil && Server.origin != nil)
    c.onLink = { [weak self] link in self?.connect(link) }
    c.onCancel = { [weak self] in if let self, let w = self.web { self.swap(to: w); w.retryIfNeeded() } }
    swap(to: c)
  }

  func connect(_ link: (login: URL, origin: URL)) {
    if !Server.isSameOrigin(link.origin, Server.origin) { Server.route = "" }  // a route from another server means nothing here
    Server.origin = link.origin
    // Keep your place when signing in again to the same server: /login?next=#/… redirects there.
    var login = link.login
    let route = Server.route
    if !route.isEmpty, var c = URLComponents(url: login, resolvingAgainstBaseURL: false) {
      // Encoded by hand: URLComponents leaves & and = in values, which would split a route like #/search?q=a&b.
      let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
      let kept = (c.percentEncodedQuery ?? "").split(separator: "&").map(String.init).filter { !$0.hasPrefix("next=") }
      c.percentEncodedQuery = (kept + ["next=" + (route.addingPercentEncoding(withAllowedCharacters: safe) ?? "")]).joined(separator: "&")
      login = c.url ?? login
    }
    log.notice("connecting to \(link.origin.absoluteString, privacy: .public)")
    showWeb(login)
  }

  /// gibbous://connect?link=<urlencoded sign-in link>, e.g. from a QR code or another app.
  func handle(url: URL) {
    guard url.scheme?.lowercased() == "gibbous" else { return }
    guard url.host == "connect" else { return }
    guard let link = Server.parseLink(url.absoluteString) else {
      showConnect(message: "That sign-in link isn't valid. Scan the code in Settings → Devices again.")
      return
    }
    #if DEBUG
    connect(link)
    #else
    // Any app or web page can open gibbous:// links: never switch servers without asking.
    let a = UIAlertController(title: "Connect to \(link.origin.host ?? "this server")?", message: "Gibbous will sign in to the server at \(link.origin.absoluteString).", preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    a.addAction(UIAlertAction(title: "Connect", style: .default) { [weak self] _ in self?.connect(link) })
    (presentedViewController ?? self).present(a, animated: true)
    #endif
  }

  func resume() { web?.resume() }
  func openFromNotification(_ url: String) { web?.openFromNotification(url) }
}
