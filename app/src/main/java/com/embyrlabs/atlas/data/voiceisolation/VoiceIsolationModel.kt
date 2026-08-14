package com.embyrlabs.atlas.data.voiceisolation

/**
 * Model source and shape constants for on-device Voice Isolation/Removal.
 *
 * Reverted back to this (Demucs, htdemucs, fp16 ONNX) after a Spleeter attempt — smaller,
 * faster, but the actual separated audio quality came back unacceptable. See SETUP.md's Voice
 * Isolation section for the full back-and-forth (Demucs -> too slow -> quantization made it
 * worse, not better -> tried Spleeter -> quality was worse, not just different -> back here).
 *
 * Meta's own Demucs repo only ships PyTorch weights — there is no official Android/ONNX
 * export — so this uses a third-party conversion published by "StemSplit" on Hugging Face
 * (MIT-licensed, not affiliated with Meta). That trust tradeoff was made explicitly with the
 * user rather than assumed; see SETUP.md's Voice Isolation section for the reasoning.
 *
 * The model is NOT bundled in the APK (166MB would roughly double the app's install size) —
 * it's fetched to app-private storage on first use, same download-on-demand pattern already
 * used for tracks themselves (see VoiceIsolationDownloader).
 */
object VoiceIsolationModel {
    const val DOWNLOAD_URL =
        "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx"
    const val FILE_NAME = "htdemucs_fp16weights.onnx"

    // Approximate — used to show download progress as a percentage, not a strict integrity
    // check (the actual stream's Content-Length, when the server reports one, is authoritative).
    const val APPROX_SIZE_BYTES = 166L * 1024 * 1024

    // Fixed model input contract (see the HF repo's README): stereo, 44.1kHz, exactly this many
    // samples per inference call (~7.8s). Source audio is decoded/resampled to match, then
    // split into overlapping segments of this length (see VoiceIsolationEngine).
    const val SAMPLE_RATE = 44_100
    const val SEGMENT_SAMPLES = 343_980
    const val CHANNELS = 2

    // 0.25s crossfade between adjacent segments — long enough to hide the seam without wasting
    // much extra inference time re-processing overlap.
    const val OVERLAP_SAMPLES = SAMPLE_RATE / 4

    // Output stem order the model produces, per the HF repo's documented output shape
    // (1, 4, 2, SEGMENT_SAMPLES).
    val STEM_ORDER = listOf("drums", "bass", "other", "vocals")
}

enum class VoiceIsolationKind { VOCALS, INSTRUMENTAL }
