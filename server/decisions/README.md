# Jev cheaper-side flip trial

Server-side **advisory only**: this integration cannot place orders, toggle LIVE, change budgets, or alter AUTO chart selection.

The JEV panel below SIM shows one row per displayed AUTO market: coin, the cheaper contract side (`YES`/`NO`), a `BUY?` answer (`YES`/`NO`), and `CONF.` from Jev's actual `confidence` field. Confidence is distribution concentration, **not a measured trade win probability**. Missing, stale, or unavailable responses display a dash, not a made-up NO. Outside the last two minutes the panel says `Starts at 2:00`; with AUTO off, it says `AUTO is off`.

## Request scope and cadence

The browser reports only the charts displayed by AUTO over the existing authenticated backend WebSocket. The backend unions all connected viewers' requested symbols and deduplicates work per market. On disconnect, that viewer's interest is removed. Only requested markets with 0 < seconds remaining <= 120 can make book/model requests. Each gets at most one request in flight and a target interval of one second. A slow or failed request is not overlapped or replayed; results are freshness-checked before publication. Both REST/book and model steps have 1.5-second deadlines, and model inputs expire after two seconds. Actual completion cadence depends on network/provider latency and rate limits.

Default caps: 12 concurrent market jobs, 600 model requests/minute shared across viewers, and 7,000 per five-hour session. Session accounting persists through restart. These are request caps, not dollar guarantees; provider billing remains authoritative. Repeated auth/rate-limit failures back off for 60 seconds. Set `JEV_ENABLED=false` to stop the trial. Credentials are only in root `.env`, never a `VITE_` variable. The model defaults to the account-verified `jev-latest` alias; resolved model names and usage are logged.

## Model question and data

We use the documented `choice` primitive with exactly `YES` and `NO` options, plus an independent condition question (`recovering`, `collapsing`, `flat`, `insufficient_evidence`). The entry question asks:

> Should I buy the currently cheaper side, at its current ask, as a potential flip toward 94 cents before this contract closes?

The cheaper side is selected from **actual two-sided executable asks**, not `100 - YES bid`; ties select YES. Both low and high prices are evaluated, not just 7-cent candidates. We show the model's answer and its confidence without silently overriding a low-confidence YES. This is an unvalidated recommendation that makes no automatic trade. Existing orders or holdings do not suppress analysis of a chart the user is viewing.

Inputs: current three-level YES/NO book depth, spreads via bids/asks, remaining time, existing score, 30m/1h paper flip counters, same-contract past-only 10/20/60-second movement summaries and five-second sampled recent YES bids. Earlier gaps are marked; a gap in the last five seconds, stale history over ten seconds, a stale book over two seconds, missing/crossed book, or less than five seconds of usable history prevents a model call. A newer chart quote moving more than 2 cents invalidates a pending response. No credentials, account identifiers, balances, budgets or order IDs go to TypeSafe.

## Modules

- `types.ts`, `features.ts`: input contract and versioned features.
- `book.ts`: read-only Kalshi adapter.
- `jev.ts`: official TypeSafe adapter, structured question and strict response validation.
- `service.ts`: scheduling, request scope, concurrency, freshness and cooldown.
- `budget.ts`, `journal.ts`: persistent daily cap and ordered local logs.
- `evaluation.ts`: forward-only observational comparison.
- `src/hooks/useJev.ts`, `src/components/JevPanel.tsx`: viewer scope and minimal panel.

## Evaluation

Run `node --import tsx scripts/report-jev.ts [optional-log-path]`. Daily files are in `.runtime/jev/`. The report includes actual model latency p50/p95 and input tokens for completed inferences, including discarded stale answers; failed calls are logged separately. Version-2 decisions use the current cheaper-side question; old 7-cent-only decisions are excluded from the new path comparison.

The first decision per side/contract fixes a YES-versus-NO cohort. Only subsequent observations can mark an ask at/below that decision's entry price, then a later bid at/above 94 cents before close. These are **sampled quote paths**, not executed trades, profit, or validated prediction accuracy. A quote touch does not prove fills or sufficient size. Missing data is flagged, and an unobserved target is not a confirmed loss. Viewer selection, first-decision sampling, correlation and nonrandom cohorts can bias results. Observations are collected only during the requested final-two-minute window. Establish execution-aware held-out results before adding a live entry gate to the separate trading backend.

## Official references

