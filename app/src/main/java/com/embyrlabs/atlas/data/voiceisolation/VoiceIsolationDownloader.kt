package com.embyrlabs.atlas.data.voiceisolation

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Fetches the Voice Isolation model to app-private storage on first use. Deliberately a
 * separate, minimal OkHttpClient rather than reusing DownloadEngine's — that one is tuned for
 * many small concurrent track downloads; this is a single large (~166MB) one-shot transfer with
 * a much longer plausible duration, so it gets its own generous timeouts.
 */
class VoiceIsolationDownloader(private val context: Context) {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .callTimeout(30, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()

    private val modelsDir get() = File(context.filesDir, "models").apply { mkdirs() }
    val modelFile: File get() = File(modelsDir, VoiceIsolationModel.FILE_NAME)

    fun isModelReady(): Boolean = modelFile.exists() && modelFile.length() > 0

    /** Downloads to a .part file and only renames to the final name on success, so a killed/
     *  failed download never leaves a corrupt file that [isModelReady] would wrongly trust. */
    suspend fun download(onProgress: (Int) -> Unit) = withContext(Dispatchers.IO) {
        val partFile = File(modelsDir, "${VoiceIsolationModel.FILE_NAME}.part")
        val request = Request.Builder().url(VoiceIsolationModel.DOWNLOAD_URL).build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw java.io.IOException("HTTP ${response.code} downloading the model.")
            val body = response.body ?: throw java.io.IOException("Empty response body.")
            val total = body.contentLength().takeIf { it > 0 } ?: VoiceIsolationModel.APPROX_SIZE_BYTES

            var downloaded = 0L
            var lastPercent = -1
            body.byteStream().use { input ->
                partFile.outputStream().use { output ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        val percent = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                        if (percent != lastPercent) {
                            lastPercent = percent
                            onProgress(percent)
                        }
                    }
                }
            }
        }

        if (!partFile.renameTo(modelFile)) {
            partFile.copyTo(modelFile, overwrite = true)
            partFile.delete()
        }
    }
}
