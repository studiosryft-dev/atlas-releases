package com.embyrlabs.atlas.data

import android.os.Build
import com.embyrlabs.atlas.network.Account
import com.embyrlabs.atlas.network.AccountMeResponse
import com.embyrlabs.atlas.network.KeystoneApi
import com.embyrlabs.atlas.network.LoginRequest
import com.embyrlabs.atlas.network.RedeemSparkCodeRequest
import com.embyrlabs.atlas.network.RequestPasswordResetRequest
import com.embyrlabs.atlas.network.Session
import com.embyrlabs.atlas.network.SignupRequest
import com.embyrlabs.atlas.network.UpdateUsernameRequest
import kotlinx.serialization.json.Json

sealed class ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>()
    data class Failure(val message: String) : ApiResult<Nothing>()
}

/**
 * Bridges the Keystone API + local session storage for the auth screens. Every call
 * returns [ApiResult] rather than throwing, so the UI layer can render a real error
 * message instead of crashing on a network hiccup.
 */
class AuthRepository(
    private val api: KeystoneApi,
    private val sessionManager: SessionManager,
) {
    private val errorJson = Json { ignoreUnknownKeys = true }

    /** Returns Success(true) if signup also logged the user in, Success(false) if they still need to log in manually. */
    suspend fun signup(username: String, email: String, password: String): ApiResult<Boolean> {
        return try {
            val response = api.signup(SignupRequest(username, email, password))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            val session = body.session
            if (session != null) {
                sessionManager.saveSession(session.accessToken, session.refreshToken, body.userId)
            }
            ApiResult.Success(session != null)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error during signup.")
        }
    }

    suspend fun login(email: String, password: String): ApiResult<Account> {
        return try {
            val response = api.login(LoginRequest(email, password, deviceName = Build.MODEL))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            sessionManager.saveSession(body.session.accessToken, body.session.refreshToken, body.account.user_id)
            ApiResult.Success(body.account)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error during login.")
        }
    }

    suspend fun redeemSparkCode(code: String): ApiResult<Unit> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.redeemSparkCode(bearer(token), RedeemSparkCodeRequest(code))
            if (!response.isSuccessful) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(Unit)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error redeeming Spark Code.")
        }
    }

    suspend fun fetchMe(): ApiResult<Account> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.getMe(bearer(token))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(body.account)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error loading account.")
        }
    }

    /** Like [fetchMe] but also returns the account's linked Spark Codes, for the Account page. */
    suspend fun fetchAccountFull(): ApiResult<AccountMeResponse> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.getMe(bearer(token))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(body)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error loading account.")
        }
    }

    suspend fun updateUsername(username: String): ApiResult<Account> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.updateUsername(bearer(token), UpdateUsernameRequest(username))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(body.account)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error updating username.")
        }
    }

    suspend fun requestPasswordReset(email: String): ApiResult<Unit> {
        return try {
            val response = api.requestPasswordReset(RequestPasswordResetRequest(email))
            if (!response.isSuccessful) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(Unit)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error requesting password reset.")
        }
    }

    suspend fun fetchSessions(): ApiResult<List<Session>> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.getSessions(bearer(token))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(body.sessions)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error loading sessions.")
        }
    }

    suspend fun revokeSession(sessionId: String): ApiResult<Unit> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.revokeSession(bearer(token), sessionId)
            if (!response.isSuccessful) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(Unit)
        } catch (e: Exception) {
            ApiResult.Failure(e.message ?: "Network error revoking session.")
        }
    }

    /** Deletes the account server-side, then clears the local session either way — an
     *  account that failed to delete server-side shouldn't leave the device still "logged in". */
    suspend fun deleteAccount(): ApiResult<Unit> {
        val token = sessionManager.currentAccessToken() ?: return ApiResult.Failure("Not signed in.")
        return try {
            val response = api.deleteAccount(bearer(token))
            sessionManager.clear()
            if (!response.isSuccessful) {
                return ApiResult.Failure(extractError(response.errorBody()?.string()))
            }
            ApiResult.Success(Unit)
        } catch (e: Exception) {
            sessionManager.clear()
            ApiResult.Failure(e.message ?: "Network error deleting account.")
        }
    }

    suspend fun logout() {
        val token = sessionManager.currentAccessToken()
        sessionManager.clear()
        if (token != null) {
            runCatching { api.logout(bearer(token)) }
        }
    }

    private fun bearer(token: String) = "Bearer $token"

    private fun extractError(rawBody: String?): String {
        if (rawBody.isNullOrBlank()) return "Something went wrong."
        return try {
            errorJson.decodeFromString(com.embyrlabs.atlas.network.ApiError.serializer(), rawBody).error
        } catch (e: Exception) {
            rawBody
        }
    }
}
