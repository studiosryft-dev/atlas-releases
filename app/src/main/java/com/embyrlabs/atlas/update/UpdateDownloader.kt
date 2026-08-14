package com.embyrlabs.atlas.update

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Downloads a release APK into `filesDir/updates/` (the one directory exposed via FileProvider,
 *  see res/xml/file_paths.xml) with progress callbacks — same streamed-download shape as
 *  DownloadEngine's single-stream fallback, kept as its own small class rather than reusing
 *  DownloadEngine directly since an APK download has nothing to do with the track queue/Room. */
class UpdateDownloader(private val context: Context) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.MINUTES)
        .build()

    private val updatesDir get() = File(context.filesDir, "updates").apply { mkdirs() }

    /** Clears any previously-downloaded update APKs before starting — there's only ever one
     *  "the update currently offered," and leaving old partial/stale downloads around serves no
     *  purpose. */
    suspend fun download(info: UpdateInfo, onProgress: (Int) -> Unit): File = withContext(Dispatchers.IO) {
        updatesDir.listFiles()?.forEach { it.delete() }
        val target = File(updatesDir, "atlas-${info.versionCode}.apk")
        val request = Request.Builder().url(info.apkUrl).build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Download failed: HTTP ${response.code}")
            val body = response.body ?: throw IOException("Empty response body.")
            val total = body.contentLength().takeIf { it > 0 } ?: info.sizeBytes
            var downloaded = 0L
            var lastPercent = -1

            body.byteStream().use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        if (total > 0) {
                            val percent = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            }
        }
        target
    }
}
