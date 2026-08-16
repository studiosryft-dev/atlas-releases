package com.ryftlabs.atlas.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import java.util.UUID

@Entity(tableName = "playlists")
@Serializable
data class PlaylistEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val name: String,
    /** A preset id (e.g. "aurora", "ember") drawn procedurally by PlaylistArtwork, or the
     *  literal string "custom" when customArtworkPath is set instead. */
    val artworkMode: String = DEFAULT_PRESET,
    val customArtworkPath: String? = null,
    val animated: Boolean = true,
    val createdAt: Long,
    val sortOrder: Long = 0L,
    /** Bumped once per Play/Shuffle from the Playlist Detail screen (see WebAppBridge's
     *  playback.playQueue/playShuffled — only when a playlistContextId is present), not per
     *  track — playing the same playlist through to the end counts once, matching what "times
     *  played" means to a listener rather than a raw per-track play tally. */
    val playCount: Long = 0L,
) {
    companion object {
        const val DEFAULT_PRESET = "aurora"
    }
}
