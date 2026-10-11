package dev.gibbous.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinksTest {
  @Test fun parsesHttpsSignInLinks() {
    val l = Links.parseLink("  https://my-computer.tail1234.ts.net:8444/login?token=abc-DEF_123  ")!!
    assertEquals("https://my-computer.tail1234.ts.net:8444", l.origin)
    assertEquals("https://my-computer.tail1234.ts.net:8444/login?token=abc-DEF_123", l.login)
  }

  @Test fun dropsTheFragmentAndKeepsOtherQueryItems() {
    val l = Links.parseLink("https://h.ts.net/login?token=t&next=%23%2Ft%2Fx#/ignored")!!
    assertEquals("https://h.ts.net", l.origin)
    assertEquals("https://h.ts.net/login?token=t&next=%23%2Ft%2Fx", l.login)
  }

  @Test fun lowercasesSchemeAndHost() {
    val l = Links.parseLink("HTTPS://Host.TS.net:8444/login?token=x")!!
    assertEquals("https://host.ts.net:8444", l.origin)
  }

  @Test fun httpOnlyForDevHosts() {
    assertEquals("http://127.0.0.1:7981", Links.parseLink("http://127.0.0.1:7981/login?token=x")!!.origin)
    assertEquals("http://localhost:7979", Links.parseLink("http://localhost:7979/login?token=x")!!.origin)
    assertEquals("http://[::1]:7979", Links.parseLink("http://[::1]:7979/login?token=x")!!.origin)
    assertEquals("http://my-mac.local:7979", Links.parseLink("http://my-mac.local:7979/login?token=x")!!.origin)
    assertNull(Links.parseLink("http://my-mac.tail1234.ts.net:7979/login?token=x"))
    assertNull(Links.parseLink("http://192.168.1.4:7979/login?token=x"))
  }

  @Test fun rejectsNonSignInLinks() {
    assertNull(Links.parseLink(""))
    assertNull(Links.parseLink("not a link"))
    assertNull(Links.parseLink("https://h.ts.net/"))
    assertNull(Links.parseLink("https://h.ts.net/login"))
    assertNull(Links.parseLink("https://h.ts.net/login?token="))
    assertNull(Links.parseLink("https://h.ts.net/loginx?token=a"))
    assertNull(Links.parseLink("ftp://h.ts.net/login?token=a"))
    assertNull(Links.parseLink("https:///login?token=a"))
  }

  @Test fun unwrapsGibbousConnectLinks() {
    val inner = "https://h.ts.net:8444/login?token=abc"
    val l = Links.parseLink("gibbous://connect?link=" + Links.encode(inner))!!
    assertEquals("https://h.ts.net:8444", l.origin)
    assertEquals(inner, l.login)
    assertNull(Links.parseLink("gibbous://connect?link=" + Links.encode("https://h.ts.net/")))
    assertNull(Links.parseLink("gibbous://connect"))
  }

  @Test fun routes() {
    assertTrue(Links.isRoute("#/"))
    assertTrue(Links.isRoute("#/t/abc123"))
    assertTrue(Links.isRoute("#/search?q=a&b=c%20d"))
    assertTrue(Links.isRoute("#/settings/devices"))
    assertFalse(Links.isRoute(""))
    assertFalse(Links.isRoute("#t/abc"))
    assertFalse(Links.isRoute("/#/t/abc"))
    assertFalse(Links.isRoute("#/t/<script>"))
    assertFalse(Links.isRoute("#/t/a b"))
    assertFalse(Links.isRoute("#/x\"y"))
  }

  @Test fun sameOrigin() {
    assertTrue(Links.isSameOrigin("https://h.ts.net:8444/api/media?path=x", "https://h.ts.net:8444"))
    assertTrue(Links.isSameOrigin("https://H.ts.net/", "https://h.ts.net:443"))
    assertTrue(Links.isSameOrigin("http://127.0.0.1/x", "http://127.0.0.1:80"))
    assertFalse(Links.isSameOrigin("https://h.ts.net:8445/", "https://h.ts.net:8444"))
    assertFalse(Links.isSameOrigin("http://h.ts.net:8444/", "https://h.ts.net:8444"))
    assertFalse(Links.isSameOrigin("https://evil.example/", "https://h.ts.net"))
    assertFalse(Links.isSameOrigin(null, "https://h.ts.net"))
    assertFalse(Links.isSameOrigin("https://h.ts.net", null))
  }

  @Test fun homeUrl() {
    assertEquals("https://h.ts.net:8444/", Links.homeUrl("https://h.ts.net:8444", ""))
    assertEquals("https://h.ts.net:8444/#/t/abc", Links.homeUrl("https://h.ts.net:8444", "#/t/abc"))
    assertEquals("https://h.ts.net:8444/", Links.homeUrl("https://h.ts.net:8444", "javascript:alert(1)"))
  }

  @Test fun nextKeepsYourPlace() {
    val login = "https://h.ts.net/login?token=abc"
    assertEquals(login, Links.withNext(login, ""))
    assertEquals("$login&next=%23%2Ft%2Fabc", Links.withNext(login, "#/t/abc"))
    // & and = inside the route must not split the query.
    assertEquals("$login&next=%23%2Fsearch%3Fq%3Da%26b", Links.withNext(login, "#/search?q=a&b"))
    // An old next= is replaced, not duplicated.
    assertEquals("$login&next=%23%2Fnew", Links.withNext("$login&next=%23%2Fold", "#/new"))
    assertEquals(login, Links.withNext(login, "not a route"))
  }

  @Test fun notificationUrls() {
    assertEquals("#/t/abc", Links.notificationRoute("#/t/abc"))
    assertEquals("#/t/abc", Links.notificationRoute("/#/t/abc"))
    assertNull(Links.notificationRoute("https://evil.example/"))
    assertEquals("#/t/abc", Links.hashPath("/#/t/abc?x=1"))
    assertEquals("", Links.hashPath("/t/abc"))
  }

  @Test fun fileNames() {
    assertEquals("a b.png", Links.dispositionName("attachment; filename=\"a b.png\""))
    assertEquals("ü.txt", Links.dispositionName("attachment; filename*=UTF-8''%C3%BC.txt"))
    assertEquals("x.zip", Links.dispositionName("attachment; filename=x.zip"))
    assertTrue(Links.isAttachment("Attachment; filename=x"))
    assertFalse(Links.isAttachment("inline"))
    assertEquals("file", Links.safeName(".."))
    assertEquals("-etc-passwd", Links.safeName("/etc/passwd"))
  }

  @Test fun jsStrings() {
    assertEquals("\"a\\\"b\\\\c\\n\"", Links.jsString("a\"b\\c\n"))
  }
}
