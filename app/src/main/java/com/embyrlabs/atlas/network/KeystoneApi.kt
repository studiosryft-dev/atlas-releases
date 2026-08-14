package com.embyrlabs.atlas.network

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path

interface KeystoneApi {

    @POST("auth/signup")
    suspend fun signup(@Body body: SignupRequest): Response<SignupResponse>

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): Response<LoginResponse>

    @POST("auth/logout")
    suspend fun logout(@Header("Authorization") bearerToken: String): Response<Unit>

    @POST("auth/request-password-reset")
    suspend fun requestPasswordReset(@Body body: RequestPasswordResetRequest): Response<Unit>

    @GET("account/me")
    suspend fun getMe(@Header("Authorization") bearerToken: String): Response<AccountMeResponse>

    @PATCH("account/me")
    suspend fun updateUsername(
        @Header("Authorization") bearerToken: String,
        @Body body: UpdateUsernameRequest,
    ): Response<UpdateUsernameResponse>

    @DELETE("account/me")
    suspend fun deleteAccount(@Header("Authorization") bearerToken: String): Response<Unit>

    @GET("account/sessions")
    suspend fun getSessions(@Header("Authorization") bearerToken: String): Response<SessionsResponse>

    @POST("account/sessions/{id}/revoke")
    suspend fun revokeSession(
        @Header("Authorization") bearerToken: String,
        @Path("id") sessionId: String,
    ): Response<Unit>

    @POST("spark-codes/redeem")
    suspend fun redeemSparkCode(
        @Header("Authorization") bearerToken: String,
        @Body body: RedeemSparkCodeRequest,
    ): Response<RedeemSparkCodeResponse>
}
