const MUTED_KEY = "flip-monitor:sounds-muted";

// Persisted so a muted session stays muted across reloads.
let muted = localStorage.getItem(MUTED_KEY) === "true";

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  localStorage.setItem(MUTED_KEY, String(next));
}

// Synthesized, not sample-based — a plain sine tone through a gentle
// lowpass reads as a soft analog blip instead of a bright digital chime,
// and it sidesteps the whole "unlock this specific audio element" dance
// mp3 playback needed: an AudioContext just needs resume() once inside a
// real gesture (see armSoundUnlock), and stays usable for the rest of the
// page's life.
let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  // Chrome can force-close an AudioContext on a long-backgrounded/inactive
  // tab (a dashboard like this one gets left open for hours) — reusing a
  // closed context silently does nothing forever after, so a fresh one is
  // created instead of trying to resurrect it.
  if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioContext();
  return audioCtx;
}

// freqEnd !== freqStart glides the pitch over the tone's duration instead
// of holding flat — a quick attack + exponential decay keeps every tone
// short and soft rather than a sustained beep.
//
// resume() is async — scheduling the tone before it resolves would queue
// it into a still-suspended context: no error, it just never becomes
// audible. That's a silent failure mode with no console trace, so it's
// worth guarding against explicitly rather than assuming armSoundUnlock's
// earlier resume() call already landed.
async function playTone(freqStart: number, freqEnd: number, durationMs: number, volume: number) {
  if (muted) return;
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn("[sounds] failed to resume audio context:", err);
      return;
    }
  }
  if (ctx.state !== "running") return;

  const now = ctx.currentTime;
  const duration = durationMs / 1000;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freqStart, now);
  if (freqEnd !== freqStart) {
    osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
  }

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1200;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + duration + 0.02);
}

// A soft, brief rising interval — enough to notice, not a celebration.
export function playWinSound() {
  void playTone(520, 660, 220, 0.32);
}

// A single low, short tick — flatter than the win tone so the two stay
// distinguishable, but still loud enough to actually notice.
export function playBuyInSound() {
  void playTone(320, 320, 90, 0.24);
}

// A short, higher-pitched falling tick — distinct from both trade sounds so
// the 3m/2m/1m countdown warning reads as "pay attention to the clock", not
// "a fill just landed".
export function playCountdownWarnSound() {
  void playTone(880, 760, 90, 0.22);
}

// Fills arrive async over a WebSocket, not from a click, so autoplay
// policy leaves the AudioContext suspended until it's resumed inside a
// real user gesture at least once. Until that first gesture happens, a
// fill that lands has nothing to play with — resume() called from a WS
// handler doesn't count as a gesture, so it just stays suspended, silently.
const UNLOCK_EVENTS = ["pointerdown", "touchend", "keydown", "click"] as const;
const UNLOCK_EVENT_NAME = "flip-monitor:audio-unlocked";

let unlocked = false;
export function isAudioUnlocked(): boolean {
  return unlocked;
}

// Lets UI (see App.tsx) show "sound not armed yet" instead of pretending
// everything's fine when a page load hasn't had a gesture yet.
export function onAudioUnlock(callback: () => void): () => void {
  window.addEventListener(UNLOCK_EVENT_NAME, callback);
  return () => window.removeEventListener(UNLOCK_EVENT_NAME, callback);
}

// Listeners are never removed — a long-backgrounded tab can get its
// AudioContext force-closed by the browser well after the first unlock,
// and getAudioContext() responds by handing back a fresh (suspended) one.
// Without a listener still attached, no later click could ever resume
// that new context and sound would silently die for the rest of the
// session. Re-running resume() on an already-running context is a cheap
// no-op, so keeping these attached costs nothing.
export function armSoundUnlock() {
  const unlock = () => {
    const ctx = getAudioContext();
    ctx.resume().then(() => {
      if (ctx.state === "running" && !unlocked) {
        unlocked = true;
        window.dispatchEvent(new Event(UNLOCK_EVENT_NAME));
      }
    });
  };
  for (const type of UNLOCK_EVENTS) document.addEventListener(type, unlock);
}
