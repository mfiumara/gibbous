// The web app, full screen. Everything here is the native half of the shell contract (android/README.md), the
// counterpart of ios/Gibbous/WebViewController.swift.
package dev.gibbous.android

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.button.MaterialButton
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors

/** The live shell, for app-level events that arrive outside the activity (FCM token rotation). */
object Shell {
  @Volatile var live: WebShell? = null

  /** A signed-in page is live: hand it what arrived while none was. */
  fun pageReady(s: WebShell) {}
}

@SuppressLint("SetJavaScriptEnabled")
class WebShell(private val activity: MainActivity) {
  /** The web view plus its overlays; what MainActivity shows. */
  val container = FrameLayout(activity)
  var web: WebView
    private set

  /** The main frame finished loading a signed-in page: events can go to window.gibbousNative. */
  var pageReady = false
    private set

  private val main = Handler(Looper.getMainLooper())
  private val unreachable: View = LayoutInflater.from(activity).inflate(R.layout.unreachable, container, false)
  private val detail: TextView = unreachable.findViewById(R.id.detail)
  private val retryButton: MaterialButton = unreachable.findViewById(R.id.retry)
  private var lastUrl: String? = null
  private var failed = false
  private var configuredOrigin: String? = null
  private var startScript: ScriptHandler? = null
  private val docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
  private val listenerSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
  private val retryTick = object : Runnable {
    // A computer waking up doesn't change this phone's network: keep knocking quietly.
    override fun run() { retryIfUnreachable(); main.postDelayed(this, RETRY_MS) }
  }

  init {
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    CookieManager.getInstance().setAcceptCookie(true)
    container.setBackgroundColor(ContextCompat.getColor(activity, R.color.bg))
    web = makeWebView()
    container.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    container.addView(unreachable)
    retryButton.setOnClickListener { retry() }
    unreachable.findViewById<View>(R.id.change).setOnClickListener { activity.showConnect() }
    Shell.live = this
  }

