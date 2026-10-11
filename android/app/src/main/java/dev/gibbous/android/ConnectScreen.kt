// The native sign-in screen: scan the QR code from Settings → Devices, or paste the sign-in link
// (port of ios/Gibbous/ConnectViewController.swift).
package dev.gibbous.android

import android.content.ClipboardManager
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

class ConnectScreen(
  private val activity: MainActivity,
  message: String?,
  canCancel: Boolean,
  private val onLink: (SignIn) -> Unit,
  private val onCancel: () -> Unit,
  private val onScan: () -> Unit,
) {
  val view: ScrollView = LayoutInflater.from(activity).inflate(R.layout.connect, null) as ScrollView
  private val error: TextView = view.findViewById(R.id.error)
  private val field: EditText = view.findViewById(R.id.field)
  private val panel: LinearLayout = view.findViewById(R.id.pastePanel)

  init {
    show(message, haptic = false)
    view.findViewById<View>(R.id.scan).setOnClickListener { onScan() }
    view.findViewById<View>(R.id.pasteLink).setOnClickListener { togglePaste() }
    view.findViewById<View>(R.id.paste).setOnClickListener { pasteClipboard() }
    view.findViewById<View>(R.id.go).setOnClickListener { submit(field.text.toString()) }
    field.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_GO || id == EditorInfo.IME_ACTION_DONE) { submit(field.text.toString()); true } else false }
    view.findViewById<View>(R.id.cancel).apply {
      visibility = if (canCancel) View.VISIBLE else View.GONE
      setOnClickListener { hideKeyboard(); onCancel() }
    }
    // Edge to edge: keep the column clear of the bars, and above the keyboard (the scroll view shrinks with it).
    ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
      if (ime.bottom > 0 && field.hasFocus()) v.postDelayed({ revealField() }, 120)
      WindowInsetsCompat.CONSUMED
    }
  }

  private fun show(text: String?, haptic: Boolean = true) {
    error.text = text ?: ""
    error.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
    if (haptic && !text.isNullOrEmpty()) {
      view.performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
      view.postDelayed({ revealField() }, 120)
    }
  }

  private fun togglePaste() {
    if (panel.visibility == View.VISIBLE) {
      panel.visibility = View.GONE
      hideKeyboard()
    } else {
      panel.visibility = View.VISIBLE
      field.requestFocus()
      activity.getSystemService(InputMethodManager::class.java)?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  /** Keep the paste field and its buttons above the keyboard. */
  private fun revealField() {
    if (panel.visibility != View.VISIBLE) return
    // Measured on screen: how far the panel's bottom (plus a margin) sits below the scroll view's visible bottom.
    val p = IntArray(2).also { panel.getLocationInWindow(it) }
    val s = IntArray(2).also { view.getLocationInWindow(it) }
    val delta = p[1] + panel.height + 16 * view.resources.displayMetrics.density - (s[1] + view.height - view.paddingBottom)
    if (delta > 0) view.smoothScrollBy(0, delta.toInt())
  }

  private fun pasteClipboard() {
    val cm = activity.getSystemService(ClipboardManager::class.java)
    val clip = cm?.primaryClip
    val s = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(activity)?.toString() else null
    if (s.isNullOrBlank()) { show(activity.getString(R.string.error_clipboard_empty)); return }
    field.setText(s)
    submit(s)
  }

  /** A code from the scanner: the same rules as a pasted link. */
  fun scanned(code: String) {
    if (Links.parseLink(code) == null) { show(activity.getString(R.string.error_bad_code)); return }
    submit(code)
  }

  fun submit(raw: String) {
    val link = Links.parseLink(raw)
    if (link == null) {
      field.setText("")  // masked, so it can't be fixed in place: start over with the next paste
      show(activity.getString(if (raw.trim().lowercase().startsWith("http://")) R.string.error_http else R.string.error_not_link))
      return
    }
    hideKeyboard()
    onLink(link)
  }

  private fun hideKeyboard() {
    activity.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(field.windowToken, 0)
    field.clearFocus()
  }
}
