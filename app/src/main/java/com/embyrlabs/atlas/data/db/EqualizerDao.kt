package com.embyrlabs.atlas.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface EqualizerDao {

    @Query("SELECT * FROM equalizer_overrides WHERE ownerId = :ownerId AND ownerType = :ownerType LIMIT 1")
    fun observeOverride(ownerId: String, ownerType: EqualizerOwnerType): Flow<EqualizerOverrideEntity?>

    @Query("SELECT * FROM equalizer_overrides WHERE ownerId = :ownerId AND ownerType = :ownerType LIMIT 1")
    suspend fun getOverride(ownerId: String, ownerType: EqualizerOwnerType): EqualizerOverrideEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(override: EqualizerOverrideEntity)

    @Delete
    suspend fun delete(override: EqualizerOverrideEntity)

    @Query("DELETE FROM equalizer_overrides WHERE ownerId = :ownerId AND ownerType = :ownerType")
    suspend fun clear(ownerId: String, ownerType: EqualizerOwnerType)
}
