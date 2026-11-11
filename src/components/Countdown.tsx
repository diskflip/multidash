import { useEffect } from "react";
import { formatRemaining, useCountdown } from "../hooks/useCountdown";

const DEFAULT_TITLE = "multibot";

// Isolates the 1-second tick to this one small leaf component so it doesn't
// re-render the rest of the app every second.
export function Countdown({ closeTime }: { closeTime: number | null }) {
  const { text } = useCountdown(closeTime);
  useTabTitleCountdown(closeTime);
  return <span className="app-countdown">{text}</span>;
}

// Mirrors the countdown into the tab title so it reads from other tabs.
// Ticks from a Web Worker, not the page's own setInterval — Chrome
// throttles a hidden tab's timers down to ~once a minute after 5 minutes,
// which would freeze the title exactly when it's the only thing visible.
function useTabTitleCountdown(closeTime: number | null) {
  useEffect(() => {
    if (closeTime === null) {
      document.title = DEFAULT_TITLE;
      return;
    }
    const update = () => {
      document.title = formatRemaining(Math.max(0, Math.floor(closeTime - Date.now() / 1000)));
    };
    update();
    const workerUrl = URL.createObjectURL(
      new Blob(["setInterval(() => postMessage(0), 1000);"], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    worker.onmessage = update;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      document.title = DEFAULT_TITLE;
    };
  }, [closeTime]);
}
