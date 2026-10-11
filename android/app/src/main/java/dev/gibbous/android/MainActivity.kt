// Gibbous for Android: a thin native shell around the Gibbous web app served by the user's computer.
// Contract with the page: android/README.md (window.__gibbousShell, window.gibbousAndroid, window.gibbousNative).
// This activity swaps between the connect screen and the web app, and routes app-level events (deep links,
// notification taps, resume, network changes): the RootViewController + SceneDelegate of the iPhone shell.
package dev.gibbous.android

import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
  private lateinit var root: FrameLayout
  private var shell: WebShell? = null
  private var connect: ConnectScreen? = null
  private var current: View? = null
  private var splashUntil = 0L
  private var painted = false
  private var started = false
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  private val scanner = registerForActivityResult(ScanContract()) { r -> r.contents?.let { connect?.scanned(it) } }

  override fun onCreate(savedInstanceState: Bundle?) {
    val splash = installSplashScreen()
    super.onCreate(savedInstanceState)
    // The launch icon stays until the page has painted (capped), so cold start is one continuous dark screen.
    splashUntil = SystemClock.uptimeMillis() + 10_000
    splash.setKeepOnScreenCondition { !painted && SystemClock.uptimeMillis() < splashUntil }
    enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
    root = FrameLayout(this).apply { setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.bg)) }
    setContentView(root)

    val i = intent
    val o = Server.origin
    when {
      debugConnect(i) -> {}
      deepLink(i) -> {}
      o != null -> showWeb(Server.homeUrl(o))
      else -> showConnect()
    }
    notificationTap(i)
    watchNetwork()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (debugConnect(intent)) return
    if (deepLink(intent)) return
    notificationTap(intent)
  }

  override fun onStart() {
    super.onStart()
    // Back from the background (not the first start): the page reconnects its socket and refetches.
    if (started) shell?.resume()
    started = true
  }

  override fun onDestroy() {
    netCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
    shell?.destroy()
    super.onDestroy()
  }

  fun pagePainted() { painted = true }

  // ── screens ─────────────────────────────────────────────────────────────
  private fun swap(to: View) {
    if (to === current) return
    val old = current
    // Leaving the connect screen (a sign-in from a deep link or the scanner): its keyboard must not stay up.
    if (old != null && old !== shell?.container) WindowCompat.getInsetsController(window, old).hide(WindowInsetsCompat.Type.ime())
    if (to.parent == null) root.addView(to, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    to.visibility = View.VISIBLE
    to.bringToFront()
    current = to
    if (old == null) return
    to.alpha = 0f
    to.animate().alpha(1f).setDuration(220).withEndAction {
      if (old === shell?.container) old.visibility = View.GONE else root.removeView(old)
    }.start()
  }

  fun showWeb(url: String) {
    val s = shell ?: WebShell(this).also { shell = it }
    connect = null
    swap(s.container)
    s.load(url)
  }

  /** The native sign-in screen: first run, the page's gibbousServer, an expired session, or "Change server". */
  fun showConnect(message: String? = null) {
    painted = true
    shell?.pageHidden()
    val c = ConnectScreen(this, message, canCancel = shell != null && Server.origin != null,
      onLink = { connect(it) },
      onCancel = { shell?.let { s -> connect = null; swap(s.container); s.retryIfNeeded() } },
      onScan = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(getString(R.string.scan_prompt)).setBeepEnabled(false).setOrientationLocked(true)) })
    connect = c
    swap(c.view)
  }

  fun connect(link: SignIn) {
    if (!Links.isSameOrigin(link.origin, Server.origin)) Server.route = ""  // a route from another server means nothing here
    Server.origin = link.origin
    // Keep your place when signing in again to the same server: /login?next=#/… redirects there.
    val login = Links.withNext(link.login, Server.route)
    logi("connecting to ${link.origin}")
    showWeb(login)
  }

  // ── intents ─────────────────────────────────────────────────────────────
  /** Emulator checks: `am start … --es GibbousConnect <sign-in link>` signs in without the camera. Debug builds only. */
  private fun debugConnect(i: Intent?): Boolean {
    if (!BuildConfig.DEBUG) return false
    val raw = i?.getStringExtra(EXTRA_DEBUG_CONNECT) ?: return false
    i.removeExtra(EXTRA_DEBUG_CONNECT)
    val link = Links.parseLink(raw) ?: return false
    connect(link)
    return true
  }

  /** gibbous://connect?link=<urlencoded sign-in link>, e.g. from a QR code or another app. */
  private fun deepLink(i: Intent?): Boolean {
    val u = i?.data ?: return false
    if (i.action != Intent.ACTION_VIEW || u.scheme?.lowercase() != "gibbous" || u.host != "connect") return false
    i.data = null
    val link = Links.parseLink(u.toString())
    if (link == null) {
      showConnect(getString(R.string.error_bad_deeplink))
      return true
    }
    if (BuildConfig.DEBUG) { connect(link); return true }
    // Any app or web page can open gibbous:// links: never switch servers without asking.
    if (current == null) Server.origin.let { o -> if (o != null) showWeb(Server.homeUrl(o)) else showConnect() }
    val host = runCatching { java.net.URI(link.origin).host }.getOrNull() ?: "this server"
    AlertDialog.Builder(this, R.style.Gibbous_Dialog)
      .setTitle(getString(R.string.connect_to, host))
      .setMessage(getString(R.string.connect_to_detail, link.origin))
      .setNegativeButton(R.string.cancel, null)
      .setPositiveButton(R.string.connect) { _, _ -> connect(link) }
      .show()
    return true
  }

  /** A tapped notification: its PendingIntent carries the page url (`#/t/…`). */
  private fun notificationTap(i: Intent?) {
    val url = i?.getStringExtra(EXTRA_OPEN_URL) ?: return
    i.removeExtra(EXTRA_OPEN_URL)
    logi("notification tapped, url $url")
    openFromNotification(url)
  }

  private fun openFromNotification(url: String) {
    val route = Links.notificationRoute(url) ?: return
    val s = shell
    val o = Server.origin
    if (s != null && current === s.container) s.openFromNotification(url, route)
    else if (o != null) { Server.route = route; showWeb(Server.homeUrl(o)) }
  }

  // ── network ─────────────────────────────────────────────────────────────
  /** Back online (Wi-Fi joined, Tailscale up): try again right away when the unreachable screen is up. */
  private fun watchNetwork() {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return
    val cb = object : ConnectivityManager.NetworkCallback() {
      private var first = true  // registering reports the current network once: not a change
      override fun onAvailable(network: Network) {
        if (first) { first = false; return }
        root.postDelayed({ shell?.retryIfUnreachable() }, 500)
      }
    }
    runCatching { cm.registerDefaultNetworkCallback(cb); netCallback = cb }
  }

  companion object {
    const val EXTRA_DEBUG_CONNECT = "GibbousConnect"
    const val EXTRA_OPEN_URL = "dev.gibbous.android.OPEN_URL"
  }
}
