package com.embyrlabs.atlas.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * A single downloaded, locally-playable track. `sourceVideoId` is the YouTube video ID —
 * used as the natural key for play-count tracking and for detecting "already downloaded"
 * before re-queuing a duplicate link.
 *
 * @Serializable (kotlinx.serialization) alongside @Entity (Room) is deliberate — the WebView
 * bridge encodes these directly to JSON for the JS UI rather than hand-building JSONObjects
 * per field for every entity crossing the bridge.
 */
@Entity(
    tableName = "tracks",
    indices = [Index(value = ["sourceVideoId"], unique = true)],
)
@Serializable
data class TrackEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val sourceVideoId: String,
    val sourceUrl: String,
    val title: String,
    val artist: String,
    val durationMs: Long,
    val localFilePath: String,
    val artworkPath: String?,
    val addedAt: Long,
    val playCount: Int = 0,
    val lastPlayedAt: Long? = null,
    val liked: Boolean = false,
    val sortOrder: Long = 0L,
    /** Null = in the Library. Non-null = in Trash, holds the timestamp it was trashed at
     *  (the 30-day retention window and any launch-time purge sweep are measured from this). */
    val trashedAt: Long? = null,
    /** Null = a normally-downloaded track. "VOCALS"/"INSTRUMENTAL" = produced by Voice
     *  Isolation from [derivedFromTrackId] — restore-from-trash re-downloads via sourceUrl for
     *  normal tracks, which doesn't apply here, so derived tracks skip that path (see
     *  WebAppBridge.restoreTrackFromTrash). */
    val derivedKind: String? = null,
    val derivedFromTrackId: String? = null,
    /** The download-time audio quality ("LOW"/"MEDIUM"/"HIGH") — surfaced by the Now Playing
     *  screen's quality indicator. Defaults to "MEDIUM" for tracks downloaded before this field
     *  existed (matches SettingsRepository's own audioQuality default). */
    val qualityLabel: String = "MEDIUM",
    /** The raw YouTube title/uploader at download time — [title]/[artist] get overwritten by
     *  library.rename, but these never do. Lyrics search matches against both this and the
     *  current (possibly renamed) title/artist, since a synced-lyrics provider is far more
     *  likely to have an entry for the original YouTube metadata than a custom rename. Blank
     *  for tracks downloaded before this field existed — the lyrics search just treats a blank
     *  original the same as "no second candidate to try." */
    val originalTitle: String = "",
    val originalArtist: String = "",
    /** False while Idle Compression has removed this track's local audio file to save space
     *  (localFilePath is blank in that state) — the row stays in the Library, still shows up in
     *  every list/search/playlist, just isn't playable offline until it's re-downloaded. Playing
     *  or queuing a track in this state automatically triggers that re-download (see
     *  QueueManager). Distinct from [trashedAt]: a compressed track is still very much "in your
     *  library," just not currently taking up disk space. */
    val isDownloaded: Boolean = true,
)