Verified 2026-10-03:
- https://api.typesafe.ai/docs
- https://api.typesafe.ai/openapi.json
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/confidence
- https://docs.kalshi.com/api-reference/market/get-market-orderbook

Settlement and freshness: a dedicated authenticated `cfbenchmarks_value` WebSocket supplies all nine crypto indices continuously, at roughly one update per second. `settlement.ts` validates source timestamps, ignores duplicate/out-of-order frames, reconnects with heartbeat checks, and clears cached ticks on disconnect. Source data older than five seconds is omitted. No model calls are made by this feed.

Jev receives the current underlying index, its source age, the separate trailing 60-second average and sample count, and Kalshi's `last_60s_windowed_average_15min` when it matches the current contract's close. The final-minute field is never substituted with the trailing average. Its sample count and coverage are compared to elapsed seconds at the source timestamp; partial coverage is explicitly marked. Contract target, comparison direction, and rounding precision come from the authenticated market endpoint, cached per ticker for up to 60 seconds. Missing fields remain null. Final-minute averages are provisional, not a finalized settlement result.

The prompt recognizes that the backend 1–10 score already incorporates final-minute averaging and avoids treating the same evidence as independent confirmation. Source freshness of that composite score remains unknown. Recent contract observations use one-second buckets without interpolation. Quotes older than five seconds are rejected (books older than two seconds remain rejected); results expire no later than the original quote or supplied index reaching five seconds. Flip counters are historical context.

Reference: https://docs.kalshi.com/websockets/cfbenchmarks-value

The entry question evaluates whether the current cheaper side retains a realistic path toward 94 cents, including underdog opportunities before recovery is established. It does not demand a more-likely-than-not outcome or recommend an immediate buy. YES-bid movement is interpreted in the candidate side’s direction. The panel labels this signal FLIP?.

Recovery inputs (feature version 3): retain up to 61 actual CF index ticks per symbol. Compute 5/10/20/60-second underlying movement and ranges with sample span/gap metadata; positive candidate-direction movement favors the selected side. No interpolation, future ticks, or prior-contract ticks enter these windows. Insufficient or gapped movement is null, not flat.

For complete final-minute coverage, the average needed over the remaining readings to reach the raw strike is `(60 * strike - samples * runningAverage) / (60 - samples)`. Before accumulation it is the strike. Missing coverage, stale inputs, unsupported comparison rules, or no remaining samples disable this arithmetic. A separate rounding-tolerance band acknowledges that the unrounded strike is not the exact rounded settlement boundary. Neither current-price continuation nor observed ranges are predictions or hard speed limits.

`prompt.ts` sends a compact candidate-focused state: contract momentum, underlying movement, remaining-average requirement and distance relative to observed ranges, score and freshness. It distinguishes a supported recovery or active contention from merely theoretical possibility. The browser remains a YES/NO signal; no order controls change. Answers record `promptVersion` for audits. Confidence remains model classification confidence, not a trading win probability.

Diagnostic replay: `node --import tsx scripts/replay-jev.ts .runtime/jev/YYYY-MM-DD.jsonl [comma-separated-seconds-left]`. It makes paid inference calls, capped at 40 per UTC day in a separate replay budget; production retains its existing request cap. Uses the last two logged contracts for XRP/BNB/HYPE at predefined offsets. Reconstructs history from earlier logged observations only; later bids are attached after inference, never sent to the model. Replay logs are separate from live journals. Small, selected snapshots and sampled bid maxima do not establish accuracy, maker fills, or profitability; an unfinished or incompletely observed contract cannot be labeled a failed flip.

Current cadence/budget policy: displayed AUTO markets are evaluated every five seconds during their final two minutes. Each market therefore uses about 24 requests per 15-minute round. At 1,563 recent input tokens per request and $0.042/M input tokens, five markets cost roughly $0.008 per round / $0.16 per five hours; nine cost $0.014 per round / $0.28 per five hours. These are estimates, not billing guarantees. The old UTC-day counter no longer gates production. A separate persistent five-hour session allowance of 7,000 requests (`JEV_MAX_CALLS_PER_SESSION`, `.runtime/jev/session-budget.json`) renews five hours after its start, not on backend restart. That allowance is about $0.46 at observed payload sizes. Results remain valid for at most five seconds, additionally bounded by input freshness and contract close; slowed polling never extends stale source data.
