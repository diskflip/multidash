import type {recoveryFeatures} from './recovery.ts';
import type {SettlementInput} from './settlement.ts';
import type { HistoryPoint } from '../../src/types/market.ts';
import type { CurrentMarket } from '../findMarket.ts';
import type { EntryChoice } from '../../src/types/decision.ts';
export type DecisionInput = {
  symbol: string; market: CurrentMarket | null; history: HistoryPoint[];
  score: number | null; flips30m: number; flips1h: number;
  exposed: boolean;
  requested?: boolean;
  settlementInput?: SettlementInput;
};
export type Book = {
  ticker: string; observedAt: number;
  yesBid: number | null; noBid: number | null;
  yesAsk: number | null; noAsk: number | null;
  yesBidDepth: number; noBidDepth: number;
};
export type Features = {
  version: 2 | 3; symbol: string; ticker: string; observedAt: number; closeTime: number;
  secondsLeft: number; score: number | null; flips30m: number; flips1h: number;
  freshness: {
    bookAgeMs: number; quoteAgeMs: number; recentMaxQuoteIntervalMs: number;
    scoreSourceAgeMs: null; scoreFreshness: 'unknown';
    flipCountersMeaning: 'historical_rolling_counts_not_live_signals';
  };
  settlement: {
    rule: 'final_60_second_index_average' | 'unknown';
    averagingWindowSeconds: number | null; elapsedWindowSeconds: number | null;
    source: 'CF_Benchmarks_RTI' | null;
    underlyingPrice: number | null; runningAverage: number | null; strike: number | null;
    strikeType: string | null; roundDigits: number | null;
    sourceTime: number | null; sourceAgeMs: number | null;
    trailing60SecondAverage: number | null; trailingSampleCount: number | null;
    finalMinuteSampleCount: number | null; expectedFinalMinuteSamples: number | null;
    finalMinuteCoverageComplete: boolean; averageStatus: 'available' | 'partial' | 'outside_window' | 'missing_or_stale';
    dataAvailable: boolean;
  };
  recovery?: ReturnType<typeof recoveryFeatures>;
  candidateMovement?: {seconds:number;netCents:number;rangeCents:number}[];
  book: Book;
  movement: { seconds: number; range: number; net: number; travel: number; changes: number }[];
  recentYesBids: { secondsAgo: number; cents: number }[];
  eligibleSides: ('yes' | 'no')[];
  candidateSide: 'yes' | 'no';
  candidateAsk: number;
  historyHasGap: boolean;
};
export type ModelAnswer = {
  promptVersion?: string;
  choice: EntryChoice; confidence: number; reason: string; model: string;
  probabilities: Record<EntryChoice, number>; inputTokens: number; outputTokens: number;
};
export interface DecisionProvider { decide(features: Features): Promise<ModelAnswer> }
