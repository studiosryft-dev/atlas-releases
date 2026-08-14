plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.embyrlabs.atlas"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.embyrlabs.atlas"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // Deployed embyr-backend-keystone on Render — always on regardless of your PC.
        buildConfigField("String", "KEYSTONE_BASE_URL", "\"https://embyr-backend-keystone.onrender.com/\"")

        // Same Supabase project as EmbyrKeystone, queried directly for update checks (see
        // com.embyrlabs.atlas.update.UpdateChecker) rather than routing through the Render
        // backend — release metadata is public/non-sensitive, and the anon key is exactly the
        // credential meant to ship inside a client app (protected by RLS, not secrecy; see
        // supabase-migrations/006_app_releases.sql's read-only policy).
        buildConfigField("String", "SUPABASE_URL", "\"https://tykonepgafsortdodbfn.supabase.co\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5a29uZXBnYWZzb3J0ZG9kYmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNDQ1MTMsImV4cCI6MjEwMTcyMDUxM30.zEP9lDFI1vNFY-h44lmInxw_UEJqScaOhRGyM-ZZDJc\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.ktx)
    // ComponentActivity, registerForActivityResult, OnBackPressedCallback — previously came in
    // transitively via activity-compose, which no longer exists post WebView-pivot; needs to be
    // a direct dependency now that MainActivity is a plain (non-Compose) ComponentActivity.
    implementation(libs.androidx.activity.ktx)

    // UI is a WebView (assets/www/) as of the WebView-UI pivot — androidx.webkit gives us
    // WebViewAssetLoader (serves assets/www/ over a real https:// origin instead of file://,
    // avoiding a set of real WebView quirks file:// has around fetch()/relative resources).
    implementation(libs.androidx.webkit)

    implementation(libs.retrofit.core)
    implementation(libs.retrofit.kotlinx.serialization.converter)
    implementation(libs.okhttp.logging.interceptor)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.datastore.preferences)

    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)

    implementation(libs.okhttp.core)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // NewPipeExtractor needs an app-supplied Downloader (see data/youtube/NewPipeDownloaderImpl.kt)
    // and a JS engine for YouTube's signature deciphering — rhino, per NewPipe's own app build.
    implementation(libs.newpipe.extractor)
    implementation(libs.rhino)

    // Voice Isolation/Removal — CPU inference for the on-device Demucs (htdemucs, fp16) ONNX
    // export. See data/voiceisolation/VoiceIsolationModel.kt for where the actual model weights
    // come from and why (third-party HT-Demucs ONNX conversion, not an official Meta artifact;
    // a Spleeter alternative was tried and reverted — see SETUP.md).
    implementation(libs.onnxruntime.android)
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
