// The web app, full screen. Everything here is the native half of the shell contract (android/README.md), the
// counterpart of ios/Gibbous/WebViewController.swift.
package dev.gibbous.android

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Message
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
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
  fun pageReady(s: WebShell) { Push.deliver(s) }
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
    // Edge to edge: the page sees zero safe-area insets. The content is padded by the bars and cutout, and at the
    // bottom by max(navigation bar, keyboard), so the WebView (and the page's innerHeight) shrinks with the IME.
    ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
      if (BuildConfig.DEBUG) logi("insets bars=$bars ime=${ime.bottom}")
      WindowInsetsCompat.CONSUMED
    }
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
    w.webChromeClient = Chrome()
    // Content-Disposition: attachment (and anything the WebView can't show): saved with the sign-in cookie.
    w.setDownloadListener { url, _, cd, _, _ ->
      if (Links.isSameOrigin(url, Server.origin)) Files.download(activity, url, Links.dispositionName(cd))
      else Files.openExternal(activity, url)
    }
    // Fail closed on outdated WebViews: JavascriptInterface cannot verify the calling frame.
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
      "gibbousNotify" -> if (Server.pushToken == null) Notifications.notify(activity, body)
      "gibbousBadge" -> Server.badge = body.optInt("count", 0)
      "gibbousRoute" -> { Server.route = body.optString("route"); logi("route remembered") }
      "gibbousOpen" -> body.optString("url").takeIf { it.isNotBlank() }?.let { Files.openExternal(activity, it) }
      "gibbousShare" -> {
        val raw = body.optString("url")
        val url = runCatching { URI(Server.origin + "/").resolve(raw).toString() }.getOrDefault(raw)
        if (raw.isNotBlank() && Links.isSameOrigin(url, Server.origin)) shareUrl(url, body.optString("filename").takeIf { it.isNotBlank() })
        else Files.shareText(activity, listOf(body.optString("text"), raw).filter { it.isNotBlank() }.joinToString("\n"), body.optString("title"))
      }
      "gibbousHaptic" -> Haptics.perform(web, body.optString("style"))
      "gibbousPush" -> activity.requestPush()
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

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val url = request.url.toString()
      val scheme = request.url.scheme?.lowercase() ?: return false
      if (scheme == "about" || scheme == "blob" || scheme == "data") return false
      if (scheme == "http" || scheme == "https") {
        if (Links.isSameOrigin(url, Server.origin)) {
          // A file opened as a page would replace the app with no way back: share it instead.
          if (request.isForMainFrame && Links.path(url) in Links.FILE_PATHS) { shareUrl(url, null); return true }
          return false
        }
        if (!request.isForMainFrame) return false  // embeds (video players, previews) inside the page
        Files.openExternal(activity, url)
        return true
      }
      // mailto:, tel:, vscode://, …
      Files.openExternal(activity, url)
      return true
    }

    // The renderer was killed (memory) or crashed: a fresh WebView at the same route instead of a dead app.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      logi("render process gone (crash=${detail.didCrash()}): recreating the web view")
      recreateWebView()
      return true
    }
  }

  private fun recreateWebView() {
    val old = web
    container.removeView(old)
    old.destroy()
    startScript = null
    configuredOrigin = null
    pageReady = false
    web = makeWebView()
    container.addView(web, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    Server.origin?.let { load(Server.homeUrl(it)) }
  }

  /** A server file: downloaded with the sign-in cookie, then the share sheet. */
  fun shareUrl(url: String, filename: String?) {
    Files.toast(activity, activity.getString(R.string.preparing_file))
    Files.fetch(activity, url, filename) { f, err ->
      if (f != null) Files.shareFile(activity, f)
      else {
        loge("share download failed: $err")
        dialog().setTitle(R.string.file_failed).setMessage(err).setPositiveButton(android.R.string.ok, null).show()
      }
    }
  }

  private fun dialog() = AlertDialog.Builder(activity, R.style.Gibbous_Dialog)

  // ── chrome: uploads and JS dialogs (Gibbous uses confirm/prompt) ─────────
  private inner class Chrome : WebChromeClient() {
    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
      val intent = params.createIntent()
      if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
      return activity.chooseFiles(intent, callback)
    }

    private fun allowed() = activity.hasWindowFocus() || activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
      if (!allowed()) { result.cancel(); return true }
      dialog().setMessage(message).setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }.setOnCancelListener { result.cancel() }.show()
      return true
    }

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
      if (!allowed()) { result.cancel(); return true }
      dialog().setMessage(message)
        .setNegativeButton(R.string.cancel) { _, _ -> result.cancel() }
        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
        .setOnCancelListener { result.cancel() }.show()
      return true
    }

    override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean {
      if (!allowed()) { result.cancel(); return true }
      val input = EditText(activity).apply { setText(defaultValue ?: ""); setSingleLine() }
      val pad = (20 * activity.resources.displayMetrics.density).toInt()
      val box = FrameLayout(activity).apply { setPadding(pad, pad / 2, pad, 0); addView(input) }
      dialog().setMessage(message).setView(box)
        .setNegativeButton(R.string.cancel) { _, _ -> result.cancel() }
        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(input.text.toString()) }
        .setOnCancelListener { result.cancel() }.show()
      return true
    }

    // setSupportMultipleWindows(false): no new windows are ever created.
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = false
  }

  /** System back: the page's own history first, then leave the app. */
  fun goBack(): Boolean {
    if (!web.canGoBack()) return false
    web.goBack()
    return true
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
