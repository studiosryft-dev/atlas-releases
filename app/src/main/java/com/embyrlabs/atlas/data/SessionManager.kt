package com.embyrlabs.atlas.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "atlas_session")

/**
 * Persists the EmbyrKeystone access token across app restarts. Phase 1 keeps this simple
 * (plain DataStore, no refresh-token rotation logic yet) — token refresh and secure/
 * encrypted storage are a hardening pass for a later phase, not blocking for getting the
 * auth flow working end-to-end.
 */
class SessionManager(private val context: Context) {

    private object Keys {
        val ACCESS_TOKEN = stringPreferencesKey("access_token")
        val REFRESH_TOKEN = stringPreferencesKey("refresh_token")
        val USER_ID = stringPreferencesKey("user_id")
    }

    val accessTokenFlow: Flow<String?> = context.dataStore.data.map { it[Keys.ACCESS_TOKEN] }
    val userIdFlow: Flow<String?> = context.dataStore.data.map { it[Keys.USER_ID] }

    suspend fun currentAccessToken(): String? = accessTokenFlow.first()

    suspend fun saveSession(accessToken: String, refreshToken: String, userId: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.ACCESS_TOKEN] = accessToken
            prefs[Keys.REFRESH_TOKEN] = refreshToken
            prefs[Keys.USER_ID] = userId
        }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }
}
