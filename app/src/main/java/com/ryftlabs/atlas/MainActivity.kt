package com.ryftlabs.atlas

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.ryftlabs.atlas.bridge.WebAppBridge
import com.ryftlabs.atlas.data.storage.IdleCompressionSweeper
import com.ryftlabs.atlas.data.storage.StorageRevertCleanup
import kotlinx.coroutines.launch
import java.io.File

/**
 * The entire UI surface is a single WebView loading bundled assets (assets/www/), with
 * WebAppBridge as the only channel between it and everything native (playback, downloads,
 * Room, the equalizer). Follows the same proven WebViewAssetLoader setup as the prior
 * Avero/Embyr hybrid build of this app (see its own MainActivity's doc comments) — same
 * reasoning, same two bugs deliberately avoided:
 *  1. AssetsPathHandler must be registered at "/", not "/www/" — it strips whatever prefix
 *     you register before resolving against assets/, so "/www/" strips down to looking for
 *     a nonexistent assets/index.html instead of the real assets/www/index.html.
 *  2. WebViewAssetLoader's real default domain is appassets.androidplatform.net (confirmed
 *     from androidx.webkit source, not guessed) — loadUrl must target that exact origin.
 *
 * Artwork (`filesDir/artwork/`) is served the same way, at the virtual path "/artwork/", via
 * WebViewAssetLoader.InternalStoragePathHandler rather than turning `allowFileAccess` back on —
 * that setting is deliberately off (blocking `file://` entirely is the right default for a
 * WebView loading remote-shaped content), so local images need their own scoped, path-traversal-
 * safe handler instead of a blanket file:// exemption.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: WebAppBridge
    private var jsHandlesBack = false

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op either way */ }

    private var pendingImagePickCallback: ((String?) -> Unit)? = null
    private val imagePickerLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val callback = pendingImagePickCallback
            pendingImagePickCallback = null
            callback?.invoke(uri?.toString())
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge: content extends behind status/nav bars; base.css consumes the real
        // env(safe-area-inset-*) values Chromium reports once laid out this way, keeping the
        // global header/bottom nav clear of the bars while the glass background bleeds behind.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(Color.parseColor("#07040F")) // matches --void background token, avoids a white flash pre-paint
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            // Android's autofill framework (password managers like Bitwarden) inspects the
            // WebView's reported virtual view structure for anything that looks like a login
            // form — this app has no login form inside the WebView content (auth screens use
            // plain text/username fields, nothing password-shaped), but simply having any
            // <input> element plus a focus change (e.g. a search field losing focus when an
            // indexed page opens over it) was enough to trip the "save to password manager"
            // heuristic. Opting the whole WebView out is the standard fix for this exact
            // false-positive-prompt behavior.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
        }
        setContentView(webView)

        val artworkDir = File(filesDir, "artwork").apply { mkdirs() }
        val assetLoader = WebViewAssetLoader.Builder()
            // More specific prefix registered first — "/artwork/..." must resolve here, not
            // fall through to the catch-all "/" assets handler below.
            .addPathHandler("/artwork/", WebViewAssetLoader.InternalStoragePathHandler(this, artworkDir))
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("AtlasWebView", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }

        bridge = WebAppBridge(
            webView = webView,
            context = applicationContext,
            pickImage = { callback ->
                pendingImagePickCallback = callback
                imagePickerLauncher.launch("image/*")
            },
            pasteFromClipboard = {
                val clipboard = getSystemService(ClipboardManager::class.java)
                val clip: ClipData? = clipboard?.primaryClip
                if (clip != null && clip.itemCount > 0) clip.getItemAt(0).text?.toString() else null
            },
        )
        webView.addJavascriptInterface(bridge, "AtlasNative")

        // One-time cleanup for tracks/artwork a prior version wrote to public MediaStore storage
        // (reverted — see StorageRevertCleanup's own doc comment), then the regular idle-
        // compression sweep. Both are cheap no-ops once there's nothing left to do.
        lifecycleScope.launch {
            val cleanup = StorageRevertCleanup.cleanupIfNeeded(applicationContext)
            if (cleanup.movedCount > 0 || cleanup.removedDuplicates > 0) {
                bridge.notifyStorageCleanup(cleanup.movedCount, cleanup.removedDuplicates)
            }
            IdleCompressionSweeper.sweep(applicationContext)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (jsHandlesBack) {
                    bridge.notifyBackPressed()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    fun setJsHandlesBack(value: Boolean) {
        jsHandlesBack = value
    }

    // The WebView/JS context survives an Activity pause (the process isn't killed just from
    // backgrounding), so this is what actually drives "re-check the license silently whenever
    // you come back to the app" — Auth.onAppResume() is a no-op if auth.js hasn't finished
    // loading yet (guarded on the JS side), so firing this unconditionally on every resume,
    // including the very first one right after onCreate, is safe.
    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            // `Auth` is a top-level `const` in a classic (non-module) script, so it's a global
            // identifier but NOT a `window` property — `typeof` is what actually guards this
            // safely before auth.js has executed (e.g. the very first onResume during cold start).
            webView.evaluateJavascript("if (typeof Auth !== 'undefined' && Auth.onAppResume) Auth.onAppResume();", null)
        }
    }

    override fun onDestroy() {
        bridge.destroy()
        webView.destroy()
        super.onDestroy()
    }
}
