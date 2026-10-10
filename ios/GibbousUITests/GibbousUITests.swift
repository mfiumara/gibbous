// Drives the shell in the simulator: taps into the composer so the software keyboard opens. The app itself logs the
// layout numbers (innerHeight, composer bottom) to os_log in Debug builds; scripts read them with `log show`.
import XCTest

final class GibbousUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  /// Assumes the app is signed in (gibbous://connect?link=… once) and restores a thread route.
  func testKeyboardShrinksPage() throws {
    let app = XCUIApplication()
    app.launch()
    let composer = app.webViews.textViews["Message"].firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 20), "composer textarea not found")
    sleep(1)
    let before = app.screenshot()
    add(attachment("before-keyboard", before))
    composer.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "software keyboard did not appear")
    // A fresh simulator shows the swipe-typing tip over the keys once.
    let tip = app.keyboards.buttons["Continue"]
    if tip.waitForExistence(timeout: 2) { tip.tap() }
    sleep(2)  // keyboard animation + the page's resize → debug log
    add(attachment("keyboard-open", XCUIScreen.main.screenshot()))
    // Leave the keyboard up for an external `simctl io screenshot`.
    sleep(UInt32(ProcessInfo.processInfo.environment["HOLD"] ?? "0") ?? 0)
  }

  /// Notification permission + a notification tap. The driving script posts gibbousPush, then (with the app in the
  /// background) a gibbousNotify or `simctl push` whose title is NOTE_TITLE; the test allows, goes home, taps the banner.
  func testNotificationTapOpensApp() throws {
    let title = ProcessInfo.processInfo.environment["NOTE_TITLE"] ?? "Shell test"
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let allow = springboard.alerts.buttons["Allow"]
    if allow.waitForExistence(timeout: 8) { allow.tap() }
    sleep(3)
    XCUIDevice.shared.press(.home)
    let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", title)).firstMatch
    XCTAssertTrue(banner.waitForExistence(timeout: 40), "no notification banner")
    add(attachment("banner", springboard.screenshot()))
    banner.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tap didn't open the app")
    sleep(3)
    add(attachment("after-tap", app.screenshot()))
  }

  /// First run: the connect screen's paste flow. LINK (a real sign-in link) comes from the driving script's env.
  func testPasteSignInLink() throws {
    let app = XCUIApplication()
    app.launch()
    let paste = app.buttons["paste-link"]
    XCTAssertTrue(paste.waitForExistence(timeout: 10), "connect screen not shown")
    add(attachment("connect", app.screenshot()))
    paste.tap()
    let field = app.secureTextFields["link-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("https://example.com/not-a-link")
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "isn't a Gibbous sign-in link")).firstMatch.waitForExistence(timeout: 5))
    sleep(1)
    XCTAssertTrue(app.buttons["connect-button"].isHittable, "Connect button hidden behind the keyboard")
    add(attachment("paste-error", XCUIScreen.main.screenshot()))
    guard let link = ProcessInfo.processInfo.environment["LINK"], !link.isEmpty else { return }
    field.tap()
    // Typed in small chunks: long fast typeText into a secure field drops characters.
    var rest = Substring(link)
    while !rest.isEmpty { field.typeText(String(rest.prefix(6))); rest = rest.dropFirst(6) }
    app.buttons["connect-button"].tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15), "web view not shown after connecting")
    sleep(4)
    add(attachment("connected", app.screenshot()))
  }

  private func attachment(_ name: String, _ s: XCUIScreenshot) -> XCTAttachment {
    let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; return a
  }
}
