package com.embyrlabs.atlas.data.download

import android.content.Context
import com.embyrlabs.atlas.data.db.AtlasDatabase
import com.embyrlabs.atlas.data.db.DownloadQueueItemEntity
import com.embyrlabs.atlas.data.db.DownloadStatus
import com.embyrlabs.atlas.data.db.PlaylistEntity
import com.embyrlabs.atlas.data.db.PlaylistTrackCrossRef
import com.embyrlabs.atlas.data.db.TrackEntity
import com.embyrlabs.atlas.data.youtube.AudioQuality
import com.embyrlabs.atlas.data.youtube.PlaylistEntry
import com.embyrlabs.atlas.data.youtube.YouTubeExtractorClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

private val PLAYLIST_URL_MARKERS = listOf("list=")

/**
 * Queue processor. [DownloadService] runs several of these concurrently (see CONCURRENT_WORKERS)
 * for real queue throughput on multi-track/playlist imports — a single file's own speed is
 * bounded by your connection and YouTube's server, not by anything here, but N tracks no longer
 * wait in line behind each other one at a time.
 *
 * [claimNext] is the only part that touches "which item do I work on" and is mutex-guarded so
 * concurrent workers can never grab the same queue row — everything after that (the actual
 * network transfer) runs fully in parallel across workers.
 */
class DownloadEngine(private val context: Context) {

    private val db = AtlasDatabase.get(context)
    private val queueDao = db.downloadQueueDao()
    private val trackDao = db.trackDao()
    private val playlistDao = db.playlistDao()
    private val claimMutex = Mutex()

    // A larger connection pool + higher per-host request limit lets multiple queue workers
    // (each themselves doing multi-chunk downloads, see downloadInParallelChunks below) actually
    // run concurrently instead of queueing behind OkHttp's own default caps (5 per host).
    private val httpClient = OkHttpClient.Builder()
        .dispatcher(Dispatcher().apply { maxRequests = 32; maxRequestsPerHost = 16 })
        .connectionPool(ConnectionPool(16, 60, TimeUnit.SECONDS))
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()

    private val tracksDir get() = File(context.filesDir, "tracks").apply { mkdirs() }
    private val artworkDir get() = File(context.filesDir, "artwork").apply { mkdirs() }

    /**
     * Claims the next pending item under a lock (fast — just a couple of DB ops) so two
     * concurrent workers can never both grab the same row. Playlist-link placeholders are
     * expanded here (still under the lock, still fast) rather than downloaded, since expansion
     * itself isn't a network-heavy operation worth parallelizing — the caller should loop and
     * claim again immediately after an expansion.
     *
     * Returns null when there's genuinely nothing left to claim.
     */
    private suspend fun claimNext(): DownloadQueueItemEntity? = claimMutex.withLock {
        val item = queueDao.nextPending() ?: return@withLock null

        if (item.status == DownloadStatus.QUEUED && looksLikePlaylist(item.youtubeUrl)) {
            expandPlaylist(item)
            return@withLock EXPANDED_MARKER
        }

        val claimed = item.copy(status = DownloadStatus.RESOLVING)
        queueDao.update(claimed)
        claimed
    }

    /** One worker's loop: claim -> process -> repeat until nothing's left. Safe to run several
     *  of these concurrently (see [DownloadService]). Quality is re-read per item (via
     *  [getQuality]) rather than fixed for the worker's lifetime, so a mid-queue Settings
     *  change takes effect on the next item instead of only after a service restart. */
    suspend fun runWorkerLoop(getQuality: suspend () -> AudioQuality, shouldWait: suspend () -> Boolean) {
        while (true) {
            if (shouldWait()) continue
            val item = claimNext() ?: break
            if (item === EXPANDED_MARKER) continue // a playlist link was just expanded — loop and claim a real item
            downloadClaimed(item, getQuality())
        }
    }

    suspend fun enqueue(url: String, asPlaylist: Boolean = false) = withContext(Dispatchers.IO) {
        val nextOrder = (queueDao.maxOrderIndex() ?: 0L) + 1
        queueDao.insert(
            DownloadQueueItemEntity(
                youtubeUrl = url.trim(),
                orderIndex = nextOrder,
                addedAt = System.currentTimeMillis(),
                asPlaylist = asPlaylist && looksLikePlaylist(url),
            )
        )
    }

