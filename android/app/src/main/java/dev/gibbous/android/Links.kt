// Pure rules shared by the connect screen, the web view and notifications (port of ios/Gibbous/Server.swift).
// No Android types here, so it's covered by plain JUnit tests (app/src/test).
package dev.gibbous.android

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** A parsed sign-in link: the `/login?token=…` URL to load once, and the origin to remember (`scheme://host[:port]`). */
data class SignIn(val login: String, val origin: String)

object Links {
  private val ROUTE = Regex("""^#/[\w/?=&%.~-]*$""")

  /** Same shape the server's /login?next= accepts (server/main.ts), so nothing odd ends up in a URL. */
  fun isRoute(h: String): Boolean = ROUTE.matches(h)

  /** http is only for a server on this device/LAN while developing; everything else must be https (Tailscale). */
  fun isDevHost(host: String): Boolean {
    val h = host.lowercase().removePrefix("[").removeSuffix("]")
    return h == "127.0.0.1" || h == "localhost" || h == "::1" || h.endsWith(".local")
  }

  /**
   * A sign-in link (`https://host:port/login?token=…`, as in the Settings → Devices QR code), or the same link wrapped
   * in `gibbous://connect?link=<urlencoded>`. Returns null for anything else.
   */
  fun parseLink(raw: String): SignIn? {
    val s = raw.trim()
    val u = try { URI(s) } catch (_: Exception) { return null }
    val scheme = u.scheme?.lowercase() ?: return null
    if (scheme == "gibbous") {
      val inner = query(u.rawQuery)["link"] ?: return null
      return parseLink(inner)
    }
    val host = u.host?.takeIf { it.isNotEmpty() } ?: return null
    if (!(scheme == "https" || (scheme == "http" && isDevHost(host)))) return null
    if (u.rawPath != "/login") return null
    val token = query(u.rawQuery)["token"]
    if (token.isNullOrEmpty()) return null
    val authority = hostPort(host, u.port)
    val login = "$scheme://$authority/login" + (u.rawQuery?.let { "?$it" } ?: "")
    return SignIn(login, "$scheme://$authority")
  }

  private fun hostPort(host: String, port: Int): String {
    val h = host.lowercase().let { if (it.contains(':') && !it.startsWith("[")) "[$it]" else it }
    return if (port >= 0) "$h:$port" else h
  }

  /** First value per name of a raw (percent-encoded) query string. */
  fun query(raw: String?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (pair in raw.split('&')) {
      if (pair.isEmpty()) continue
      val i = pair.indexOf('=')
      val k = decode(if (i < 0) pair else pair.substring(0, i))
      val v = if (i < 0) "" else decode(pair.substring(i + 1))
      out.putIfAbsent(k, v)
    }
    return out
  }

  private fun decode(s: String): String = try { URLDecoder.decode(s, "UTF-8") } catch (_: Exception) { s }

  private fun port(u: URI): Int = if (u.port >= 0) u.port else if (u.scheme?.lowercase() == "https") 443 else 80

  /** Same scheme, host and port as the server: the page's own navigations and files. */
  fun isSameOrigin(url: String?, origin: String?): Boolean {
    if (url == null || origin == null) return false
    val a = try { URI(url) } catch (_: Exception) { return false }
    val b = try { URI(origin) } catch (_: Exception) { return false }
    val ah = a.host ?: return false
    val bh = b.host ?: return false
    return a.scheme?.lowercase() == b.scheme?.lowercase() && ah.lowercase() == bh.lowercase() && port(a) == port(b)
  }

  /** Where a cold launch goes: `<origin>/#<route>`. */
  fun homeUrl(origin: String, route: String): String = origin.trimEnd('/') + "/" + (if (isRoute(route)) route else "")

  /**
   * Keep your place when signing in again to the same server: `/login?…&next=<route>` redirects there. Encoded by
   * hand (RFC 3986 unreserved only) so `&` and `=` inside a route like `#/search?q=a&b` can't split the query.
   */
  fun withNext(login: String, route: String): String {
    if (route.isEmpty() || !isRoute(route)) return login
    val q = login.indexOf('?')
    val base = if (q < 0) login else login.substring(0, q)
    val kept = if (q < 0) emptyList() else login.substring(q + 1).split('&').filter { it.isNotEmpty() && !it.startsWith("next=") }
    return base + "?" + (kept + ("next=" + encode(route))).joinToString("&")
  }

  fun encode(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")

  /** `#/t/abc?x` → `#/t/abc`: the route part of a notification url (`#/…` or `/#/…`) for the "already on screen" check. */
  fun hashPath(s: String): String {
    val i = s.indexOf('#')
    if (i < 0) return ""
    return s.substring(i).substringBefore('?')
  }

  /** A notification url (`#/t/…` or `/#/t/…`) as a route, or null when it isn't one. */
  fun notificationRoute(url: String): String? {
    val h = if (url.startsWith("/#")) url.substring(1) else url
    return h.takeIf { isRoute(it) }
  }

  /** Files never open as pages: they'd replace the app with no way back. */
  val FILE_PATHS = setOf("/api/media", "/api/image")

  fun path(url: String): String = try { URI(url).rawPath ?: "" } catch (_: Exception) { "" }

  fun isHttp(url: String): Boolean = url.startsWith("http://", true) || url.startsWith("https://", true)

  /** The file name a server url stands for: `/api/media?path=/a/b.png` → `b.png`, else the last path segment. */
  fun fileName(url: String): String {
    val u = try { URI(url) } catch (_: Exception) { return "file" }
    val p = query(u.rawQuery)["path"]?.takeIf { it.isNotBlank() } ?: u.path ?: ""
    return safeName(p.trimEnd('/').substringAfterLast('/').substringAfterLast('\\'))
  }

  /** A file name that can't escape its folder. */
  fun safeName(n: String?): String {
    val s = (n ?: "").replace('/', '-').replace('\\', '-').replace(':', '-').trim()
    return if (s.isEmpty() || s == "." || s == "..") "file" else s
  }

  /** `attachment; filename="a b.png"` / `filename*=UTF-8''a%20b.png` → `a b.png`. */
  fun dispositionName(cd: String?): String? {
    if (cd == null) return null
    Regex("""filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)""").find(cd)?.let { return decode(it.groupValues[1].trim().trim('"')) }
    Regex("""filename\s*=\s*"([^"]*)"""").find(cd)?.let { return it.groupValues[1] }
    Regex("""filename\s*=\s*([^;]+)""").find(cd)?.let { return it.groupValues[1].trim() }
    return null
  }

  fun isAttachment(cd: String?): Boolean = cd?.trim()?.lowercase()?.startsWith("attachment") == true

  /** JSON string literal for evaluateJavascript. */
  fun jsString(s: String): String {
    val b = StringBuilder("\"")
    for (c in s) when (c) {
      '\\' -> b.append("\\\\"); '"' -> b.append("\\\""); '\n' -> b.append("\\n"); '\r' -> b.append("\\r")
      '\u2028' -> b.append("\\u2028"); '\u2029' -> b.append("\\u2029")
      else -> if (c < ' ') b.append(String.format("\\u%04x", c.code)) else b.append(c)
    }
    return b.append('"').toString()
  }
}
