package dev.gibbous.android

import android.os.Build
import android.view.HapticFeedbackConstants as H
import android.view.View

object Haptics {
  fun perform(view: View, style: String) {
    val effect = when (style) {
      "selection" -> H.CLOCK_TICK
      "light" -> H.KEYBOARD_TAP
      "soft" -> H.VIRTUAL_KEY
      "medium", "heavy" -> H.LONG_PRESS
      "rigid" -> H.CONTEXT_CLICK
      "success" -> if (Build.VERSION.SDK_INT >= 30) H.CONFIRM else H.VIRTUAL_KEY
      "warning", "error" -> if (Build.VERSION.SDK_INT >= 30) H.REJECT else H.LONG_PRESS
      else -> return
    }
    view.performHapticFeedback(effect)
    if (BuildConfig.DEBUG) logi("haptic $style")
  }
}
