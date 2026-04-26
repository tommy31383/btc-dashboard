/**
 * liveAlerts.ts — Browser notifications + sound alerts cho LIVE engine.
 *
 * Web Notification API: hiện toast/badge ngoài app khi ENTRY/CLOSE/SL hit.
 * Web Audio API: beep loud khi SL, chime nhẹ khi TP.
 *
 * Anh Tommy v4.4.8+: muốn biết app đã vào lệnh + cảnh báo khi SL hit.
 */

let permissionRequested = false;

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  if (permissionRequested) return Notification.permission;
  permissionRequested = true;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export interface NotifyParams {
  title: string;
  body: string;
  tag?: string;       // dedup cùng tag → notification cũ bị thay
  urgent?: boolean;   // SL/error → require interaction
}

export function notify(p: NotifyParams): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const opts: NotificationOptions = {
      body: p.body,
      tag: p.tag,
      requireInteraction: p.urgent === true,
      silent: false,
    };
    new Notification(p.title, opts);
  } catch {}
}

// ── Sound alerts (Web Audio API) ────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** Beep sine wave với freq + duration. Volume 0-1. */
function beep(freqHz: number, durationMs: number, volume = 0.3): void {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freqHz;
    osc.type = "sine";
    gain.gain.value = volume;
    // Envelope để tránh click
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.05);
  } catch {}
}

/** SL hit: 3 beep liên tiếp ở 880Hz (loud, urgent). */
export function playSlHit(): void {
  beep(880, 200, 0.5);
  setTimeout(() => beep(880, 200, 0.5), 250);
  setTimeout(() => beep(880, 200, 0.5), 500);
}

/** TP hit: 2 beep ở 660Hz (chime, positive). */
export function playTpHit(): void {
  beep(660, 150, 0.3);
  setTimeout(() => beep(880, 200, 0.3), 180);
}

/** ENTRY: 1 beep ngắn ở 440Hz (notify). */
export function playEntry(): void {
  beep(440, 100, 0.25);
}
