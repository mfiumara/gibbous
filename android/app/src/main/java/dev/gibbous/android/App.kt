package dev.gibbous.android

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log

const val TAG = "GibbousShell"

class App : Application() {
  override fun onCreate() {
    super.onCreate()
    Server.init(this)
    // Foreground = some activity of ours is started. FCM pushes about the thread on screen are skipped then.
    registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
      override fun onActivityStarted(a: Activity) { started++ }
      override fun onActivityStopped(a: Activity) { started = maxOf(0, started - 1) }
      override fun onActivityCreated(a: Activity, b: Bundle?) {}
      override fun onActivityResumed(a: Activity) {}
      override fun onActivityPaused(a: Activity) {}
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
      override fun onActivityDestroyed(a: Activity) {}
    })
  }

  companion object {
    @Volatile private var started = 0
    val inForeground: Boolean get() = started > 0
  }
}

fun logi(msg: String) { Log.i(TAG, msg) }
fun loge(msg: String, t: Throwable? = null) { Log.e(TAG, msg, t) }
