// Gibbous for Android: a thin native shell around the Gibbous web app served by the user's computer.
// Contract with the page: android/README.md (window.__gibbousShell, window.gibbousAndroid, window.gibbousNative).
package dev.gibbous.android

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

class MainActivity : ComponentActivity() {
  private lateinit var root: FrameLayout
  private lateinit var shell: WebShell
  private var splashUntil = 0L
  private var painted = false

  override fun onCreate(savedInstanceState: Bundle?) {
    val splash = installSplashScreen()
    super.onCreate(savedInstanceState)
    // The launch icon stays until the page has painted (capped), so cold start is one continuous dark screen.
    splashUntil = SystemClock.uptimeMillis() + 10_000
    splash.setKeepOnScreenCondition { !painted && SystemClock.uptimeMillis() < splashUntil }
    enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
    root = FrameLayout(this).apply { setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.bg)) }
    setContentView(root)
    shell = WebShell(this, root)

    val link = if (BuildConfig.DEBUG) debugConnect(intent) else null
    val o = Server.origin
    when {
      link != null -> shell.load(link.login)
      o != null -> shell.load(Server.homeUrl(o))
      else -> painted = true
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (BuildConfig.DEBUG) debugConnect(intent)?.let { shell.load(it.login) }
  }

  /** Emulator checks: `am start … --es GibbousConnect <sign-in link>` signs in without the camera. */
  private fun debugConnect(i: Intent?): SignIn? {
    val raw = i?.getStringExtra("GibbousConnect") ?: return null
    i.removeExtra("GibbousConnect")
    val link = Links.parseLink(raw) ?: return null
    Server.origin = link.origin
    return link
  }

  fun pagePainted() { painted = true }

  override fun onDestroy() {
    shell.destroy()
    super.onDestroy()
  }
}
