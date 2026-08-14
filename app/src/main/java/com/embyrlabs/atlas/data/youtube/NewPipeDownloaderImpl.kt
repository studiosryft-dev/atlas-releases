package com.embyrlabs.atlas.data.youtube

import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import java.util.concurrent.TimeUnit

/**
 * NewPipeExtractor requires the host app to supply its own HTTP layer (it has no bundled
 * networking) — this wires it to OkHttp. Shape follows the same pattern NewPipe's own app
 * uses (DownloaderImpl). Not compile-verified in this environment (no JDK/Android SDK
 * available here) — the first thing to check if a build error mentions this file is whether
 * NewPipeExtractor's `Request`/`Response`/`Downloader` method signatures drifted from the
 * pinned version in libs.versions.toml.
 */
class NewPipeDownloaderImpl : Downloader() {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    override fun execute(request: Request): Response {
        val dataToSend = request.dataToSend()
        val body = dataToSend?.toRequestBody(null, 0, dataToSend.size)

        val builder = okhttp3.Request.Builder()
            .url(request.url())
            .method(request.httpMethod(), body)

        for ((headerName, headerValues) in request.headers()) {
            if (headerValues.isEmpty()) continue
            builder.removeHeader(headerName)
            headerValues.forEach { builder.addHeader(headerName, it) }
        }

        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 429) {
                throw ReCaptchaException("reCAPTCHA challenge requested", request.url())
            }
            val responseBody = response.body?.string() ?: ""
            val latestUrl = response.request.url.toString()
            return Response(
                response.code,
                response.message,
                response.headers.toMultimap(),
                responseBody,
                latestUrl,
            )
        }
    }
}