    private fun looksLikePlaylist(url: String) = PLAYLIST_URL_MARKERS.any { url.contains(it) }

    private suspend fun expandPlaylist(item: DownloadQueueItemEntity) {
        queueDao.update(item.copy(status = DownloadStatus.RESOLVING))
        try {
            val playlist = YouTubeExtractorClient.resolvePlaylist(item.youtubeUrl)
            if (playlist.entries.isEmpty()) {
                queueDao.update(item.copy(status = DownloadStatus.FAILED, errorMessage = "Playlist has no videos."))
                return
            }
            // "Download as playlist" — create the real Playlist up front so every expanded
            // entry can be stamped with its target and linked in as its download completes.
            val targetPlaylistId = if (item.asPlaylist) {
                val id = UUID.randomUUID().toString()
                val nextSort = (playlistDao.maxSortOrder() ?: 0L) + 1
                playlistDao.insertPlaylist(
                    PlaylistEntity(id = id, name = playlist.title, sortOrder = nextSort, createdAt = System.currentTimeMillis())
                )
                id
            } else null

            var order = (queueDao.maxOrderIndex() ?: 0L)
            val expanded = playlist.entries.map { entry: PlaylistEntry ->
                order += 1
                DownloadQueueItemEntity(
                    youtubeUrl = entry.videoUrl,
                    resolvedTitle = entry.title,
                    resolvedArtist = entry.artist,
                    orderIndex = order,
                    addedAt = System.currentTimeMillis(),
                    targetPlaylistId = targetPlaylistId,
                )
            }
            // Replace the playlist-link placeholder with its expanded individual-track entries.
            queueDao.delete(item)
            queueDao.insertAll(expanded)
        } catch (e: Exception) {
            queueDao.update(item.copy(status = DownloadStatus.FAILED, errorMessage = e.message ?: "Failed to resolve playlist."))
        }
    }

    private suspend fun downloadClaimed(claimedItem: DownloadQueueItemEntity, quality: AudioQuality) = withContext(Dispatchers.IO) {
        val resolved = try {
            YouTubeExtractorClient.resolveVideo(claimedItem.youtubeUrl, quality)
        } catch (e: Exception) {
            queueDao.update(claimedItem.copy(status = DownloadStatus.FAILED, errorMessage = e.message ?: "Couldn't resolve this link."))
            return@withContext
        }

        val existing = trackDao.findByVideoId(resolved.videoId)
        if (existing != null && existing.trashedAt == null) {
            queueDao.update(claimedItem.copy(status = DownloadStatus.COMPLETED, progressPercent = 100, resolvedTitle = resolved.title, resolvedArtist = resolved.artist))
            return@withContext
        }

        var current = claimedItem.copy(
            status = DownloadStatus.DOWNLOADING,
            resolvedTitle = resolved.title,
            resolvedArtist = resolved.artist,
            resolvedThumbnailUrl = resolved.thumbnailUrl,
        )
        queueDao.update(current)

        val trackId = UUID.randomUUID().toString()
        val audioFile = File(tracksDir, "$trackId.m4a")

        try {
            // Audio and artwork fetched concurrently rather than artwork-after-audio — they're
            // independent once we know the URLs, no reason to serialize them.
            coroutineScope {
                val audioJob = async {
                    downloadToFile(resolved.audioStreamUrl, audioFile) { percent ->
                        if (percent != current.progressPercent) {
                            current = current.copy(progressPercent = percent)
                            // Throttled to whole-percent steps by downloadToFile below, so this
                            // blocking-within-IO-dispatcher write is infrequent enough to be fine.
                            runBlocking(Dispatchers.IO) { queueDao.update(current) }
                        }
                    }
                }
                val artworkJob = async {
                    resolved.thumbnailUrl?.let { thumbUrl ->
                        runCatching {
                            val artFile = File(artworkDir, "$trackId.jpg")
                            downloadToFile(thumbUrl, artFile) {}
                            artFile.absolutePath
                        }.getOrNull()
                    }
                }
                audioJob.await()
                val artworkPath = artworkJob.await()

                val nextSort = (trackDao.maxSortOrder() ?: 0L) + 1
                trackDao.insert(
                    TrackEntity(
                        id = trackId,
                        sourceVideoId = resolved.videoId,
                        sourceUrl = resolved.sourceUrl,
                        title = resolved.title,
                        artist = resolved.artist,
                        durationMs = resolved.durationMs,
                        localFilePath = audioFile.absolutePath,
                        artworkPath = artworkPath,
                        addedAt = System.currentTimeMillis(),
                        sortOrder = nextSort,
                        qualityLabel = quality.name,
                        originalTitle = resolved.title,
                        originalArtist = resolved.artist,
                    )
                )

                claimedItem.targetPlaylistId?.let { playlistId ->
                    val position = (playlistDao.maxTrackPosition(playlistId) ?: -1L) + 1
                    playlistDao.addTrack(PlaylistTrackCrossRef(playlistId = playlistId, trackId = trackId, position = position))
                }

                queueDao.update(current.copy(status = DownloadStatus.COMPLETED, progressPercent = 100))
            }
        } catch (e: Exception) {
            audioFile.delete()
            queueDao.update(current.copy(status = DownloadStatus.FAILED, errorMessage = e.message ?: "Download failed."))
        }
    }

