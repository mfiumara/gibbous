// AGP 9 compiles Kotlin itself (built-in Kotlin); the Kotlin plugin is only on the classpath to pin its version.
plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.kotlin.android) apply false
  alias(libs.plugins.google.services) apply false
}
