import { useCallback, useRef } from "react";

// Web Audio synthesized blips — no asset files needed.
// Two short pleasant tones: "send" (rising) and "receive" (soft chime).

type SoundType = "send" | "receive";

export function useSounds(enabled = true) {
  const ctxRef = useRef<AudioContext | null>(null);

  const getCtx = () => {
    if (typeof window === "undefined") return null;
    if (!ctxRef.current) {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctx) return null;
      ctxRef.current = new Ctx();
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  };

  const play = useCallback(
    (type: SoundType) => {
      if (!enabled) return;
      const ctx = getCtx();
      if (!ctx) return;

      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, now);

      if (type === "send") {
        // Quick rising blip
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.18);
      } else {
        // Two-note soft chime for receive
        const freqs = [660, 990];
        freqs.forEach((f, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = "sine";
          o.frequency.setValueAtTime(f, now + i * 0.08);
          g.gain.setValueAtTime(0, now + i * 0.08);
          g.gain.linearRampToValueAtTime(0.09, now + i * 0.08 + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.25);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(now + i * 0.08);
          o.stop(now + i * 0.08 + 0.28);
        });
      }
    },
    [enabled]
  );

  return { play };
}
