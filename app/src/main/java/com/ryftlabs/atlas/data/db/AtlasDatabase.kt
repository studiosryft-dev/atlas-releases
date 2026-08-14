package com.ryftlabs.atlas.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters

class Converters {
    @TypeConverter
    fun statusToString(status: DownloadStatus): String = status.name

    @TypeConverter
    fun stringToStatus(value: String): DownloadStatus = DownloadStatus.valueOf(value)

    @TypeConverter
    fun ownerTypeToString(type: EqualizerOwnerType): String = type.name

    @TypeConverter
    fun stringToOwnerType(value: String): EqualizerOwnerType = EqualizerOwnerType.valueOf(value)
}

@Database(
    entities = [
        TrackEntity::class,
        DownloadQueueItemEntity::class,
        PlaylistEntity::class,
        PlaylistTrackCrossRef::class,
        EqualizerOverrideEntity::class,
        NotificationEntity::class,
    ],
    version = 9,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class AtlasDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao
    abstract fun downloadQueueDao(): DownloadQueueDao
    abstract fun playlistDao(): PlaylistDao
    abstract fun equalizerDao(): EqualizerDao
    abstract fun notificationDao(): NotificationDao

    companion object {
        @Volatile private var instance: AtlasDatabase? = null

        fun get(context: Context): AtlasDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AtlasDatabase::class.java,
                    "atlas.db",
                )
                    // Pre-release app, no shipped data to preserve across schema changes yet —
                    // real Migration objects are worth writing once there's an actual install
                    // base whose local DB matters to keep.
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { instance = it }
            }
    }
}
