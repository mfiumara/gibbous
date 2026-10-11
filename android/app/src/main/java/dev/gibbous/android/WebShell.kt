// The web app, full screen. Everything here is the native half of the shell contract (android/README.md).
package dev.gibbous.android

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** The live shell, for app-level events that arrive outside the activity (FCM token rotation). */
object Shell {
  @Volatile var live: WebShell? = null
}

@SuppressLint("SetJavaScriptEnabled")
class WebShell(private val activity: MainActivity, private val host: FrameLayout) {
  lateinit var web: WebView
    private set

  /** The main frame finished loading a signed-in page: events can go to window.gibbousNative. */
  var pageReady = false
    private set

  private var configuredOrigin: String? = null
  private var startScript: ScriptHandler? = null
  private val docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
  private val listenerSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

  init {
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    CookieManager.getInstance().setAcceptCookie(true)
    web = makeWebView()
    host.addView(web, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    Shell.live = this
  }

  private fun makeWebView(): WebView {
    val w = WebView(activity)
    val bg = ContextCompat.getColor(activity, R.color.bg)
    w.setBackgroundColor(bg)  // no white flash before the page paints its own #16181d
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
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        try { WebViewCompat.removeWebMessageListener(web, "gibbousAndroid") } catch (_: Exception) {}
      }
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
      web.post { if (Links.isSameOrigin(web.url, Server.origin)) receive(data) }
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
    pageReady = false
    logi("load ${Links.path(url)}")
    web.loadUrl(url)
  }

  private inner class Client : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      if (!docStartSupported && Links.isSameOrigin(url, Server.origin)) view.evaluateJavascript(startScripts(), null)
    }

    override fun onPageFinished(view: WebView, url: String) {
      CookieManager.getInstance().flush()
      if (Links.isSameOrigin(url, Server.origin)) pageReady = true
      activity.pagePainted()
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
  }

  fun destroy() {
    if (Shell.live === this) Shell.live = null
    web.destroy()
  }

  companion object {
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
