package com.ryftlabs.atlas.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
enum class DownloadStatus {
    QUEUED, RESOLVING, DOWNLOADING, PAUSED, COMPLETED, FAILED, CANCELED
}

/**
 * One entry in the download queue — either a single video link or one resolved item out of
 * a pasted playlist link (playlist expansion happens at enqueue time, see DownloadEngine).
 * Persisted so the queue survives process death while DownloadService is running.
 */
@Entity(tableName = "download_queue")
@Serializable
data class DownloadQueueItemEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val youtubeUrl: String,
    val status: DownloadStatus = DownloadStatus.QUEUED,
    val progressPercent: Int = 0,
    val resolvedTitle: String? = null,
    val resolvedArtist: String? = null,
    val resolvedThumbnailUrl: String? = null,
    val errorMessage: String? = null,
    val orderIndex: Long,
    val addedAt: Long,
    // Set when this item was enqueued via "download as playlist" — once its track finishes
    // downloading it's linked into this playlist instead of just landing in the plain Library.
    val targetPlaylistId: String? = null,
    // Only meaningful on a not-yet-expanded playlist-link placeholder: whether expansion should
    // create a real Playlist and stamp targetPlaylistId onto the entries it produces.
    val asPlaylist: Boolean = false,
)
