# Multibot

Multibot is a React and Node dashboard for monitoring recurring Kalshi
markets. The frontend receives normalized market, order, position, and P&L
messages from a local WebSocket backend; exchange credentials are never sent
to the browser.

This repository is software, not a hosted service or trading recommendation.
Review the code and risk controls before connecting any account.

## What is public and what is authenticated

- Market definitions, public quotes, candles, and other exchange market data
  are public-market information.
- Portfolio fills, orders, settlements, balances, positions, realized P&L,
  and bot-control state are private account data.
- The backend currently requires a Kalshi API key and RSA private key for its
  authenticated feeds and account features. No credentials or account exports
  are included in this repository.
- Scripts that export authenticated account data write under
  `.private/account-exports/`; derived account reports belong under
  `.private/account-reports/`. The entire `.private/` directory is ignored.

## Architecture

- `src/` — React, Vite, and TypeScript frontend.
- `server/` — Node backend for market discovery, exchange WebSockets,
  authenticated portfolio state, and local dashboard messages.
- `scripts/` — research and maintenance tools. Scripts importing
  `server/config.ts` may require credentials or make authenticated requests;
  inspect a script before running it.
- `markets.config.ts` — dashboard market configuration.

## Install and verify without credentials

```sh
npm ci
npm run build
npm run lint
```

Some tests import the authenticated configuration module and therefore require
a syntactically valid disposable RSA key, but never a live API credential:

```sh
test_key="$(mktemp)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$test_key"
KALSHI_API_KEY_ID=test-only KALSHI_PRIVATE_KEY_PATH="$test_key" \
  node --import tsx --test server/*.test.ts
rm "$test_key"
```

Build, lint, and unit tests do not require live account credentials. Do not run
`npm run dev`, `npm start`, or account-export scripts
unless you intend to connect to the configured exchange/account services.

## Local authenticated setup

1. Copy the environment template:

   ```sh
   cp server/.env.example .env
   ```

2. Set `KALSHI_API_KEY_ID` and point `KALSHI_PRIVATE_KEY_PATH` to a private key
   stored outside this repository.
3. Review optional control-service settings in the template. A control token
   can authorize actions that place or cancel orders; do not expose a control
   endpoint or dashboard to untrusted users.
4. Start the local development processes only when you are ready for live
   authenticated connections:

   ```sh
   npm run dev
   ```

The frontend defaults to `http://127.0.0.1:5173` and the backend WebSocket to
`ws://127.0.0.1:4001`.

## Private exports

Authenticated export and analysis scripts use ignored paths by default:

```text
.private/account-exports/
.private/account-reports/
```

Never commit files containing user IDs, order/fill/trade identifiers, account
balances, positions, settlements, or personal P&L. Public market datasets may
be committed only when they are independently public and are not selected or
derived from private account activity.

## Security notes

- Keep `.env`, private keys, API tokens, access tokens, and local tunnel URLs
  out of Git.
- Use a long random `DASHBOARD_ACCESS_TOKEN` for production serving.
- Rotate a credential immediately if it has ever been committed or shared.
- Deleting a file in a new commit does not remove it from existing Git history.

## Licensing

Original project code is licensed under the MIT License; see `LICENSE`.
Third-party dependencies and assets retain their own licenses. See
`THIRD_PARTY_NOTICES.md` and `public/fonts/OFL.txt`.
