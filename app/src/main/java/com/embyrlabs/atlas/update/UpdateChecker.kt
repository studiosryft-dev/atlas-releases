package com.embyrlabs.atlas.update

import com.embyrlabs.atlas.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Queries Supabase's PostgREST API directly for the latest published Android release — no
 * dedicated update backend, no round-trip through embyr-backend-keystone. `order=version_code.
 * desc&limit=1` does the "give me the newest one" work server-side; the only thing checked
 * client-side is whether that row's version_code is actually higher than what's installed, so
 * "no update available" and "this device is somehow ahead of the latest published row" both
 * cleanly resolve to null rather than needing separate handling.
 */
object UpdateChecker {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun checkForUpdate(currentVersionCode: Int): UpdateInfo? = withContext(Dispatchers.IO) {
        val url = "${BuildConfig.SUPABASE_URL}/rest/v1/app_releases" +
            "?platform=eq.android&order=version_code.desc&limit=1" +
            "&select=version,version_code,apk_url,size_bytes,release_notes,mandatory"
        val request = Request.Builder()
            .url(url)
            .header("apikey", BuildConfig.SUPABASE_ANON_KEY)
            .header("Authorization", "Bearer ${BuildConfig.SUPABASE_ANON_KEY}")
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Update check failed: HTTP ${response.code}")
            val bodyText = response.body?.string() ?: "[]"
            val rows = JSONArray(bodyText)
            if (rows.length() == 0) return@withContext null
            val row = rows.getJSONObject(0)
            val remoteVersionCode = row.getInt("version_code")
            if (remoteVersionCode <= currentVersionCode) return@withContext null
            UpdateInfo(
                version = row.getString("version"),
                versionCode = remoteVersionCode,
                apkUrl = row.getString("apk_url"),
                sizeBytes = row.optLong("size_bytes", 0L),
                releaseNotes = row.optString("release_notes", "").ifBlank { null },
                mandatory = row.optBoolean("mandatory", false),
            )
        }
    }
}
