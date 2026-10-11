// Server files (gibbousShare urls, /api/media and /api/image opened as pages, attachment downloads): fetched with the
// WebView's sign-in cookie, then handed to the share sheet (FileProvider) or saved to Downloads.
package dev.gibbous.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

object Files {
  private val io = Executors.newSingleThreadExecutor()

  class Fetched(val file: File, val mime: String)

  /** GET with the WebView's cookies into cacheDir/share/<uuid>/<name>. Calls back on the main thread. */
  fun fetch(a: Activity, url: String, filename: String?, done: (Fetched?, String?) -> Unit) {
    val cookie = CookieManager.getInstance().getCookie(url)
    io.execute {
      var out: Fetched? = null
      var failure: String? = null
      try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000; c.readTimeout = 60_000
        c.instanceFollowRedirects = false // Never forward the sign-in cookie across a redirect.
        if (cookie != null) c.setRequestProperty("Cookie", cookie)
        val code = c.responseCode
        if (code == 200) {
          val name = Links.safeName(filename?.takeIf { it.isNotBlank() } ?: Links.dispositionName(c.getHeaderField("Content-Disposition")) ?: Links.fileName(url))
          val mime = c.contentType?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() && it != "application/octet-stream" } ?: guessMime(name)
          // Old share folders go first: the share sheet gives no reliable "done" callback to clean up after.
          val root = File(a.cacheDir, "share")
          root.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3_600_000) it.deleteRecursively() }
          val dir = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
          val f = File(dir, name)
          c.inputStream.use { i -> f.outputStream().use { o -> i.copyTo(o) } }
          out = Fetched(f, mime)
        } else failure = "The server answered $code."
        c.disconnect()
      } catch (e: Exception) { failure = e.message ?: e.javaClass.simpleName }
      a.runOnUiThread { done(out, failure) }
    }
  }

  fun guessMime(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

  /** The system share sheet for a downloaded file. */
  fun shareFile(a: Activity, f: Fetched) {
    val uri = FileProvider.getUriForFile(a, "${a.packageName}.files", f.file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = f.mime
      putExtra(Intent.EXTRA_STREAM, uri)
      clipData = ClipData.newRawUri(f.file.name, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    logi("share sheet for ${f.file.name} (${f.mime})")
    a.startActivity(Intent.createChooser(send, f.file.name))
  }

  /** Text / link share. */
  fun shareText(a: Activity, text: String, title: String?) {
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_TEXT, text)
      if (!title.isNullOrEmpty()) putExtra(Intent.EXTRA_SUBJECT, title)
    }
    a.startActivity(Intent.createChooser(send, title))
  }

  /** A server file the page asked to download: into Downloads, with a toast. */
  fun download(a: Activity, url: String, filename: String?) {
    toast(a, a.getString(R.string.downloading))
    fetch(a, url, filename) { f, err ->
      if (f == null) { toast(a, a.getString(R.string.download_failed, err ?: "")); return@fetch }
      io.execute {
        val saved = runCatching { saveToDownloads(a, f) }.onFailure { loge("download save failed", it) }.getOrNull()
        a.runOnUiThread { toast(a, if (saved != null) a.getString(R.string.downloaded, saved) else a.getString(R.string.download_failed, "")) }
      }
    }
  }

  /** MediaStore Downloads on Android 10+, the app's own Downloads folder below (no storage permission either way). */
  private fun saveToDownloads(a: Activity, f: Fetched): String {
    if (Build.VERSION.SDK_INT >= 29) {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, f.file.name)
        put(MediaStore.Downloads.MIME_TYPE, f.mime)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val r = a.contentResolver
      val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no Downloads")
      r.openOutputStream(uri)!!.use { o -> f.file.inputStream().use { it.copyTo(o) } }
      r.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
      f.file.parentFile?.deleteRecursively()
      return "Downloads/${f.file.name}"
    }
    val dir = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: a.filesDir
    val dest = File(dir, f.file.name)
    f.file.copyTo(dest, overwrite = true)
    f.file.parentFile?.deleteRecursively()
    return dest.absolutePath
  }

  fun toast(a: Activity, s: String) = Toast.makeText(a, s, Toast.LENGTH_SHORT).show()

  /** http(s) → a Custom Tab in the night colours; anything else → whatever app handles it. */
  fun openExternal(a: Activity, url: String) {
    val uri = Uri.parse(url)
    if (Links.isHttp(url)) {
      val bg = ContextCompat.getColor(a, R.color.bg)
      val scheme = CustomTabColorSchemeParams.Builder().setToolbarColor(bg).setNavigationBarColor(bg).build()
      val tab = CustomTabsIntent.Builder()
        .setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
        .setDefaultColorSchemeParams(scheme)
        .setColorSchemeParams(CustomTabsIntent.COLOR_SCHEME_DARK, scheme)
        .setShowTitle(true)
        .build()
      try { tab.launchUrl(a, uri); logi("custom tab ${uri.host}"); return } catch (_: ActivityNotFoundException) {}
    }
    try {
      a.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
      logi("ACTION_VIEW ${uri.scheme}")
    } catch (e: Exception) {
      loge("nothing opens ${uri.scheme}: ${e.javaClass.simpleName}")
      toast(a, a.getString(R.string.no_app_for_link))
    }
  }
}