    /** Re-downloads just the audio for a track Idle Compression previously removed the local
     *  file for, updating the SAME Room row in place (unlike a normal fresh download, which
     *  inserts a new row) — so playlist membership, liked state, and play history all survive.
     *  Re-resolves the stream URL via [YouTubeExtractorClient] since the original one is long
     *  expired, and re-uses the track's own original download quality rather than whatever the
     *  global setting currently is, so a re-hydrated track doesn't silently change quality out
     *  from under the user. Called from [com.embyrlabs.atlas.playback.QueueManager] right before
     *  a not-currently-downloaded track is played/queued. */
    suspend fun redownloadInPlace(track: TrackEntity): TrackEntity = withContext(Dispatchers.IO) {
        val quality = runCatching { AudioQuality.valueOf(track.qualityLabel) }.getOrDefault(AudioQuality.MEDIUM)
        val resolved = YouTubeExtractorClient.resolveVideo(track.sourceUrl, quality)
        val audioFile = File(tracksDir, "${track.id}.m4a")
        try {
            downloadToFile(resolved.audioStreamUrl, audioFile) {}
            trackDao.markRedownloaded(track.id, audioFile.absolutePath)
            track.copy(localFilePath = audioFile.absolutePath, isDownloaded = true)
        } catch (e: Exception) {
            audioFile.delete()
            throw e
        }
    }

    /**
     * Downloads [url] into [target]. If the server supports HTTP byte-range requests (Google's
     * video CDN generally does), the file is split into [CHUNK_COUNT] pieces and downloaded
     * concurrently — the same technique the prior WebView build of this app used, ported
     * directly: a single HTTP stream rarely saturates the connection, splitting into concurrent
     * ranged chunks routinely cuts wall-clock time by more than half. Falls back to one
     * streamed download when range support isn't there or the file's too small for chunking
     * overhead to be worth it.
     */
    private suspend fun downloadToFile(url: String, target: File, onProgress: (Int) -> Unit) = withContext(Dispatchers.IO) {
        val rangeInfo = probeRangeSupport(url)
        if (rangeInfo.supported && rangeInfo.totalBytes >= MIN_BYTES_FOR_PARALLEL_DOWNLOAD) {
            downloadInParallelChunks(url, target, rangeInfo.totalBytes, onProgress)
        } else {
            downloadSingleStream(url, target, onProgress)
        }
    }

    private data class RangeSupport(val supported: Boolean, val totalBytes: Long)

