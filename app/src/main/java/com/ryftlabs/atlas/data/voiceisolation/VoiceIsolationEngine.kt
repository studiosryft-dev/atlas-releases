package com.ryftlabs.atlas.data.voiceisolation

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import com.ryftlabs.atlas.data.db.AtlasDatabase
import com.ryftlabs.atlas.data.db.TrackEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.UUID
import kotlin.math.ceil

private data class DecodedAudio(val left: FloatArray, val right: FloatArray, val sampleRate: Int)

/**
 * Runs the on-device Demucs ONNX model over a downloaded track and produces Vocals-only and/or
 * Instrumental-only derivative tracks. Whole pipeline: decode (MediaCodec) -> resample to
 * 44.1kHz if needed -> upmix mono to stereo if needed -> windowed inference with crossfade
 * overlap-add reconstruction -> encode to WAV -> insert as new Library tracks.
 *
 * Memory note: this holds the full decoded track and the full requested-stem output in memory
 * at once (no streaming reconstruction to disk) — for a ~4 minute stereo track at 44.1kHz that's
 * on the order of 150-250MB depending on how many stems are requested. Fine on most modern
 * phones with `android:largeHeap` (see AndroidManifest.xml), but a genuinely long track on a
 * low-RAM device could OOM — flagged here rather than silently risking a crash going unexplained.
 * A disk-backed streaming reconstruction would be the fix if that turns out to matter in practice.
 */
class VoiceIsolationEngine(private val context: Context) {

    private val downloader = VoiceIsolationDownloader(context)
    private val db = AtlasDatabase.get(context)
    private val trackDao = db.trackDao()
    private val outputDir get() = File(context.filesDir, "tracks").apply { mkdirs() }

    fun isModelReady() = downloader.isModelReady()

    suspend fun downloadModel(onProgress: (Int) -> Unit) = downloader.download(onProgress)

    suspend fun separate(
        sourceTrackId: String,
        kinds: Set<VoiceIsolationKind>,
        onProgress: (Int) -> Unit,
    ): List<TrackEntity> = withContext(Dispatchers.Default) {
        if (!downloader.isModelReady()) throw IOException("Voice Isolation model isn't downloaded yet.")
        if (kinds.isEmpty()) throw IllegalArgumentException("Pick at least one of Vocals/Instrumental.")

        val sourceTrack = trackDao.findById(sourceTrackId) ?: throw IOException("Track not found.")
        if (!sourceTrack.isDownloaded || sourceTrack.localFilePath.isBlank()) {
            throw IOException("This track isn't downloaded right now — play it once first so it re-downloads, then try Voice Isolation again.")
        }
        val decoded = decodeToPcm(File(sourceTrack.localFilePath))
        val (left, right) = resampleStereoIfNeeded(decoded)
        val totalSamples = left.size

        val segmentLength = VoiceIsolationModel.SEGMENT_SAMPLES
        val overlap = VoiceIsolationModel.OVERLAP_SAMPLES
        val stride = segmentLength - overlap
        val weights = buildCrossfadeWeights(segmentLength, overlap)
        val paddedLength = totalSamples + segmentLength

        val wantVocals = VoiceIsolationKind.VOCALS in kinds
        val wantInstrumental = VoiceIsolationKind.INSTRUMENTAL in kinds
        val vocalsAccum = if (wantVocals) Array(2) { FloatArray(paddedLength) } else null
        val instrumentalAccum = if (wantInstrumental) Array(2) { FloatArray(paddedLength) } else null
        val weightAccum = FloatArray(paddedLength)

        val vocalsStemIndex = VoiceIsolationModel.STEM_ORDER.indexOf("vocals")
        val instrumentalStemIndices = listOf("drums", "bass", "other").map { VoiceIsolationModel.STEM_ORDER.indexOf(it) }

        val env = OrtEnvironment.getEnvironment()
        val session = env.createSession(downloader.modelFile.absolutePath, buildSessionOptions())
        val inputName = session.inputNames.iterator().next()
        val outputName = session.outputNames.iterator().next()

        val numSegments = ceil(totalSamples.toDouble() / stride).toInt().coerceAtLeast(1)
        var segIndex = 0
        var position = 0

        try {
            while (position < totalSamples) {
                val inputData = FloatArray(2 * segmentLength)
                val available = (totalSamples - position).coerceAtMost(segmentLength)
                System.arraycopy(left, position, inputData, 0, available)
                System.arraycopy(right, position, inputData, segmentLength, available)

                OnnxTensor.createTensor(env, FloatBuffer.wrap(inputData), longArrayOf(1, 2, segmentLength.toLong())).use { inputTensor ->
                    session.run(mapOf(inputName to inputTensor)).use { result ->
                        @Suppress("UNCHECKED_CAST")
                        val output = result.get(outputName).get().value as Array<Array<Array<FloatArray>>> // [batch][stem][channel][sample]

                        if (wantVocals) accumulateStem(output[0][vocalsStemIndex], vocalsAccum!!, position, weights, segmentLength)
                        if (wantInstrumental) {
                            for (stemIdx in instrumentalStemIndices) {
                                accumulateStem(output[0][stemIdx], instrumentalAccum!!, position, weights, segmentLength)
                            }
                        }
                    }
                }
                for (i in 0 until segmentLength) weightAccum[position + i] += weights[i]

                segIndex++
                onProgress(((segIndex * 100) / numSegments).coerceIn(0, 99))
                position += stride
            }
        } finally {
            session.close()
        }

        normalize(vocalsAccum, weightAccum, totalSamples)
        normalize(instrumentalAccum, weightAccum, totalSamples)

        val results = mutableListOf<TrackEntity>()
        if (wantVocals) results += writeStemTrack(sourceTrack, vocalsAccum!!, totalSamples, VoiceIsolationKind.VOCALS)
        if (wantInstrumental) results += writeStemTrack(sourceTrack, instrumentalAccum!!, totalSamples, VoiceIsolationKind.INSTRUMENTAL)

        onProgress(100)
        results
    }