  private fun makeWebView(): WebView {
    val w = WebView(activity)
    w.setBackgroundColor(ContextCompat.getColor(activity, R.color.bg))  // no white flash before the page paints its own #16181d
    w.overScrollMode = View.OVER_SCROLL_NEVER
    w.isVerticalScrollBarEnabled = false
    w.isHorizontalScrollBarEnabled = false
    val s = w.settings
    s.javaScriptEnabled = true
    s.domStorageEnabled = true
    s.mediaPlaybackRequiresUserGesture = false
    s.setSupportZoom(false)
    s.builtInZoomControls = false
    s.displayZoomControls = false
    s.textZoom = 100  // the page has its own type scale; system font scale must not break its layout
    s.loadWithOverviewMode = false
    s.useWideViewPort = true
    s.setSupportMultipleWindows(false)  // target=_blank / window.open go through shouldOverrideUrlLoading
    s.javaScriptCanOpenWindowsAutomatically = false
    s.allowFileAccess = false
    s.allowContentAccess = false
    s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false)
    CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
    w.webViewClient = Client()
    if (!listenerSupported) w.addJavascriptInterface(LegacyBridge(), "gibbousAndroid")
    return w
  }

  // ── origin-scoped scripts and the message listener ─────────────────────
  /** Registers the document-start script and the gibbousAndroid listener for exactly this server origin. */
  private fun configure(origin: String) {
    if (origin == configuredOrigin) return
    configuredOrigin = origin
    val rules = setOf(origin)
    if (docStartSupported) {
      startScript?.remove()
      startScript = WebViewCompat.addDocumentStartJavaScript(web, startScripts(), rules)
    }
    if (listenerSupported) {
      runCatching { WebViewCompat.removeWebMessageListener(web, "gibbousAndroid") }
      WebViewCompat.addWebMessageListener(web, "gibbousAndroid", rules) { _: WebView, m: WebMessageCompat, source: Uri, isMainFrame: Boolean, _: JavaScriptReplyProxy ->
        // Only the Gibbous server's own top-level page may drive the shell.
        if (!isMainFrame || !Links.isSameOrigin(source.toString(), Server.origin)) return@addWebMessageListener
        receive(m.data ?: return@addWebMessageListener)
      }
    }
  }

  /** Fallback for WebViews without WEB_MESSAGE_LISTENER: same JS API, origin checked against the main frame URL. */
  private inner class LegacyBridge {
    @JavascriptInterface
    fun postMessage(data: String) {
      main.post { if (Links.isSameOrigin(web.url, Server.origin)) receive(data) }
    }
  }

  private fun startScripts(): String {
    val v = Links.jsString(BuildConfig.VERSION_NAME)
    val b = Links.jsString(BuildConfig.VERSION_CODE.toString())
    // <html> may not exist yet at document start: set the dataset as soon as it does.
    val shell = """
      (() => { if (window.__gibbousShell) return; window.__gibbousShell = { platform: 'android', version: $v, build: $b };
        const apply = () => { const d = document.documentElement; if (!d) return false; d.dataset.shell = 'android'; return true; };
        if (!apply()) new MutationObserver((_, o) => { if (apply()) o.disconnect(); }).observe(document, { childList: true }); })();
    """.trimIndent()
    return if (BuildConfig.DEBUG) shell + "\n" + DEBUG_SCRIPT else shell
  }

  // ── page → native ───────────────────────────────────────────────────────
  private fun receive(data: String) {
    val msg = try { JSONObject(data) } catch (_: Exception) { return }
    val name = msg.optString("name")
    val body = msg.optJSONObject("body") ?: JSONObject()
    when (name) {
      "gibbousServer" -> activity.showConnect()
      "gibbousDebug" -> if (BuildConfig.DEBUG) logi("page $body")
      else -> logi("bridge: $name (not implemented yet)")
    }
  }

  /** window.gibbousNative?.(event) */
  fun send(event: Map<String, Any?>) {
    val json = JSONObject(event).toString()
    web.evaluateJavascript("window.gibbousNative?.($json); void 0", null)
  }

  // ── loading ─────────────────────────────────────────────────────────────
  fun load(url: String) {
    val origin = Server.origin ?: return
    configure(origin)
    lastUrl = url
    pageReady = false
    failed = false
    logi("load ${Links.path(url)}")
    web.loadUrl(url)
  }

  /** Retry reloads the app at the last route, never a stale sign-in link. */
  fun retry() {
    val o = Server.origin ?: run { activity.showConnect(); return }
    val last = lastUrl
    val url = if (last != null && Links.path(last) == "/login") last else Server.homeUrl(o)
    setBusy(true)
    load(url)
  }

  fun retryIfUnreachable() { if (unreachable.visibility == View.VISIBLE) retry() }
  fun retryIfNeeded() { if (unreachable.visibility == View.VISIBLE || web.url == null) retry() }

  /** Back from the background. */
  fun resume() {
    if (unreachable.visibility == View.VISIBLE) { retry(); return }
    if (pageReady) send(mapOf("type" to "resume")) else if (web.url == null) retry()
  }

  /** The connect screen covers the page: no events until it loads again. */
  fun pageHidden() { pageReady = false; main.removeCallbacks(retryTick) }

  /** A tapped notification: live page → it navigates itself; otherwise load that route. */
  fun openFromNotification(url: String, route: String) {
    if (pageReady) send(mapOf("type" to "open", "url" to url))
    else Server.origin?.let { Server.route = route; load(Server.homeUrl(it)) }
  }

  private fun showUnreachable(why: Why) {
    pageReady = false
    failed = true
    activity.pagePainted()
    val host = Server.origin?.let { runCatching { URI(it).host }.getOrNull() } ?: "your computer"
    detail.text = when (why) {
      Why.OFFLINE -> activity.getString(R.string.unreachable_offline)
      Why.CLEARTEXT -> activity.getString(R.string.unreachable_https, host)
      Why.CERTIFICATE -> activity.getString(R.string.unreachable_certificate, host)
      Why.DOWN -> activity.getString(R.string.unreachable_down, host)
    }
    setBusy(false)
    if (unreachable.visibility != View.VISIBLE) {
      logi("unreachable: $why")
      unreachable.alpha = 0f
      unreachable.visibility = View.VISIBLE
      unreachable.animate().alpha(1f).setDuration(200).start()
      main.removeCallbacks(retryTick)
      main.postDelayed(retryTick, RETRY_MS)
    }
  }

  private fun hideUnreachable() {
    main.removeCallbacks(retryTick)
    setBusy(false)
    if (unreachable.visibility == View.VISIBLE) unreachable.animate().alpha(0f).setDuration(200).withEndAction { unreachable.visibility = View.GONE; unreachable.alpha = 1f }.start()
  }

  private fun setBusy(busy: Boolean) {
    retryButton.text = activity.getString(if (busy) R.string.connecting else R.string.retry)
    retryButton.isEnabled = !busy
  }

  private fun offline(): Boolean {
    val cm = activity.getSystemService(ConnectivityManager::class.java) ?: return false
    return cm.activeNetwork == null
  }

  /**
   * The page renders its own sign-in form when the cookie is missing or expired; in the app that's the native
   * connect screen instead. Any /api/ route answers 401 then (server/main.ts), so ask with the WebView's cookie.
   */
  private fun checkSignedIn(url: String) {
    val origin = Server.origin ?: return
    val cookie = CookieManager.getInstance().getCookie(origin)
    io.execute {
      val status = try {
        val c = URL("$origin/api/image").openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 10_000
        c.instanceFollowRedirects = false
        c.useCaches = false
        if (cookie != null) c.setRequestProperty("Cookie", cookie)
        c.responseCode.also { c.disconnect() }
      } catch (_: Exception) { -1 }
      main.post {
        if (web.url != url || failed) return@post
        if (status == 401) {
          logi("signed out: back to the connect screen")
          pageReady = false
          activity.showConnect(activity.getString(R.string.error_signed_out))
          return@post
        }
        pageReady = true
        activity.pagePainted()
        Shell.pageReady(this)
      }
    }
  }

  private enum class Why { OFFLINE, CLEARTEXT, CERTIFICATE, DOWN }

  private inner class Client : WebViewClientCompat() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      if (!docStartSupported && Links.isSameOrigin(url, Server.origin)) view.evaluateJavascript(startScripts(), null)
    }

    override fun onPageFinished(view: WebView, url: String) {
      CookieManager.getInstance().flush()  // the sign-in cookie survives a kill right after signing in
      if (failed) return
      hideUnreachable()
      if (Links.isSameOrigin(url, Server.origin)) checkSignedIn(url) else activity.pagePainted()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceErrorCompat) {
      if (!request.isForMainFrame) return
      val code = if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_RESOURCE_ERROR_GET_CODE)) error.errorCode else ERROR_UNKNOWN
      val desc = if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_RESOURCE_ERROR_GET_DESCRIPTION)) error.description.toString() else ""
      logi("main frame failed: $code $desc")
      showUnreachable(when {
        offline() -> Why.OFFLINE
        desc.contains("CLEARTEXT", true) -> Why.CLEARTEXT
        code == ERROR_FAILED_SSL_HANDSHAKE -> Why.CERTIFICATE
        else -> Why.DOWN
      })
    }

    @SuppressLint("WebViewClientOnReceivedSslError")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
      handler.cancel()
      if (error.url == view.url || Links.isSameOrigin(error.url, Server.origin)) showUnreachable(Why.CERTIFICATE)
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
      if (!request.isForMainFrame) return
      val host = request.url.host ?: "that address"
      when (response.statusCode) {
        // /login?token=… with a token the server no longer accepts (rotated, or a different server).
        401 -> {
          pageReady = false; failed = true
          val login = request.url.path == "/login"
          activity.showConnect(activity.getString(if (login) R.string.error_link_rejected else R.string.error_signed_out))
        }
        421 -> { pageReady = false; failed = true; activity.showConnect(activity.getString(R.string.error_wrong_host, host)) }
      }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
  }

  fun destroy() {
    main.removeCallbacks(retryTick)
    if (Shell.live === this) Shell.live = null
    web.destroy()
  }

  companion object {
    private const val RETRY_MS = 10_000L
    private val io = Executors.newCachedThreadPool()

    /** Debug builds post layout facts (innerHeight vs the keyboard, the shell flag) to logcat. */
    private val DEBUG_SCRIPT = """
      (() => { const post = (why) => { try { const d = document.documentElement, vv = window.visualViewport, ta = document.querySelector('textarea[aria-label=Message], textarea[aria-label="First message"]');
          window.gibbousAndroid && gibbousAndroid.postMessage(JSON.stringify({ name: 'gibbousDebug', body: { why, innerHeight, vvHeight: vv && vv.height, scrollY,
            shell: d && d.dataset.shell, hash: location.hash,
            composerBottom: ta ? Math.round(ta.getBoundingClientRect().bottom) : null, focused: document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName) } })); } catch (e) {} };
        window.__gibbousDebugPost = post;
        addEventListener('resize', () => post('resize')); addEventListener('load', () => setTimeout(() => post('load'), 500));
        addEventListener('error', e => window.gibbousAndroid && gibbousAndroid.postMessage(JSON.stringify({ name: 'gibbousDebug', body: { why: 'error', message: String(e.message) } })));
        addEventListener('unhandledrejection', e => window.gibbousAndroid && gibbousAndroid.postMessage(JSON.stringify({ name: 'gibbousDebug', body: { why: 'rejection', message: String(e.reason) } }))); })();
    """.trimIndent()
  }
}
