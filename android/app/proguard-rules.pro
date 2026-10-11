# Android manifest entry points are retained by the Android Gradle plugin.
# AndroidX WebKit and Firebase contribute their own consumer rules (including Firebase component registrars).
# The bridge is WebMessageListener, not reflection-based addJavascriptInterface.
-keepattributes Signature,InnerClasses,EnclosingMethod,*Annotation*
# Keep the listener callback boundary explicit; no broad keep of app code or Firebase is needed.
-keepclassmembers class * implements androidx.webkit.WebViewCompat$WebMessageListener {
    public void onPostMessage(...);
}
