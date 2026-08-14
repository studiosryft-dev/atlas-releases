package com.ryftlabs.atlas.data.storage

import android.content.Context
import android.util.Log
import com.ryftlabs.atlas.data.db.AtlasDatabase
import com.ryftlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Idle Compression — Settings > Downloads. Once a day's worth of app launches (cheap to just run
 * every launch; each check is a handful of Room rows), removes the local audio file for any
 * downloaded Library track that hasn't been played (or, for a never-played track, downloaded)
 * in [SettingsRepository.idleCompressionDays] days. The track itself is untouched otherwise —
 * still shows up in Library, search, and every playlist it belongs to, just isn't playable
 * offline until QueueManager's ensureDownloaded automatically re-fetches it the next time it's
 * played or queued (see QueueManager.playQueue/playShuffled/reAddFromHistory).
 *
 * Deliberately excludes: trashed tracks (already file-less), Voice Isolation derived tracks (no
 * sourceUrl to re-download from — compressing one would be permanent data loss), and anything
 * already compressed (isDownloaded = false already).
 */
object IdleCompressionSweeper {
    private const val TAG = "IdleCompressionSweeper"
    private const val DAY_MS = 24L * 60 * 60 * 1000

    suspend fun sweep(context: Context) = withContext(Dispatchers.IO) {
        runCatching { sweepInternal(context) }
            .onFailure { Log.w(TAG, "Idle compression sweep failed (non-fatal)", it) }
    }

    private suspend fun sweepInternal(context: Context) {
        val settings = SettingsRepository(context)
        if (!settings.idleCompression.first()) return
        val days = settings.idleCompressionDays.first()
        val cutoff = System.currentTimeMillis() - days * DAY_MS

        val trackDao = AtlasDatabase.get(context).trackDao()
        var compressed = 0
        trackDao.allDownloadedLibraryTracks().forEach { track ->
            val lastActivity = track.lastPlayedAt ?: track.addedAt
            if (lastActivity < cutoff) {
                if (track.localFilePath.isNotBlank()) runCatching { File(track.localFilePath).delete() }
                trackDao.markCompressed(track.id)
                compressed++
            }
        }
        if (compressed > 0) Log.i(TAG, "Idle Compression removed $compressed local file(s).")
    }
}
