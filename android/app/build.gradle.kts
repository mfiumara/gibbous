import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
}

// Firebase (FCM) only when the developer dropped their own google-services.json here (gitignored). Without it the
// app builds and runs; gibbousPush answers pushError instead.
if (file("google-services.json").exists()) {
  apply(plugin = "com.google.gms.google-services")
}

// Release signing: android/keystore.properties (gitignored) with storeFile/storePassword/keyAlias/keyPassword.
// Without it release builds are unsigned (CI/artifact inspection only; Play requires an upload-key signature).
val keystoreProps = rootProject.file("keystore.properties").takeIf { it.exists() }?.let { f ->
  Properties().apply { f.inputStream().use { load(it) } }
}
// Local smoke tests only: `./gradlew assembleRelease -Pgibbous.debugSignedRelease=true` signs release with the debug key.
val debugSignedRelease = providers.gradleProperty("gibbous.debugSignedRelease").orNull == "true"

android {
  namespace = "dev.gibbous.android"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.gibbous.android"
    minSdk = 26
    targetSdk = 36
    buildConfigField("boolean", "FIREBASE_CONFIGURED", file("google-services.json").exists().toString())
    versionCode = 1
    versionName = "1.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  signingConfigs {
    if (keystoreProps != null) {
      create("release") {
        storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
        storePassword = keystoreProps.getProperty("storePassword")
        keyAlias = keystoreProps.getProperty("keyAlias")
        keyPassword = keystoreProps.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = when {
        debugSignedRelease -> signingConfigs.getByName("debug")
        keystoreProps != null -> signingConfigs.getByName("release")
        else -> null
      }
    }
  }

  buildFeatures {
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity)
  implementation(libs.androidx.appcompat)
  implementation(libs.androidx.webkit)
  implementation(libs.androidx.browser)
  implementation(libs.androidx.splashscreen)
  implementation(libs.material)
  implementation(libs.zxing.embedded)
  implementation(platform(libs.firebase.bom))
  implementation(libs.firebase.messaging)
  testImplementation(libs.junit)
}
