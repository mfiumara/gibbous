package dev.gibbous.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRulesTest {
  @Test fun onlySuppressesTheForegroundThread() {
    assertTrue(PushRules.suppress(true, "/#/t/example?x=1", "#/t/example?y=2"))
    assertFalse(PushRules.suppress(false, "#/t/example", "#/t/example"))
    assertFalse(PushRules.suppress(true, "#/t/other", "#/t/example"))
    assertFalse(PushRules.suppress(true, "#/", "#/"))
    assertFalse(PushRules.suppress(true, "", ""))
    assertFalse(PushRules.suppress(true, "https://other.example/#/t/example", "#/t/example"))
  }
}
