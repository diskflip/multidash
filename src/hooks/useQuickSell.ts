import { useEffect, useRef, useState } from 'react';
import { submitQuickTrade } from '../lib/botControl';
import { quickAction, quickOrder, type QuickTradeStatus } from '../lib/quickTrade';

export function useQuickSell(symbol: string, status: QuickTradeStatus | null, canSubmit: boolean) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const context = `${status?.ticker ?? ''}:${status?.quick?.position_id ?? ''}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => { setError(null); }, [context]);
  const action = quickAction(status);
  const disabled = !canSubmit || action !== 'sell' || pending;
  const submit = async () => {
    if (disabled || busy.current || !status) return;
    const clickedContext = context;
    busy.current = true;
    setPending(true); setError(null);
    try {
      // One UUID per deliberate click; HTTP retries keep this exact body.
      await submitQuickTrade(symbol, quickOrder(status, crypto.randomUUID()), false);
    } catch (cause) {
      if (currentContext.current === clickedContext) setError((cause as Error).message);
    } finally { busy.current = false; setPending(false); }
  };
  return { disabled, pending, submit, error: error ?? (status?.quick?.action === 'sell' ? status.quick.error : null) };
}
