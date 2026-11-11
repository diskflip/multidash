import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

type HoverSyncState = {
  // Unix seconds. Only meaningful while shiftHeld — a chart hovered without
  // Shift never publishes here, so other charts stay on their own local
  // hover state.
  hoverTime: number | null;
  setHoverTime: (time: number | null) => void;
  shiftHeld: boolean;
};

const HoverSyncContext = createContext<HoverSyncState | null>(null);

// Lets every chart share one hovered timestamp while Shift is held, so
// holding Shift and moving over one market's chart drops a matching time
// marker on every other enabled market's chart — compare prices across
// symbols at the same instant instead of eyeballing separate charts.
export function HoverSyncProvider({ children }: { children: ReactNode }) {
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    // Releasing Shift also drops the synced marker immediately — otherwise
    // it would sit frozen on every other chart until the next mousemove.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftHeld(false);
        setHoverTime(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <HoverSyncContext.Provider value={{ hoverTime, setHoverTime, shiftHeld }}>
      {children}
    </HoverSyncContext.Provider>
  );
}

export function useHoverSync(): HoverSyncState {
  const ctx = useContext(HoverSyncContext);
  if (!ctx) throw new Error("useHoverSync must be used within a HoverSyncProvider");
  return ctx;
}
