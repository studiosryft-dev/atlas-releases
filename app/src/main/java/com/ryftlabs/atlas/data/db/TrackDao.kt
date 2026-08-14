package com.ryftlabs.atlas.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface TrackDao {

    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL ORDER BY sortOrder ASC")
    fun observeLibrary(): Flow<List<TrackEntity>>

    @Query("SELECT * FROM tracks WHERE trashedAt IS NOT NULL ORDER BY trashedAt DESC")
    fun observeTrash(): Flow<List<TrackEntity>>

    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL AND liked = 1 ORDER BY sortOrder ASC")
    fun observeLiked(): Flow<List<TrackEntity>>

    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL ORDER BY playCount DESC LIMIT 100")
    fun observeMostPlayed(): Flow<List<TrackEntity>>

    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL AND lastPlayedAt IS NOT NULL ORDER BY lastPlayedAt DESC LIMIT 100")
    fun observeRecentlyPlayed(): Flow<List<TrackEntity>>

    @Query("""SELECT * FROM tracks WHERE trashedAt IS NULL AND
        (title LIKE '%' || :query || '%' OR artist LIKE '%' || :query || '%') ORDER BY sortOrder ASC""")
    fun searchLibrary(query: String): Flow<List<TrackEntity>>

    @Query("SELECT * FROM tracks WHERE sourceVideoId = :videoId LIMIT 1")
    suspend fun findByVideoId(videoId: String): TrackEntity?

    @Query("SELECT * FROM tracks WHERE id = :id")
    suspend fun findById(id: String): TrackEntity?

    @Query("SELECT MAX(sortOrder) FROM tracks")
    suspend fun maxSortOrder(): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(track: TrackEntity)

    @Update
    suspend fun update(track: TrackEntity)

    @Delete
    suspend fun delete(track: TrackEntity)

    @Query("UPDATE tracks SET title = :title, artist = :artist WHERE id = :id")
    suspend fun rename(id: String, title: String, artist: String)

    @Query("UPDATE tracks SET artworkPath = :artworkPath WHERE id = :id")
    suspend fun updateArtwork(id: String, artworkPath: String?)

    @Query("UPDATE tracks SET liked = :liked WHERE id = :id")
    suspend fun setLiked(id: String, liked: Boolean)

    @Query("UPDATE tracks SET trashedAt = :trashedAt, localFilePath = '' WHERE id = :id")
    suspend fun moveToTrash(id: String, trashedAt: Long)

    @Query("UPDATE tracks SET trashedAt = NULL, localFilePath = :localFilePath WHERE id = :id")
    suspend fun restoreFromTrash(id: String, localFilePath: String)

    @Query("UPDATE tracks SET playCount = playCount + 1, lastPlayedAt = :playedAt WHERE id = :id")
    suspend fun recordPlay(id: String, playedAt: Long)

    /** Rows trashed before the cutoff — used by the launch-time purge sweep. */
    @Query("SELECT * FROM tracks WHERE trashedAt IS NOT NULL AND trashedAt < :cutoff")
    suspend fun findExpiredTrash(cutoff: Long): List<TrackEntity>

    /** All non-trashed tracks — used by Settings > Erase Library to enumerate what needs
     *  deleting (and whose audio/artwork files need deleting) before wiping the rows. */
    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL")
    suspend fun allLibraryTracks(): List<TrackEntity>

    @Query("DELETE FROM tracks WHERE trashedAt IS NULL")
    suspend fun deleteAllLibraryTracks(): Int

    /** All trashed tracks — used by Library > Trash's "Recover All" / "Delete All". */
    @Query("SELECT * FROM tracks WHERE trashedAt IS NOT NULL")
    suspend fun allTrashTracks(): List<TrackEntity>

    @Query("DELETE FROM tracks WHERE trashedAt IS NOT NULL")
    suspend fun deleteAllTrashTracks(): Int

    /** Every currently-downloaded, in-library, non-derived track — what IdleCompressionSweeper
     *  checks each launch. Derived (Voice Isolation) tracks are excluded since they have no
     *  sourceUrl to re-download from, so compressing one would be an unrecoverable data loss. */
    @Query("SELECT * FROM tracks WHERE trashedAt IS NULL AND isDownloaded = 1 AND derivedKind IS NULL")
    suspend fun allDownloadedLibraryTracks(): List<TrackEntity>

    /** Idle Compression removing a track's local file — same "blank localFilePath" convention
     *  moveToTrash already uses, plus isDownloaded=0 so the UI/redownload-on-play logic can tell
     *  "compressed" apart from "trashed" (trashedAt is still NULL here; it's staying in Library). */
    @Query("UPDATE tracks SET localFilePath = '', isDownloaded = 0 WHERE id = :id")
    suspend fun markCompressed(id: String)

    /** The other half of Idle Compression — re-hydrating a track in place (same row/id, so
     *  playlist membership, liked state, and play history all survive) once its file has been
     *  re-downloaded. */
    @Query("UPDATE tracks SET localFilePath = :localFilePath, isDownloaded = 1 WHERE id = :id")
    suspend fun markRedownloaded(id: String, localFilePath: String)
}
