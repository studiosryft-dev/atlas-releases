package com.ryftlabs.atlas.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface DownloadQueueDao {

    @Query("SELECT * FROM download_queue ORDER BY orderIndex ASC")
    fun observeQueue(): Flow<List<DownloadQueueItemEntity>>

    @Query("SELECT * FROM download_queue WHERE status IN ('QUEUED', 'RESOLVING', 'DOWNLOADING') ORDER BY orderIndex ASC LIMIT 1")
    suspend fun nextPending(): DownloadQueueItemEntity?

    @Query("SELECT * FROM download_queue WHERE id = :id")
    suspend fun findById(id: String): DownloadQueueItemEntity?

    @Query("SELECT MAX(orderIndex) FROM download_queue")
    suspend fun maxOrderIndex(): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: DownloadQueueItemEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(items: List<DownloadQueueItemEntity>)

    @Update
    suspend fun update(item: DownloadQueueItemEntity)

    @Delete
    suspend fun delete(item: DownloadQueueItemEntity)

    @Query("UPDATE download_queue SET orderIndex = :orderIndex WHERE id = :id")
    suspend fun reorder(id: String, orderIndex: Long)

    @Query("DELETE FROM download_queue WHERE status = 'COMPLETED'")
    suspend fun clearCompleted()
}
