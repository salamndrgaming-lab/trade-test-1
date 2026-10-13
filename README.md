# Coin Trader · Blob Desk

A Solana memecoin trading desk run by eight pixel-blob agents. Each new token walks a kill chain
(`free_kill → trade_kill → chain_kill → soft_kill → pick`). Chief picks one survivor, and the bot buys it through Jupiter.
The dashboard is an installable PWA with an animated isometric office, live charts and a hold-to-confirm kill switch.

> **Status: Phase 3 (free AI brain).** The bot crawls new Solana tokens and runs the whole kill chain on real data:
> `free_kill`, `trade_kill` and `chain_kill` on market, on-chain and Jupiter quote data, then `soft_kill` on model scores
> (Vet + Social, one JSON call per token), then Chief picks one of the top three. Trading arrives in phase 4.
> `TRADING_MODE` defaults to `shadow`. No code path that signs or sends a transaction exists yet.
>
> **No mock data in production.** The bot has no fake-data mode. The fake "dev desk" exists only for `vite dev` UI work.
> Production web builds exclude it, and `pnpm check:no-mock` (run in CI and before every Pages deploy) fails the build if it slips in.

## Layout

```
apps/bot        Node 22 bot: crawler + kill chain + SQLite + Fastify API (GET /state, /health)
  src/sources     DexScreener, Solana RPC and Jupiter clients, each behind its own rate limiter
  src/pipeline    the tick: crawl → metrics → free_kill → trade_kill → chain_kill → events
  src/db          SQLite schema (migrations) and queries
  src/state       builds the /state snapshot from real results
apps/web        Vite + React dashboard, PWA, canvas office, lightweight-charts
packages/shared StateSnapshot types, thresholds.ts, the kill-chain evaluator; mock/ is the dev-only desk
scripts/        icon generator, pre-commit secret scan, no-mock check
```

## Local dev

Requires Node 22 and pnpm 10 (`corepack enable`).

```sh
pnpm install                         # also points git hooks at .githooks (secret scan on commit)
cp apps/bot/.env.example apps/bot/.env   # set SOLANA_RPC_URL, JUPITER_API_KEY, BOT_WALLET_PUBKEY; NODE_ENV=development
pnpm dev                             # real bot on :8787 + dashboard on :5173 (Vite proxies /state to the bot)
pnpm dev:web                         # dashboard alone on the in-browser dev desk (fake data, UI work only)
pnpm test                            # unit tests + one full pipeline tick on synthetic API responses (no network)
pnpm typecheck
pnpm build:web && pnpm check:no-mock # production build, then prove it has no mock code
pnpm --filter @coin/bot record       # record one real tick as replay fixtures (test/fixtures/recorded)
pnpm secret-scan                     # scan every tracked file
```

To open it on your phone during dev, Vite listens on your LAN (`http://<your-ip>:5173`). The service worker only registers
in production builds.

### Where the data comes from

| Piece | Source | Budget |
| --- | --- | --- |
| New tokens | DexScreener `token-profiles/latest` + `token-boosts/latest` (Solana only), every minute | whole bot ≤ 55 DexScreener req/min |
| Price, liquidity, volume, trades, age, socials | DexScreener `tokens/v1/solana/{≤30 mints}`, deepest pool per token | same limiter |
| Mint/freeze authority, holder concentration | Solana RPC: `getAccountInfo`, `getTokenLargestAccounts`, `getMultipleAccounts` | 8 req/s |
| Sell route and price impact at ticket size | Jupiter Swap v2 `GET /order` **without a taker** (quote only, no transaction) | 1 req/s with key, 0.5 without |
| Big-screen candles | the bot's own 15 s price samples of the newest survivor | 4 req/min |
| Balance | RPC `getBalance` on `BOT_WALLET_PUBKEY` + SOL price from DexScreener, every 5 min | — |
| Vet + Social scores (soft_kill) | Workers AI `@cf/zai-org/glm-4.7-flash`, thinking off, JSON mode, ≤ 300 output tokens | ~8 neurons per token |
| Chief's pick | Workers AI `@cf/openai/gpt-oss-120b`, Responses API, reasoning effort low, ≤ 400 output tokens | ~45 neurons per decision |
| Fallbacks | Groq `openai/gpt-oss-120b`, then Gemini (`GEMINI_MODEL`), then rules only: no picks, no new trades | Workers AI hands over at 90% of 10,000 neurons/day |

### How the AI budget is kept

- Every reply is validated with zod (six 0–1 scores plus two quotes of 60 characters or fewer). An invalid reply is retried once, then the token fails `soft_kill`.
- Scores are cached for 15 minutes. A price move over 20% voids the cache. Expired or repriced scores are refreshed only when the token reaches Chief's top three; everywhere else the last scores stand. Every survivor is scored once on arrival.
- Chief decides only when a token it has not seen enters the top three, and at most every 30 minutes (`CHIEF_MIN_MINUTES`).
- Neurons are counted per UTC day from each reply's token usage at Cloudflare's published rates (GLM-4.7-Flash 5,500 in / 36,400 out per million tokens; gpt-oss-120b 31,818 / 68,182).
- `test/budget.test.ts` runs the real pipeline over a simulated busy day (about 2,800 new tokens, 240 reaching the model) and must stay under 9,000 neurons. Last run: 400 scoring calls + 55 Chief decisions = 5,344 neurons.


