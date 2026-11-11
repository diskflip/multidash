import { useState } from "react";
import { setBotSwing } from "../lib/botControl";

type Props = {
  symbol: string;
  supported: boolean;
  enabled: boolean;
  canControl: boolean;
};

export function FxSwingToggle({ symbol, supported, enabled, canControl }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported || !["USDJPY", "GBPUSD", "EURUSD"].includes(symbol)) return null;

  return (
    <span className="fx-swing-control" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`bot-toggle-btn fx-swing-toggle ${enabled ? "on" : "off"}`}
        role="switch"
        aria-checked={enabled}
        aria-label={`${symbol} MID`}
        aria-busy={pending}
        disabled={!canControl || pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try { await setBotSwing(symbol, !enabled); }
          catch (err) { setError((err as Error).message); }
          finally { setPending(false); }
        }}
      >
        MID
      </button>
      {error && <span className="fx-swing-error" role="alert">{error}</span>}
    </span>
  );
}
