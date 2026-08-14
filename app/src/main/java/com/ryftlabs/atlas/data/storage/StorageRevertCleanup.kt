package com.ryftlabs.atlas.data.storage

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import com.ryftlabs.atlas.data.db.AtlasDatabase
import com.ryftlabs.atlas.data.db.TrackEntity
import com.ryftlabs.atlas.data.settings.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.io.File

/**
 * One-time cleanup for a prior version of this app that briefly wrote downloaded audio/artwork
 * into public MediaStore storage (Music/Ryft, Pictures/Ryft) instead of app-private storage, in
 * an experiment to survive uninstall/reinstall — reverted. That experiment had two real bugs:
 *
 * 1. Artwork written into `MediaStore.Images` is exactly the collection gallery apps scan, so
 *    every downloaded track's thumbnail was showing up in the user's camera roll. There's no
 *    flag that keeps a MediaStore.Images row invisible to gallery apps — using that collection
 *    at all was the mistake.
 * 2. A companion "rebuild the library from MediaStore after a reinstall" scanner derived a
 *    track's identity by parsing the video id back out of the MediaStore file's DISPLAY_NAME —
 *    MediaStore can silently rename files on insert (collision avoidance / sanitizing), which
 *    corrupts that derived id and made the scanner treat an already-downloaded song as new,
 *    inserting a second Library row for it (Room's own unique constraint on sourceVideoId
 *    prevents a literal duplicate row for the *same* id, but a corrupted, different-looking id
 *    sails right past that).
 *
 * This runs once per install (see [SettingsRepository.storageRevertCleanupDone]) and:
 *  - Pulls any track/artwork file still living in MediaStore back into app-private storage,
 *    updating the Room row in place, then deletes the MediaStore entry for real — not hidden,
 *    gone, which is what actually removes it from the camera roll.
 *  - Merges duplicate Library rows for what's the same song (matched by title+artist+duration,
 *    since their sourceVideoId can differ after the corruption above), keeping the older row and
 *    re-pointing any playlist membership the newer duplicate had onto it before deleting it.
 *  - Sweeps any leftover files in Music/Ryft or Pictures/Ryft that no Track row references at
 *    all anymore — nothing in this app writes there any more (see DownloadEngine), so anything
 *    still there is debris from the reverted experiment.
 */
object StorageRevertCleanup {
    private const val TAG = "StorageRevertCleanup"

    data class Result(val movedCount: Int, val removedDuplicates: Int)

    suspend fun cleanupIfNeeded(context: Context): Result = withContext(Dispatchers.IO) {
        val settings = SettingsRepository(context)
        if (settings.storageRevertCleanupDone.first()) return@withContext Result(0, 0)
        val result = runCatching { cleanup(context) }
            .onFailure { Log.w(TAG, "Storage revert cleanup failed — will retry next launch", it) }
            .getOrNull()
        // Only mark done on a clean run, same reasoning as the migration this replaces: a
        // failure partway through should retry next launch rather than silently giving up.
        if (result != null) settings.setStorageRevertCleanupDone(true)
        result ?: Result(0, 0)
    }

    private suspend fun cleanup(context: Context): Result {
        val trackDao = AtlasDatabase.get(context).trackDao()
        val playlistDao = AtlasDatabase.get(context).playlistDao()
        val tracksDir = File(context.filesDir, "tracks").apply { mkdirs() }
        val artworkDir = File(context.filesDir, "artwork").apply { mkdirs() }

        var movedCount = 0

        // Pass 1: pull anything MediaStore-backed back into private storage, per Track row.
        val allTracks = trackDao.allLibraryTracks() + trackDao.allTrashTracks()
        allTracks.forEach { track ->
            var changed = false
            var newAudioPath = track.localFilePath
            var newArtPath = track.artworkPath

            if (track.localFilePath.startsWith("content://")) {
                pullBackToInternal(context, track.localFilePath, File(tracksDir, "${track.id}.m4a"))?.let {
                    newAudioPath = it
                    changed = true
                    movedCount++
                }
            }
            track.artworkPath?.takeIf { it.startsWith("content://") }?.let { artPath ->
                pullBackToInternal(context, artPath, File(artworkDir, "${track.id}.jpg"))?.let {
                    newArtPath = it
                    changed = true
                    movedCount++
                }
            }
            if (changed) {
                runCatching { trackDao.update(track.copy(localFilePath = newAudioPath, artworkPath = newArtPath)) }
            }
        }

        // Pass 2: merge duplicate rows for the same song. Matched by (title, artist, duration)
        // rather than sourceVideoId — sourceVideoId is exactly the field the scanner bug could
        // corrupt, so it can't be trusted to tell real duplicates apart from each other here.
        val removedDuplicates = mergeDuplicates(trackDao, playlistDao)

        // Pass 3: sweep anything left in this app's MediaStore folders that no Track row
        // references anymore (already-deleted duplicates' files, partial migrations, etc).
        removeOrphanedMediaStoreEntries(context)

        return Result(movedCount, removedDuplicates)
    }

    private suspend fun mergeDuplicates(
        trackDao: com.ryftlabs.atlas.data.db.TrackDao,
        playlistDao: com.ryftlabs.atlas.data.db.PlaylistDao,
    ): Int {
        val library = trackDao.allLibraryTracks()
        val groups = library.groupBy { Triple(it.title, it.artist, it.durationMs) }
        var removed = 0
        groups.values.filter { it.size > 1 }.forEach { group ->
            val sorted = group.sortedBy { it.addedAt }
            val keep = sorted.first()
            sorted.drop(1).forEach { dup: TrackEntity ->
                playlistDao.reassignTrackId(dup.id, keep.id)
                if (dup.localFilePath.isNotBlank()) runCatching { File(dup.localFilePath).delete() }
                dup.artworkPath?.let { runCatching { File(it).delete() } }
                trackDao.delete(dup)
                removed++
            }
        }
        return removed
    }

    private fun pullBackToInternal(context: Context, contentUriString: String, destFile: File): String? =
        runCatching {
            val uri = Uri.parse(contentUriString)
            val stream = context.contentResolver.openInputStream(uri) ?: return null
            stream.use { input -> destFile.outputStream().use { output -> input.copyTo(output) } }
            context.contentResolver.delete(uri, null, null)
            destFile.absolutePath
        }.getOrNull()

    private fun removeOrphanedMediaStoreEntries(context: Context) {
        runCatching {
            val resolver = context.contentResolver
            resolver.delete(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?", arrayOf("Music/Ryft/%"))
            resolver.delete(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?", arrayOf("Pictures/Ryft/%"))
        }
    }
}
