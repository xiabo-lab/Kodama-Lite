import { useAudioEngine } from "@/lib/audioEngine";

/**
 * Renders nothing. Exists purely to host `useAudioEngine`'s subscriptions
 * (notably `position`, which updates up to ~60 times a second) in their
 * own leaf component — so that high-frequency churn reconciles an empty
 * tree instead of forcing a diff over the sidebar/top bar/screen content
 * on every tick.
 */
export function AudioEngine() {
  useAudioEngine();
  return null;
}