    private fun accumulateStem(stemOutput: Array<FloatArray>, accum: Array<FloatArray>, position: Int, weights: FloatArray, segmentLength: Int) {
        for (ch in 0 until 2) {
            val channelData = stemOutput[ch]
            val dest = accum[ch]
            for (i in 0 until segmentLength) {
                dest[position + i] += channelData[i] * weights[i]
            }
        }
    }

    private fun normalize(accum: Array<FloatArray>?, weightAccum: FloatArray, totalSamples: Int) {
        if (accum == null) return
        for (ch in 0 until 2) {
            for (i in 0 until totalSamples) {
                val w = weightAccum[i]
                if (w > 1e-6f) accum[ch][i] /= w
            }
        }
    }

    private fun buildCrossfadeWeights(segmentLength: Int, overlap: Int): FloatArray {
        val w = FloatArray(segmentLength) { 1f }
        for (i in 0 until overlap) {
            val ramp = (i + 1).toFloat() / (overlap + 1)
            w[i] = ramp
            w[segmentLength - 1 - i] = ramp
        }
        return w
    }

    /**
     * Running full-precision htdemucs on CPU with no acceleration configured is genuinely slow —
     * this stacks every acceleration option ONNX Runtime's Android build actually exposes,
     * each wrapped independently since none of them are guaranteed present on a given device/
     * build and a missing one should degrade, not crash:
     *  1. NNAPI — hands whichever ops it supports off to a hardware accelerator (GPU/DSP/NPU)
     *     via Android's Neural Networks API, when the device exposes one.
     *  2. XNNPACK — hand-optimized SIMD CPU kernels, independent of NNAPI; ops NNAPI didn't
     *     take (or that run on a device with no NNAPI accelerator at all) fall through to this
     *     rather than the plain reference CPU EP. Registering both isn't redundant — ONNX
     *     Runtime assigns each op in the graph to the first registered EP that supports it, so
     *     a partially-NNAPI-supported graph still gets XNNPACK speed on the rest instead of
     *     silently falling all the way back to unoptimized CPU.
     *  3. Explicit intra-op thread count — the default Java API session doesn't opportunistically
     *     use all cores on every device/ORT build, so this pins it directly.
     * Whatever's left after 1 and 2 runs on the plain CPU EP, which is always implicitly present.
     */
    private fun buildSessionOptions(): OrtSession.SessionOptions {
        val options = OrtSession.SessionOptions()
        options.setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceAtLeast(1))
        try {
            options.addNnapi()
        } catch (e: Exception) {
            Log.w("VoiceIsolationEngine", "NNAPI unavailable on this device, skipping.", e)
        }
        try {
            options.addXnnpack(emptyMap())
        } catch (e: Exception) {
            Log.w("VoiceIsolationEngine", "XNNPACK unavailable in this ONNX Runtime build, skipping.", e)
        }
        return options
    }

    private suspend fun writeStemTrack(
        sourceTrack: TrackEntity,
        stereo: Array<FloatArray>,
        totalSamples: Int,
        kind: VoiceIsolationKind,
    ): TrackEntity {
        val trackId = UUID.randomUUID().toString()
        val outFile = File(outputDir, "$trackId.wav")
        writeWavStereo(outFile, stereo[0], stereo[1], totalSamples, VoiceIsolationModel.SAMPLE_RATE)

        val suffix = if (kind == VoiceIsolationKind.VOCALS) "Vocals" else "Instrumental"
        val nextSort = (trackDao.maxSortOrder() ?: 0L) + 1
        val track = TrackEntity(
            id = trackId,
            sourceVideoId = "${sourceTrack.sourceVideoId}::${kind.name.lowercase()}::$trackId",
            sourceUrl = sourceTrack.sourceUrl,
            title = "${sourceTrack.title} ($suffix)",
            artist = sourceTrack.artist,
            durationMs = sourceTrack.durationMs,
            localFilePath = outFile.absolutePath,
            artworkPath = sourceTrack.artworkPath,
            addedAt = System.currentTimeMillis(),
            sortOrder = nextSort,
            derivedKind = kind.name,
            derivedFromTrackId = sourceTrack.id,
        )
        trackDao.insert(track)
        return track
    }

    // ---------------- decode ----------------

    private fun decodeToPcm(file: File): DecodedAudio {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.absolutePath)

        var trackIndex = -1
        var format: MediaFormat? = null
        for (i in 0 until extractor.trackCount) {
            val f = extractor.getTrackFormat(i)
            val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) { trackIndex = i; format = f; break }
        }
        if (trackIndex == -1 || format == null) throw IOException("No audio track found in this file.")
        extractor.selectTrack(trackIndex)

        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val sourceChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val sourceSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)

        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()

        val pcmOut = ByteArrayOutputStream()
        val bufferInfo = MediaCodec.BufferInfo()
        var sawInputEOS = false
        var sawOutputEOS = false

        try {
            while (!sawOutputEOS) {
                if (!sawInputEOS) {
                    val inIndex = codec.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val inBuffer = codec.getInputBuffer(inIndex)!!
                        val sampleSize = extractor.readSampleData(inBuffer, 0)
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEOS = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }

                val outIndex = codec.dequeueOutputBuffer(bufferInfo, 10_000)
                if (outIndex >= 0) {
                    val outBuffer = codec.getOutputBuffer(outIndex)!!
                    val chunk = ByteArray(bufferInfo.size)
                    outBuffer.get(chunk)
                    outBuffer.clear()
                    pcmOut.write(chunk)
                    codec.releaseOutputBuffer(outIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEOS = true
                }
            }
        } finally {
            codec.stop()
            codec.release()
            extractor.release()
        }

        val pcmBytes = pcmOut.toByteArray()
        val shortBuffer = ByteBuffer.wrap(pcmBytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val totalFrames = shortBuffer.remaining() / sourceChannels
        val left = FloatArray(totalFrames)
        val right = FloatArray(totalFrames)
        for (i in 0 until totalFrames) {
            val l = shortBuffer.get(i * sourceChannels) / 32768f
            val r = if (sourceChannels > 1) shortBuffer.get(i * sourceChannels + 1) / 32768f else l
            left[i] = l
            right[i] = r
        }
        return DecodedAudio(left, right, sourceSampleRate)
    }

    private fun resampleStereoIfNeeded(decoded: DecodedAudio): Pair<FloatArray, FloatArray> {
        if (decoded.sampleRate == VoiceIsolationModel.SAMPLE_RATE) return decoded.left to decoded.right
        return resampleLinear(decoded.left, decoded.sampleRate, VoiceIsolationModel.SAMPLE_RATE) to
            resampleLinear(decoded.right, decoded.sampleRate, VoiceIsolationModel.SAMPLE_RATE)
    }

    /** Basic linear-interpolation resampler — not a proper sinc/polyphase resampler, but source
     *  tracks are already 44.1/48kHz AAC so this only ever bridges a small ratio and the quality
     *  difference is inaudible in practice; flagged as a deliberate simplification, not a bug. */
    private fun resampleLinear(input: FloatArray, fromRate: Int, toRate: Int): FloatArray {
        val ratio = toRate.toDouble() / fromRate.toDouble()
        val outLength = (input.size * ratio).toInt()
        val output = FloatArray(outLength)
        for (i in 0 until outLength) {
            val srcPos = i / ratio
            val srcIndex = srcPos.toInt()
            val frac = (srcPos - srcIndex).toFloat()
            val a = input.getOrElse(srcIndex) { input.last() }
            val b = input.getOrElse(srcIndex + 1) { input.last() }
            output[i] = a + (b - a) * frac
        }
        return output
    }

    // ---------------- WAV encode ----------------

    private fun writeWavStereo(file: File, left: FloatArray, right: FloatArray, totalSamples: Int, sampleRate: Int) {
        val channels = 2
        val bitsPerSample = 16
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val dataSize = totalSamples * blockAlign

        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            // RIFF header
            raf.writeBytes("RIFF")
            raf.write(intLE(36 + dataSize))
            raf.writeBytes("WAVE")
            // fmt chunk
            raf.writeBytes("fmt ")
            raf.write(intLE(16))
            raf.write(shortLE(1)) // PCM
            raf.write(shortLE(channels))
            raf.write(intLE(sampleRate))
            raf.write(intLE(byteRate))
            raf.write(shortLE(blockAlign))
            raf.write(shortLE(bitsPerSample))
            // data chunk
            raf.writeBytes("data")
            raf.write(intLE(dataSize))

            val buffer = ByteBuffer.allocate(dataSize).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until totalSamples) {
                buffer.putShort(floatToPcm16(left[i]))
                buffer.putShort(floatToPcm16(right[i]))
            }
            raf.write(buffer.array())
        }
    }

    private fun floatToPcm16(sample: Float): Short {
        val clamped = sample.coerceIn(-1f, 1f)
        return (clamped * Short.MAX_VALUE).toInt().toShort()
    }

    private fun intLE(v: Int): ByteArray = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array()
    private fun shortLE(v: Int): ByteArray = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(v.toShort()).array()
}
