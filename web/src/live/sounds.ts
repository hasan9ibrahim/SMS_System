// Alert sounds (§13.6): one per severity, chosen from a short list and synthesised with Web Audio,
// so nothing is downloaded. Browsers allow sound only after the user has interacted with the page.
import type { AlertSoundPrefs } from "@sms/contract";

export type SoundKey = AlertSoundPrefs["info"];
export const SOUNDS: { key: SoundKey; label: string }[] = [
  { key: "none", label: "No sound" },
  { key: "chime", label: "Chime" },
  { key: "ping", label: "Ping" },
  { key: "beep", label: "Beep" },
  { key: "siren", label: "Siren" },
];

// Notes as [frequency Hz, start s, length s].
const SHAPES: Record<Exclude<SoundKey, "none">, { wave: OscillatorType; notes: [number, number, number][] }> = {
  chime: {
    wave: "sine",
    notes: [
      [880, 0, 0.35],
      [1318.5, 0.18, 0.5],
    ],
  },
  ping: { wave: "sine", notes: [[1568, 0, 0.25]] },
  beep: {
    wave: "square",
    notes: [
      [1000, 0, 0.12],
      [1000, 0.2, 0.12],
    ],
  },
  siren: {
    wave: "sawtooth",
    notes: [
      [660, 0, 0.25],
      [880, 0.25, 0.25],
      [660, 0.5, 0.25],
      [880, 0.75, 0.25],
    ],
  },
};

let ctx: AudioContext | null = null;

export function playSound(key: SoundKey) {
  if (key === "none" || typeof window === "undefined" || !("AudioContext" in window)) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const shape = SHAPES[key];
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, start, len] of shape.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = shape.wave;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(shape.wave === "sine" ? 0.25 : 0.08, t0 + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.05);
    }
  } catch {
    // No audio device or blocked: the pop-up still shows.
  }
}
