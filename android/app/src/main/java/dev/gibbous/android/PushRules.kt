package dev.gibbous.android

object PushRules {
  fun suppress(foreground: Boolean, url: String, route: String): Boolean {
    val target = Links.notificationRoute(url)?.let { Links.hashPath(it) } ?: return false
    return foreground && target.startsWith("#/t/") && target == Links.hashPath(route)
  }
}
