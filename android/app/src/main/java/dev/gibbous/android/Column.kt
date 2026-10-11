package dev.gibbous.android

import android.content.Context
import android.util.AttributeSet
import android.view.View.MeasureSpec
import android.widget.LinearLayout

/** A vertical LinearLayout that never grows wider than `app:maxWidth` (readable column on tablets / landscape). */
class Column @JvmOverloads constructor(c: Context, attrs: AttributeSet? = null) : LinearLayout(c, attrs) {
  private val maxW: Int

  init {
    orientation = VERTICAL
    val a = c.obtainStyledAttributes(attrs, R.styleable.Column)
    maxW = a.getDimensionPixelSize(R.styleable.Column_columnMaxWidth, Int.MAX_VALUE)
    a.recycle()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val w = MeasureSpec.getSize(widthSpec)
    val spec = if (MeasureSpec.getMode(widthSpec) != MeasureSpec.UNSPECIFIED && w > maxW) MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.EXACTLY) else widthSpec
    super.onMeasure(spec, heightSpec)
  }
}
