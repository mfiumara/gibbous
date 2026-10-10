// What the shell remembers: the server origin and the last route. Never the token: signing in is one load of the
// server's /login?token=… link, which sets an HttpOnly cookie in WKWebsiteDataStore.default().
import UIKit

enum Theme {
  static let bg = UIColor(red: 0x16 / 255, green: 0x18 / 255, blue: 0x1d / 255, alpha: 1)
  static let text = UIColor(red: 0xe8 / 255, green: 0xe5 / 255, blue: 0xdc / 255, alpha: 1)
  static let dust = UIColor(red: 0xe8 / 255, green: 0xe5 / 255, blue: 0xdc / 255, alpha: 0.6)
  static let tide = UIColor(red: 0x8f / 255, green: 0xb2 / 255, blue: 0xe3 / 255, alpha: 1)
  static let well = UIColor(white: 1, alpha: 0.06)
  static let oxide = UIColor(red: 0xe0 / 255, green: 0x8a / 255, blue: 0x6f / 255, alpha: 1)
}

enum Server {
  static let defaults = UserDefaults.standard

  /// `https://host:port` of the Gibbous server, or nil before the first sign-in.
  static var origin: URL? {
    get { defaults.string(forKey: "server").flatMap(URL.init(string:)) }
    set { defaults.set(newValue?.absoluteString, forKey: "server") }
  }

  /// Last `location.hash` the page reported (gibbousRoute), restored on cold launch.
  static var route: String {
    get { let r = defaults.string(forKey: "route") ?? ""; return isRoute(r) ? r : "" }
    set { if newValue.isEmpty || isRoute(newValue) { defaults.set(newValue, forKey: "route") } }
  }

  /// Same shape the server's /login?next= accepts (server/main.ts), so nothing odd ends up in a URL.
  static func isRoute(_ h: String) -> Bool { h.range(of: #"^#/[\w/?=&%.~-]*$"#, options: .regularExpression) != nil }

  /// Where a cold launch goes: `<origin>/#<route>`.
  static func homeURL(_ origin: URL) -> URL { URL(string: origin.absoluteString + "/" + route) ?? origin }

  /// http is only for a server on this device/LAN while developing; everything else must be https (Tailscale).
  static func isDevHost(_ host: String) -> Bool {
    let h = host.lowercased()
    return h == "127.0.0.1" || h == "localhost" || h == "::1" || h.hasSuffix(".local")
  }

  /// A sign-in link (`https://host:port/login?token=…`, as in the Settings → Devices QR code), or the same link
  /// wrapped in `gibbous://connect?link=<urlencoded>`. Returns the login URL to load and the origin to remember.
  static func parseLink(_ raw: String) -> (login: URL, origin: URL)? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var c = URLComponents(string: s) else { return nil }
    if c.scheme?.lowercased() == "gibbous", let inner = c.queryItems?.first(where: { $0.name == "link" })?.value {
      return parseLink(inner)
    }
    guard let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty,
          scheme == "https" || (scheme == "http" && isDevHost(host)),
          c.path == "/login",
          let token = c.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty
    else { return nil }
    c.scheme = scheme
    c.fragment = nil
    var o = URLComponents()
    o.scheme = scheme; o.host = host; o.port = c.port
    guard let login = c.url, let origin = o.url else { return nil }
    return (login, origin)
  }

  /// Same scheme, host and port as the server: the page's own navigations and files.
  static func isSameOrigin(_ u: URL?, _ origin: URL?) -> Bool {
    guard let u, let origin else { return false }
    func port(_ x: URL) -> Int { x.port ?? (x.scheme == "https" ? 443 : 80) }
    return u.scheme?.lowercased() == origin.scheme?.lowercased() && u.host?.lowercased() == origin.host?.lowercased() && port(u) == port(origin)
  }
}

extension UIButton {
  /// The app's two button styles: tide-filled primary and a quiet well.
  static func gibbous(_ title: String, primary: Bool, image: String? = nil) -> UIButton {
    var c = primary ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
    c.title = title
    c.cornerStyle = .large
    c.baseBackgroundColor = primary ? Theme.tide : Theme.well
    c.baseForegroundColor = primary ? Theme.bg : Theme.text
    c.buttonSize = .large
    if let image { c.image = UIImage(systemName: image); c.imagePadding = 8 }
    c.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
      var a = a; a.font = .systemFont(ofSize: 16, weight: .semibold); return a
    }
    let b = UIButton(configuration: c)
    b.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    return b
  }
}

extension UILabel {
  static func gibbous(_ text: String, size: CGFloat, weight: UIFont.Weight = .regular, color: UIColor = Theme.text) -> UILabel {
    let l = UILabel()
    l.text = text; l.font = .systemFont(ofSize: size, weight: weight); l.textColor = color
    l.numberOfLines = 0; l.textAlignment = .center; l.adjustsFontForContentSizeCategory = true
    return l
  }
}
