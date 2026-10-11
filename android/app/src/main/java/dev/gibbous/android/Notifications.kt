package dev.gibbous.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object Notifications {
  fun notify(context: Context, data: JSONObject) {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("gibbous", "Gibbous", NotificationManager.IMPORTANCE_HIGH))
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val url = Links.notificationRoute(data.optString("url")) ?: "#/"
    val tag = data.optString("tag").ifBlank { url }
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      this.data = Uri.parse("gibbous://notification/" + Uri.encode(tag))
      putExtra(MainActivity.EXTRA_OPEN_URL, url)
    }
    val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(context, "gibbous")
      .setSmallIcon(R.drawable.ic_notification)
      .setColor(ContextCompat.getColor(context, R.color.tide))
      .setContentTitle(data.optString("title", "Gibbous"))
      .setContentText(data.optString("body"))
      .setStyle(NotificationCompat.BigTextStyle().bigText(data.optString("body")))
      .setContentIntent(pending).setAutoCancel(true).setGroup(tag)
      .setNumber(Server.badge).setPriority(NotificationCompat.PRIORITY_HIGH).build()
    try { manager.notify(tag, 1, notification); logi("notification posted") }
    catch (_: SecurityException) { logi("notification permission missing") }
  }
}
