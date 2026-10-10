// Gibbous for iPhone: a thin native shell around the Gibbous web app served by the user's Mac.
// Contract with the page: see ios/README.md (window.__gibbousShell, webkit.messageHandlers.gibbous*, window.gibbousNative).
import UIKit
import UserNotifications
import os

let log = Logger(subsystem: "dev.gibbous.ios", category: "shell")

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  /// Remote-push registration answers arrive here; the web view controller that asked forwards them to the page.
  var onPushToken: ((Result<String, Error>) -> Void)?

  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    // Already allowed before: refresh the token every launch (APNs may rotate it); the page re-registers it.
    UNUserNotificationCenter.current().getNotificationSettings { s in
      if s.authorizationStatus == .authorized || s.authorizationStatus == .provisional {
        DispatchQueue.main.async { app.registerForRemoteNotifications() }
      }
    }
    return true
  }

  func application(_ app: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    UISceneConfiguration(name: "Default", sessionRole: s.role)
  }

  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    log.notice("push token received (\(hex.count / 2) bytes)")
    lastPushToken = hex
    onPushToken?(.success(hex))
  }
  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError e: Error) {
    log.error("push registration failed: \(e.localizedDescription, privacy: .public)")
    onPushToken?(.failure(e))
  }
  var lastPushToken: String?

  // A notification arriving while Gibbous is open: the page already shows its own in-app toast.
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([])
  }
  // Tapped (local from gibbousNotify, or an APNs push whose payload carries `url`).
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let url = r.notification.request.content.userInfo["url"] as? String ?? ""
    log.notice("notification tapped, url \(url, privacy: .public)")
    DispatchQueue.main.async { RootViewController.shared?.openFromNotification(url) }
    done()
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo s: UISceneSession, options o: UIScene.ConnectionOptions) {
    guard let ws = scene as? UIWindowScene else { return }
    let w = UIWindow(windowScene: ws)
    w.backgroundColor = Theme.bg
    w.overrideUserInterfaceStyle = .dark
    w.tintColor = Theme.tide
    let root = RootViewController()
    w.rootViewController = root
    window = w
    w.makeKeyAndVisible()
    if let u = o.urlContexts.first?.url { root.handle(url: u) }
    // Cold launch from a notification tap: the delegate fires too, but only once the page is loading.
    if let r = o.notificationResponse, let url = r.notification.request.content.userInfo["url"] as? String { root.openFromNotification(url) }
  }

  func scene(_ scene: UIScene, openURLContexts c: Set<UIOpenURLContext>) {
    if let u = c.first?.url { RootViewController.shared?.handle(url: u) }
  }

  // Back from the background: the page reconnects its socket and refetches (gibbousNative {type:'resume'}).
  func sceneWillEnterForeground(_ scene: UIScene) { RootViewController.shared?.resume() }
}
