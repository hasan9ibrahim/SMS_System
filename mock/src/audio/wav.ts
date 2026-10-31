// SMS to voice recordings (§8, product owner 2026-10-31): a rule may have its own recording, played in place of "Your
// verification code is". Asterisk plays it as stored, so it is kept as WAV, mono, 8 kHz, 16-bit PCM, at most 1 MB
// (about 65 s). Any PCM WAV (8, 16 or 24-bit, mono or stereo, any sample rate) is accepted and converted: the
// channels are mixed and the audio resampled (windowed-sinc low-pass, so nothing above 4 kHz folds back as noise).
// Anything else is refused with a plain message (WavError).

/** What Asterisk plays. */
export const VOICE_RATE = 8000;
/** The stored file, header included (docs/SMS_TO_VOICE.md). */
export const MAX_STORED_BYTES = 1024 * 1024;
/** The file as uploaded, before conversion. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const HEADER = 44;
/** Longest recording that fits in MAX_STORED_BYTES, in whole seconds (65). */
export const MAX_SECONDS = Math.floor((MAX_STORED_BYTES - HEADER) / (VOICE_RATE * 2));

export class WavError extends Error {}

/** WAVE format tags a compressed file may carry, for the message. */
const COMPRESSED: Record<number, string> = {
  2: "ADPCM",
  6: "A-law",
  7: "µ-law",
  0x11: "IMA ADPCM",
  0x31: "GSM 6.10",
  0x50: "MPEG",
  0x55: "MP3",
};

interface Format {
  channels: number;
  rate: number;
  bits: number;
  blockAlign: number;
}

/** What the uploaded bytes are when they are not a WAV, for the message. */
function notWav(b: Buffer): string {
  const head = b.subarray(0, 4).toString("latin1");
  if (head.startsWith("ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return "This is an MP3 file. Save it as a WAV (PCM) and upload that.";
  if (head === "OggS") return "This is an Ogg file. Save it as a WAV (PCM) and upload that.";
  if (head === "fLaC") return "This is a FLAC file. Save it as a WAV (PCM) and upload that.";
  if (b.subarray(4, 8).toString("latin1") === "ftyp")
    return "This is an M4A / MP4 file. Save it as a WAV (PCM) and upload that.";
  return "This is not a WAV file. Upload a WAV (PCM, 8, 16 or 24-bit).";
}

/** The format and the audio bytes of a PCM WAV, or a WavError saying why it cannot be used. */
export function parseWav(b: Buffer): { format: Format; data: Buffer } {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE")
    throw new WavError(notWav(b));
  let format: Format | null = null;
  let data: Buffer | null = null;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("latin1", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
    if (id === "fmt ") {
      if (body.length < 16) throw new WavError("The WAV file is damaged (its format block is too short).");
      let tag = body.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && body.length >= 26) tag = body.readUInt16LE(24);
      const bits = body.readUInt16LE(14);
      if (tag === 3) throw new WavError(`This WAV holds ${bits}-bit floating-point audio. Save it as 16-bit PCM.`);
      if (tag !== 1)
        throw new WavError(
          `This WAV is compressed (${COMPRESSED[tag] ?? `format ${tag}`}). Save it as an uncompressed PCM WAV.`,
        );
      const channels = body.readUInt16LE(2);
      const rate = body.readUInt32LE(4);
      if (channels < 1 || channels > 2)
        throw new WavError(`This WAV has ${channels} channels. Use a mono or stereo file.`);
      if (![8, 16, 24].includes(bits)) throw new WavError(`This WAV is ${bits}-bit. Use 8, 16 or 24-bit PCM.`);
      if (rate < 1000 || rate > 384000) throw new WavError(`The sample rate ${rate} Hz is not supported.`);
      format = { channels, rate, bits, blockAlign: channels * (bits / 8) };
    } else if (id === "data") {
      data = body;
      if (format) break;
    }
    at += 8 + size + (size % 2);
  }
  if (!format) throw new WavError("The WAV file is damaged (it has no format block).");
  if (!data || data.length < format.blockAlign) throw new WavError("The WAV file holds no audio.");
  return { format, data };
}

/** One sample of a frame as -1 … 1 (8-bit WAV is unsigned, 16 and 24-bit signed little-endian). */
function sampleAt(data: Buffer, offset: number, bits: number): number {
  if (bits === 8) return (data[offset]! - 128) / 128;
  if (bits === 16) return data.readInt16LE(offset) / 32768;
  return data.readIntLE(offset, 3) / 8388608;
}

/** The audio as one channel (the channels averaged), -1 … 1. */
function monoSamples(f: Format, data: Buffer): Float32Array {
  const frames = Math.floor(data.length / f.blockAlign);
  const out = new Float32Array(frames);
  const step = f.bits / 8;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < f.channels; ch++) sum += sampleAt(data, i * f.blockAlign + ch * step, f.bits);
    out[i] = sum / f.channels;
  }
  return out;
}

