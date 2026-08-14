package com.embyrlabs.atlas.network

import kotlinx.serialization.Serializable

@Serializable
data class SignupRequest(val username: String, val email: String, val password: String)

@Serializable
data class LoginRequest(val email: String, val password: String, val deviceName: String? = null)

@Serializable
data class SessionTokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long? = null,
)

@Serializable
data class SignupResponse(
    val userId: String,
    val username: String,
    val email: String,
    val session: SessionTokens? = null,
)

@Serializable
data class LoginResponse(
    val account: Account,
    val session: SessionTokens,
)

@Serializable
data class Account(
    val user_id: String,
    val username: String,
    val email: String,
    val role: String,
    val status: String,
    val products_owned: List<String> = emptyList(),
    val email_verified: Boolean = false,
)

@Serializable
data class AccountMeResponse(
    val account: Account,
    val sparkCodes: List<SparkCode> = emptyList(),
)

@Serializable
data class SparkCode(
    val code: String,
    val product: String,
    val status: String,
    val is_trial: Boolean = false,
    val trial_expiry_date: String? = null,
    val license_tier: String? = null,
    val expiration_date: String? = null,
)

@Serializable
data class RedeemSparkCodeRequest(val code: String, val hardwareId: String? = null)

@Serializable
data class RedeemSparkCodeResponse(val sparkCode: SparkCode)

@Serializable
data class RequestPasswordResetRequest(val email: String)

@Serializable
data class UpdateUsernameRequest(val username: String)

@Serializable
data class UpdateUsernameResponse(val account: Account)

@Serializable
data class Session(
    val session_id: String,
    val device_name: String? = null,
    val ip_address: String? = null,
    val created_at: String,
    val last_active_at: String,
)

@Serializable
data class SessionsResponse(val sessions: List<Session> = emptyList())

@Serializable
data class ApiError(val error: String)
