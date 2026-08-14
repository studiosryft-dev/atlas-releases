package com.ryftlabs.atlas.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface PlaylistDao {

    @Query("SELECT * FROM playlists ORDER BY sortOrder ASC")
    fun observePlaylists(): Flow<List<PlaylistEntity>>

    @Query("SELECT * FROM playlists WHERE id = :id")
    suspend fun getPlaylist(id: String): PlaylistEntity?

    @Query("""
        SELECT tracks.* FROM tracks
        INNER JOIN playlist_track_cross_ref ON tracks.id = playlist_track_cross_ref.trackId
        WHERE playlist_track_cross_ref.playlistId = :playlistId AND tracks.trashedAt IS NULL
        ORDER BY playlist_track_cross_ref.position ASC
    """)
    fun observePlaylistTracks(playlistId: String): Flow<List<TrackEntity>>

    @Query("SELECT COUNT(*) FROM playlist_track_cross_ref WHERE playlistId = :playlistId")
    fun observePlaylistTrackCount(playlistId: String): Flow<Int>

    @Query("SELECT MAX(sortOrder) FROM playlists")
    suspend fun maxSortOrder(): Long?

    @Query("SELECT MAX(position) FROM playlist_track_cross_ref WHERE playlistId = :playlistId")
    suspend fun maxTrackPosition(playlistId: String): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPlaylist(playlist: PlaylistEntity)

    @Update
    suspend fun updatePlaylist(playlist: PlaylistEntity)

    @Delete
    suspend fun deletePlaylist(playlist: PlaylistEntity)

    @Query("UPDATE playlists SET name = :name WHERE id = :id")
    suspend fun rename(id: String, name: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun addTrack(crossRef: PlaylistTrackCrossRef)

    @Query("DELETE FROM playlist_track_cross_ref WHERE playlistId = :playlistId AND trackId = :trackId")
    suspend fun removeTrack(playlistId: String, trackId: String)

    @Query("UPDATE playlist_track_cross_ref SET position = :position WHERE playlistId = :playlistId AND trackId = :trackId")
    suspend fun setTrackPosition(playlistId: String, trackId: String, position: Long)

    @Query("SELECT trackId FROM playlist_track_cross_ref WHERE playlistId = :playlistId ORDER BY position ASC")
    suspend fun trackIdsInOrder(playlistId: String): List<String>

    /** Used by StorageRevertCleanup when merging a duplicate track row into the original it was
     *  duplicated from — repoints any playlist membership the duplicate had onto the kept track
     *  instead of just losing it. OR IGNORE since the kept track could already be in the same
     *  playlist (the (playlistId, trackId) pair is the primary key), in which case there's
     *  nothing more to do for that row — the duplicate's cross-ref gets cleaned up regardless
     *  once the duplicate track itself is deleted (ON DELETE CASCADE). */
    @Query("UPDATE OR IGNORE playlist_track_cross_ref SET trackId = :keepTrackId WHERE trackId = :duplicateTrackId")
    suspend fun reassignTrackId(duplicateTrackId: String, keepTrackId: String)

    /** Used by Settings > Erase Library. Cross-refs first since they reference playlist ids. */
    @Query("DELETE FROM playlist_track_cross_ref")
    suspend fun deleteAllCrossRefs()

    @Query("DELETE FROM playlists")
    suspend fun deleteAllPlaylists()
}
