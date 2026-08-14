package com.ryftlabs.atlas.data.youtube

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfoItem

@Serializable
enum class AudioQuality { LOW, MEDIUM, HIGH }

@Serializable
data class ResolvedTrack(
    val videoId: String,
    val sourceUrl: String,
    val title: String,
    val artist: String,
    val durationMs: Long,
    val thumbnailUrl: String?,
    val audioStreamUrl: String,
)

/** A lightweight playlist entry — doesn't have an audio stream URL yet, resolving that
 *  requires a second per-video fetch, done lazily when that item's turn comes up in the
 *  download queue (see DownloadEngine) rather than all at once at import time. */
@Serializable
data class PlaylistEntry(
    val videoUrl: String,
    val title: String,
    val artist: String,
)

@Serializable
data class ResolvedPlaylist(val title: String, val entries: List<PlaylistEntry>, val thumbnailUrl: String? = null)

/** One row in an in-app YouTube search result list (Discover page). */
@Serializable
data class YouTubeSearchResult(
    val url: String,
    val title: String,
    val artist: String,
    val durationMs: Long,
    val thumbnailUrl: String?,
)

class YouTubeExtractionException(message: String, cause: Throwable? = null) : Exception(message, cause)

object YouTubeExtractorClient {
    private var initialized = false

    @Synchronized
    private fun ensureInit() {
        if (!initialized) {
            NewPipe.init(NewPipeDownloaderImpl())
            initialized = true
        }
    }

    suspend fun resolveVideo(url: String, quality: AudioQuality): ResolvedTrack = withContext(Dispatchers.IO) {
        ensureInit()
        try {
            val extractor = ServiceList.YouTube.getStreamExtractor(url)
            extractor.fetchPage()

            val audioStreams = extractor.audioStreams
                ?: throw YouTubeExtractionException("No audio streams found for this video.")
            if (audioStreams.isEmpty()) {
                throw YouTubeExtractionException("No audio streams found for this video.")
            }
            val chosen = pickStreamForQuality(audioStreams, quality)

            ResolvedTrack(
                videoId = extractor.id,
                sourceUrl = url,
                title = extractor.name ?: "Unknown Title",
                artist = extractor.uploaderName ?: "Unknown Artist",
                durationMs = extractor.length * 1000L,
                thumbnailUrl = extractor.thumbnails?.maxByOrNull { it.height }?.url,
                audioStreamUrl = chosen.content,
            )
        } catch (e: YouTubeExtractionException) {
            throw e
        } catch (e: Exception) {
            throw YouTubeExtractionException("Couldn't resolve this YouTube link: ${e.message}", e)
        }
    }

    suspend fun resolvePlaylist(url: String): ResolvedPlaylist = withContext(Dispatchers.IO) {
        ensureInit()
        try {
            val extractor = ServiceList.YouTube.getPlaylistExtractor(url)
            extractor.fetchPage()

            // Only the first page is pulled — very large playlists (>~100 items, NewPipeExtractor's
            // typical page size) will be truncated. Pagination via extractor.getPage(nextPage) is
            // a straightforward follow-up if that matters.
            val items = extractor.initialPage.items.map { item ->
                PlaylistEntry(
                    videoUrl = item.url,
                    title = item.name ?: "Unknown Title",
                    artist = item.uploaderName ?: "Unknown Artist",
                )
            }

            ResolvedPlaylist(
                title = extractor.name ?: "Imported Playlist",
                entries = items,
                thumbnailUrl = extractor.thumbnails?.maxByOrNull { it.height }?.url,
            )
        } catch (e: Exception) {
            throw YouTubeExtractionException("Couldn't resolve this YouTube playlist link: ${e.message}", e)
        }
    }

    /** In-app YouTube search for the Discover page — video results only (playlists/channels
     *  filtered out), first results page. */
    suspend fun search(query: String, maxResults: Int = 25): List<YouTubeSearchResult> = withContext(Dispatchers.IO) {
        ensureInit()
        if (query.isBlank()) return@withContext emptyList()
        try {
            val searchExtractor = SearchInfo.getInfo(
                ServiceList.YouTube,
                ServiceList.YouTube.searchQHFactory.fromQuery(query, listOf("videos"), ""),
            )
            searchExtractor.relatedItems
                .filterIsInstance<StreamInfoItem>()
                .take(maxResults)
                .mapNotNull { item ->
                    val url = item.url ?: return@mapNotNull null
                    YouTubeSearchResult(
                        url = url,
                        title = item.name ?: "Untitled",
                        artist = item.uploaderName ?: "Unknown",
                        durationMs = item.duration.coerceAtLeast(0) * 1000L,
                        thumbnailUrl = item.thumbnails?.maxByOrNull { it.height }?.url,
                    )
                }
        } catch (e: Exception) {
            throw YouTubeExtractionException("Search failed: ${e.message}", e)
        }
    }

    private fun pickStreamForQuality(streams: List<AudioStream>, quality: AudioQuality): AudioStream {
        val sorted = streams.sortedBy { it.averageBitrate }
        return when (quality) {
            AudioQuality.LOW -> sorted.first()
            AudioQuality.HIGH -> sorted.last()
            AudioQuality.MEDIUM -> sorted[sorted.size / 2]
        }
    }
}
