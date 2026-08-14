package com.embyrlabs.atlas.update

import kotlinx.serialization.Serializable

/** One row from Supabase's `app_releases` table (see supabase-migrations/006_app_releases.sql),
 *  already confirmed newer than the currently-installed build by [UpdateChecker]. */
@Serializable
data class UpdateInfo(
    val version: String,
    val versionCode: Int,
    val apkUrl: String,
    val sizeBytes: Long,
    val releaseNotes: String?,
    val mandatory: Boolean,
)
