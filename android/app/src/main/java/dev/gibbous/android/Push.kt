package dev.gibbous.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

object Push {
  const val DENIED = "Notifications are turned off for Gibbous in Android Settings → Notifications."
  const val UNCONFIGURED = "This build has no Firebase configuration (google-services.json)."

  fun allowed(c: Context): Boolean =
    (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
      NotificationManagerCompat.from(c).areNotificationsEnabled()

  fun error(message: String) { Shell.live?.send(mapOf("type" to "pushError", "message" to message)) }

  fun register(c: Context) {
    if (!allowed(c)) { error(DENIED); return }
    // FirebaseInitProvider is removed: an open-source build with no configuration is fully usable.
    if (!BuildConfig.FIREBASE_CONFIGURED) { error(UNCONFIGURED); return }
    val app = runCatching { FirebaseApp.getApps(c).firstOrNull() ?: FirebaseApp.initializeApp(c) }.getOrNull()
    if (app == null) { error(UNCONFIGURED); return }
    runCatching {
      FirebaseMessaging.getInstance().isAutoInitEnabled = true
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful) token(task.result) else error("Couldn't register for notifications. Please try again.")
      }
    }.onFailure { error("Couldn't register for notifications. Please try again.") }
  }

  fun token(value: String) {
    Server.pendingPushToken = value
    Handler(Looper.getMainLooper()).post { Shell.live?.let { if (it.pageReady) deliver(it) } }
  }

  fun deliver(shell: WebShell) {
    val token = Server.pendingPushToken ?: Server.pushToken ?: return
    shell.send(mapOf("type" to "pushToken", "token" to token, "env" to "fcm"))
    Server.pushToken = token
    Server.pendingPushToken = null
  }

  /** Both FCM and the debug-only receiver run this exact receive path. */
  fun receive(c: Context, data: Map<String, String>) {
    Server.init(c)
    data["badge"]?.toIntOrNull()?.let { Server.badge = it }
    if (data["type"] != "notify") return
    if (PushRules.suppress(App.inForeground, data["url"].orEmpty(), Server.route)) {
      logi("push suppressed: thread on screen")
      return
    }
    Notifications.notify(c, JSONObject(data))
  }
}

class GibbousMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) { Server.init(this); Push.token(token) }
  override fun onMessageReceived(message: RemoteMessage) { Push.receive(this, message.data) }
}
