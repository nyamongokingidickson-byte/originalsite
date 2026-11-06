# Deriv OAuth and trading setup

The app uses Deriv's OAuth 2 authorization-code flow with PKCE and the `trade` scope. It exchanges the authorization code on the server at `/api/oauth/token`, obtains Options accounts through the REST API, then opens a separate authenticated WebSocket using a one-use OTP for the selected account. The account balance comes from Deriv and is subscribed to for updates. Account switching requires a fresh authenticated socket.

## Before deploying

- Register `https://dylantrades.site/callback` as an **exact** redirect URI for OAuth client `34J0u7zObmeCX5lnl8zm7` in Deriv and enable the `trade` scope. If `www.dylantrades.site` is also used, register `https://www.dylantrades.site/callback` separately. OAuth redirects use the current origin; Vercel preview domains and local development need their own registered redirect URI.
- Connect the domain to the deployment, and make sure Vercel's root directory includes `api/oauth/token.js`. `/api/oauth/token` must reach the serverless function, not the SPA fallback.
- Existing Vercel `NEXT_PUBLIC_DERIV_APP_ID` or `VITE_DERIV_APP_ID` settings override the default client ID during the build. Ensure they match the registered OAuth client. Never put a client secret in either variable.
- OAuth tokens expire; users must sign in again when their session expires. This app does not implement token refresh.

## Local verification

Run `npm test`, `npm run build`, and `npm run dev`. The local callback is `http://localhost:8080/callback`, which must also be registered with Deriv for a real local login. The tests use mocked Deriv responses; after deploying, test sign-in, balance updates, account switching and order placement with a **Deriv demo account** before using real funds. A production OAuth registration and reachable Deriv services are required for an end-to-end test.

The former local paper-account balance overrides and simulated trading mode are disabled; trades in the bot editor are sent to the selected Deriv account and real-account trades can lose real money. The DTrader tab is built into Dylan Trades and uses its existing authenticated Deriv connection; it does not load an external DTrader site or forward credentials. The tab is labelled DTrader and its market view can load public prices before sign-in. Trading, account balances and positions require the selected authenticated Deriv account. It provides Rise/Fall and digit contracts with tick durations, live ticks, a simple price chart, and open positions. It is not the complete Deriv DTrader product. Availability depends on the market and account; Deriv may reject unsupported contracts. Users should verify their account and check Deriv’s portfolio for complete trade details.

The built-in ticket stores a pending-purchase warning before a buy request. If a response is lost or the browser closes, that ticket blocks further trades on the account until the user checks their Deriv portfolio and explicitly clears the warning. This warning does not cover bot purchases. Never assume an unconfirmed order failed; check the Deriv portfolio before retrying.

For bot troubleshooting, use a demo account and verify that its strategy conditions are met, the selected market and contract are available, and the stake and balance are valid. Proposal and order errors should be checked in the bot's log. Automated tests use mocks and do not establish that live broker orders will execute.

## Account service unavailable

A `503` / `CircuitBreakerOpen` response from Deriv's accounts endpoint means that the service is temporarily refusing the request. The app retries the account lookup once; if it still fails, wait a few minutes and use **Retry sign in** on the error screen. If token exchange already succeeded, this resumes using the existing unexpired session rather than reusing the one-time authorization code. Do not repeatedly attempt trades while connectivity is uncertain. If the error persists, check Deriv's service status or contact Deriv support with the time and error code.