/**
 * Resamples with a windowed sinc (Blackman window, 16 zero crossings): the low-pass sits at the lower of the two
 * Nyquist frequencies, so downsampling 44.1 kHz to 8 kHz keeps speech and drops what would alias.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice();
  const ratio = from / to;
  const outLength = Math.floor((input.length * to) / from);
  const out = new Float32Array(outLength);
  const cutoff = Math.min(1, to / from);
  const zeros = 16;
  const half = Math.ceil(zeros / cutoff);
  // The kernel sampled STEPS times per input sample, so the inner loop is a lookup (a minute of 44.1 kHz audio takes
  // well under a second).
  const STEPS = 256;
  const kernel = new Float32Array(2 * half * STEPS + 1);
  for (let i = 0; i < kernel.length; i++) {
    const t = i / STEPS - half;
    const x = t * cutoff;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = t / half;
    kernel[i] = sinc * (0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w));
  }
  for (let n = 0; n < outLength; n++) {
    const center = n * ratio;
    const first = Math.max(0, Math.ceil(center - half));
    const last = Math.min(input.length - 1, Math.floor(center + half));
    let sum = 0;
    let weight = 0;
    for (let k = first; k <= last; k++) {
      const h = kernel[Math.round((k - center + half) * STEPS)]!;
      sum += input[k]! * h;
      weight += h;
    }
    out[n] = weight ? sum / weight : 0;
  }
  return out;
}

/** A WAV file holding mono 16-bit PCM samples (-1 … 1, clipped). */
export function wavFile(samples: Float32Array, rate = VOICE_RATE): Buffer {
  const b = Buffer.alloc(HEADER + samples.length * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    b.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), HEADER + i * 2);
  }
  return b;
}

/** Length of a stored recording (mono, 8 kHz, 16-bit, 44-byte header) in milliseconds. */
export const storedDurationMs = (bytes: number) =>
  Math.max(0, Math.round(((bytes - HEADER) / (VOICE_RATE * 2)) * 1000));

/**
 * The recording as the switch stores and Asterisk plays it: mono, 8 kHz, 16-bit PCM WAV, at most 1 MB. Throws a
 * WavError with a plain message for a file that is not a usable PCM WAV or is too long.
 */
export function toVoiceWav(input: Buffer): Buffer {
  if (!input.length) throw new WavError("The file is empty.");
  if (input.length > MAX_UPLOAD_BYTES)
    throw new WavError("The file is larger than 10 MB. Shorten it, or save it as mono 16-bit PCM.");
  const { format, data } = parseWav(input);
  const frames = Math.floor(data.length / format.blockAlign);
  const seconds = frames / format.rate;
  const outFrames = Math.floor((frames * VOICE_RATE) / format.rate);
  if (HEADER + outFrames * 2 > MAX_STORED_BYTES)
    throw new WavError(`The recording is ${seconds.toFixed(1)} s long. It can be at most ${MAX_SECONDS} s.`);
  if (outFrames < 1) throw new WavError("The recording is too short.");
  // Already as stored: the samples are kept as they are behind a plain header, so converting a converted file again
  // gives the same bytes (and the same SHA-256).
  if (format.channels === 1 && format.bits === 16 && format.rate === VOICE_RATE) {
    const out = Buffer.alloc(HEADER + frames * 2);
    wavFile(new Float32Array(0)).copy(out, 0, 0, HEADER);
    out.writeUInt32LE(out.length - 8, 4);
    out.writeUInt32LE(frames * 2, 40);
    data.copy(out, HEADER, 0, frames * 2);
    return out;
  }
  return wavFile(resample(monoSamples(format, data), format.rate, VOICE_RATE));
}