The calls are staged so a token only costs what it needs: tokens that fail age, liquidity or mcap never touch the RPC, and
Jupiter is only asked once mint and freeze authority are both revoked. Holder concentration skips accounts owned by programs
(the pool vault, a bonding curve, a lock), so the pool never counts as a whale. Tokens are re-checked every 5 minutes for
3 hours, since a token that is too young now may pass later.

| `VITE_STATE_URL` (web build) | Dashboard shows |
| --- | --- |
| `https://…/state` | the bot, polled every 2 s while visible and every 30 s in the background |
| unset, production build | "Not connected to a bot" |
| unset, `vite dev` | the dev desk (fake data, with a banner saying so) |

## Deploy the web app to Cloudflare Pages

Pick one of the two options below.

**A. Cloudflare's Git integration (no secrets in GitHub).** In Cloudflare: Workers & Pages → Create → Pages → Connect to Git → this repo.
- Build command: `pnpm install --frozen-lockfile && pnpm build:web`
- Build output directory: `apps/web/dist`
- Environment variables: `NODE_VERSION=22`, and `VITE_STATE_URL` = the bot's public /state URL (behind Access)

**B. GitHub Action (`.github/workflows/pages.yml`).** Create a Pages project named `coin-trader`. Then add the repo secrets
`CLOUDFLARE_API_TOKEN` (needs Pages: Edit permission) and `CLOUDFLARE_ACCOUNT_ID`, and set the repo variable `PAGES_ENABLED=true`.
Every push to `main` then deploys.

Then put the Pages site behind **Cloudflare Access** (Zero Trust → Access → Applications → self-hosted, policy: your email only).
The full server and tunnel guide arrives as `DEPLOY.md` in phase 4.

## Phase 3 checklist

With the AI keys set, after a few hours:
- [ ] The header's AI budget gauge rises with each scored token and stays well under 9,000 by the end of the UTC day
- [ ] Survivors of `chain_kill` get Vet and Social quotes on their cards, and some die at `soft_kill` with the failing score shown
- [ ] Chief picks a token now and then ("Picks today"); the big screen follows the latest pick
- [ ] `sqlite3 data/coin-trader.sqlite "select * from ai_usage"` matches the gauge
- [ ] Remove the Workers AI token: the gauge reads Groq; remove every key: "Rules only · no new trades"

## Phase 2 checklist

Run the bot for an hour with real data, then on the dashboard:
- [ ] The Crawler card's "Scanned today" climbs every minute
- [ ] The drop rate in Analysis sits around 90–98%
- [ ] "Why it died" chips cover all three steps, and each checklist shows the failing value against its limit
- [ ] Survivors appear as "Watching $SYM" with candles building from the bot's samples
- [ ] If a data source goes down, a yellow banner says which one
- [ ] `sqlite3 data/coin-trader.sqlite "select died_at, count(*) from verdicts group by 1"` matches the dashboard

## Phase 1 checklist (visuals)

On the phone (375–430 px wide):
- [ ] Sticky top bar shows the SHADOW badge, balance, today's PnL and the AI budget gauge
- [ ] Agent cards sit in 2 columns; tapping a card expands it
- [ ] The office canvas is crisp (no blur) and fills the width; blobs carry coins desk to desk and show bubbles; the caption under it repeats the latest line
- [ ] Tapping a blob shows its last quote
- [ ] Charts pan with a horizontal swipe; vertical swipes still scroll the page
- [ ] Analysis / Thresholds are tabs; "Why it died" chips show the step that killed each token
- [ ] The kill switch in the bottom bar does nothing on a quick tap and engages after a 2 s hold (board says BUYS OFF, position sells). A second 2 s hold releases it. With the real bot this endpoint arrives in phase 4.
- [ ] No sideways scrolling anywhere
- [ ] Install: Android Chrome shows "Install app" (or menu → Install). iPhone Safari: Share → Add to Home Screen. Opens standalone, and the top bar clears the notch.
- [ ] ⚙ → Alerts: enable notifications, then "Send test" (on iPhone this needs the home-screen app)

On desktop: five bands (header, 4×2 cards, office, balance, analysis + thresholds side by side), and the hold-to-confirm kill switch in the header.

## Safety rules (enforced as the phases land)

- `TRADING_MODE=shadow` by default. `live` must be set explicitly and logs a loud warning at startup.
- The wallet key lives only in an encrypted file or env var on the server. It never goes in the repo, frontend, logs, SQLite or `/state`. A test checks the snapshot for key-shaped strings.
- Only Jupiter swap transactions can be signed. No transfer code path exists.
- Write endpoints verify the Cloudflare Access JWT server-side.
- `.env` is gitignored; `.env.example` is committed. The pre-commit hook blocks key-shaped strings (it uses gitleaks too if installed).

## Credits

Charts by [TradingView Lightweight Charts™](https://www.tradingview.com/). All pixel art, the logo and the in-canvas 3×5 bitmap font are original to this project.
UI font: Silkscreen (SIL Open Font License).