    private fun probeRangeSupport(url: String): RangeSupport {
        val request = Request.Builder().url(url).header("Range", "bytes=0-0").build()
        httpClient.newCall(request).execute().use { response ->
            if (response.code == 206) {
                val contentRange = response.header("Content-Range") // "bytes 0-0/12345678"
                val total = contentRange?.substringAfterLast('/')?.toLongOrNull() ?: -1L
                return RangeSupport(supported = total > 0, totalBytes = total)
            }
            return RangeSupport(supported = false, totalBytes = response.body?.contentLength() ?: -1L)
        }
    }

    private suspend fun downloadInParallelChunks(
        url: String,
        destination: File,
        totalBytes: Long,
        onProgress: (Int) -> Unit,
    ) = coroutineScope {
        val chunkSize = totalBytes / CHUNK_COUNT
        val downloadedBytes = java.util.concurrent.atomic.AtomicLong(0)

        java.io.RandomAccessFile(destination, "rw").use { raf ->
            raf.setLength(totalBytes)
            val channel = raf.channel
            val jobs = (0 until CHUNK_COUNT).map { i ->
                val start = i * chunkSize
                val end = if (i == CHUNK_COUNT - 1) totalBytes - 1 else (start + chunkSize - 1)
                async(Dispatchers.IO) {
                    downloadChunk(url, start, end, channel, downloadedBytes, totalBytes, onProgress)
                }
            }
            jobs.awaitAll()
        }
    }

    private fun downloadChunk(
        url: String,
        start: Long,
        end: Long,
        channel: java.nio.channels.FileChannel,
        downloadedBytes: java.util.concurrent.atomic.AtomicLong,
        totalBytes: Long,
        onProgress: (Int) -> Unit,
    ) {
        val request = Request.Builder().url(url).header("Range", "bytes=$start-$end").build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw java.io.IOException("Chunk download failed: ${response.code}")
            val body = response.body ?: throw java.io.IOException("Empty chunk response body.")

            var position = start
            var lastReportedPercent = -1
            body.byteStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    // FileChannel.write(buffer, position) writes at an absolute offset without
                    // touching the channel's shared cursor — safe to call concurrently from
                    // multiple chunk-download coroutines at once, no locking needed.
                    channel.write(java.nio.ByteBuffer.wrap(buffer, 0, read), position)
                    position += read
                    val newTotal = downloadedBytes.addAndGet(read.toLong())
                    val percent = ((newTotal * 100) / totalBytes).toInt()
                    if (percent != lastReportedPercent) {
                        lastReportedPercent = percent
                        onProgress(percent)
                    }
                }
            }
        }
    }

    private fun downloadSingleStream(url: String, target: File, onProgress: (Int) -> Unit) {
        val request = Request.Builder().url(url).build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw java.io.IOException("HTTP ${response.code} while downloading.")
            val body = response.body ?: throw java.io.IOException("Empty response body.")
            val total = body.contentLength()
            var downloaded = 0L
            var lastReportedPercent = -1

            body.byteStream().use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        if (total > 0) {
                            val percent = ((downloaded * 100) / total).toInt()
                            if (percent != lastReportedPercent) {
                                lastReportedPercent = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Marks an item CANCELED. A download that's already mid-flight this instant can't be
     * aborted immediately this way — it takes effect on the item's next processing step (or
     * immediately, if it's still QUEUED/RESOLVING). A true mid-download abort would mean
     * tracking the active OkHttp `Call` per item and calling `.cancel()` on it — a reasonable
     * follow-up if that granularity matters later.
     */
    suspend fun cancel(itemId: String) = withContext(Dispatchers.IO) {
        queueDao.findById(itemId)?.let { item ->
            queueDao.update(item.copy(status = DownloadStatus.CANCELED))
        }
    }

    companion object {
        // Sentinel distinguishing "just expanded a playlist, loop and claim again" from "queue
        // is genuinely empty" without a third claimNext return type.
        private val EXPANDED_MARKER = DownloadQueueItemEntity(
            id = "__expanded__", youtubeUrl = "", orderIndex = -1, addedAt = 0L,
        )

        private const val CHUNK_COUNT = 8
        private const val MIN_BYTES_FOR_PARALLEL_DOWNLOAD = 512 * 1024L // below this, chunking overhead isn't worth it
    }
}
