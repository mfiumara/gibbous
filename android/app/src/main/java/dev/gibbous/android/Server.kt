// What the shell remembers: the server origin, the last route, the badge count and the FCM token. Never the sign-in
// token: signing in is one load of the server's /login?token=… link, which sets an HttpOnly cookie in CookieManager.
package dev.gibbous.android

import android.content.Context
import android.content.SharedPreferences

object Server {
  private lateinit var prefs: SharedPreferences

  fun init(c: Context) {
    if (!::prefs.isInitialized) prefs = c.applicationContext.getSharedPreferences("gibbous", Context.MODE_PRIVATE)
  }

  /** `https://host:port` of the Gibbous server, or null before the first sign-in. */
  var origin: String?
    get() = prefs.getString("server", null)
    set(v) = prefs.edit().putString("server", v).apply()

  /** Last `location.hash` the page reported (gibbousRoute), restored on cold launch. */
  var route: String
    get() = prefs.getString("route", "")!!.let { if (Links.isRoute(it)) it else "" }
    set(v) { if (v.isEmpty() || Links.isRoute(v)) prefs.edit().putString("route", v).apply() }

  /** gibbousBadge / FCM badge: the number shown on the next notifications. */
  var badge: Int
    get() = prefs.getInt("badge", 0)
    set(v) = prefs.edit().putInt("badge", maxOf(0, v)).apply()

  /** The FCM registration token, once the page asked for push and Firebase answered (local notifies stop then). */
  var pushToken: String?
    get() = prefs.getString("pushToken", null)
    set(v) = prefs.edit().putString("pushToken", v).apply()

  /** A token Firebase rotated while no page was live: sent on the next page ready. */
  var pendingPushToken: String?
    get() = prefs.getString("pendingPushToken", null)
    set(v) = prefs.edit().putString("pendingPushToken", v).apply()

  fun homeUrl(origin: String): String = Links.homeUrl(origin, route)
}
