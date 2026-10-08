/**
 * The show's voices.
 *
 * Turing Games gives every model a persistent TTS voice, which is what makes
 * the cast recognisable with your eyes closed. This repo can't ship ElevenLabs
 * keys, so the voice layer uses the browser's built-in `speechSynthesis`: no
 * network, no key, and every speaker still gets a distinct pitch/rate drawn
 * deterministically from its key, so the same agent always sounds like itself.
 *
 * Only *public* channels are spoken — meeting lines, the ejection verdict and
 * the verdict itself. The confessional stays silent by design: it is the
 * audience's private channel, and saying it out loud would be like reading a
 * diary over the PA.
 */

const STORAGE_KEY = "umbra.voice.v1";

let enabledOverride: boolean | null = null;

/** Speech is available in this runtime (browser, not SSR/validators). */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Voice is on unless it was explicitly switched off in this browser. */
export function loadVoiceEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return false;
  }
}

export function saveVoiceEnabled(on: boolean): void {
  enabledOverride = on;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    }
  } catch {
    // Storage blocked — the toggle still works for this session.
  }
  if (!on && canSpeak()) window.speechSynthesis.cancel();
}

/** Stable 0..N hash so a speaker's voice never changes between lines. */
function seedOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Speak one public line. Silently a no-op when voice is off, speech is
 * unavailable, or the utterance API throws (autoplay policies, disabled
 * voices) — the show must never trip over its own audio.
 */
export function speakLine(text: string, speakerKey: string): void {
  if (!loadVoiceEnabled() || !canSpeak() || !text.trim()) return;
  try {
    const synth = window.speechSynthesis;
    const seed = seedOf(speakerKey);
    const utter = new SpeechSynthesisUtterance(text.slice(0, 400));
    const voices = synth.getVoices();
    if (voices.length > 0) utter.voice = voices[seed % voices.length];
    utter.pitch = 0.8 + (seed % 6) * 0.09;
    utter.rate = 1.03;
    utter.volume = 1;
    synth.speak(utter);
  } catch {
    // Never fatal — the game cares about words, not about audio succeeding.
  }
}

/** Drop anything still queued (a new verdict deserves a clean channel). */
export function clearSpeech(): void {
  if (canSpeak()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}
