export type EntryChoice = 'ENTER_YES' | 'ENTER_NO' | 'WAIT';
export type JevDecision = {
  symbol: string;
  ticker: string | null;
  mode: 'shadow';
  status: 'disabled' | 'waiting' | 'ready' | 'unavailable';
  choice: EntryChoice;
  side?: 'yes' | 'no';
  recommendation?: 'YES' | 'NO';
  reason: string;
  confidence: number | null; // Model classification confidence, not measured win probability.
  observedAt: number;
  expiresAt: number;
  latencyMs: number | null;
  model: string | null;
};
