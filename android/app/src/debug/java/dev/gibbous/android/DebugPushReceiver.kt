package dev.gibbous.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Debug source set only. No test backdoor is packaged in release. */
class DebugPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != "dev.gibbous.android.DEBUG_PUSH") return
    val fields = listOf("type", "title", "body", "url", "tag", "badge", "kind")
    Push.receive(context, fields.mapNotNull { k -> intent.getStringExtra(k)?.let { k to it } }.toMap())
  }
}
