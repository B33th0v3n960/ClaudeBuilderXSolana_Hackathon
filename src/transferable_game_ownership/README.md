# Transferable Game Ownership

Anchor workspace for the project: portable, lendable, resellable game licenses on Solana
(see `docs/solana-game-license-context.md` for the full pitch/rationale).

## game_license — license ownership

Implements the "buy and own" part of §6's minimum on-chain surface (`lend` and `resell` are next).

- **Program ID:** `79qFZV1E5tBdLeoqAx495yW4LnP33coF81v288HpKwoe` — already deployed to devnet.

### Accounts

- **`Game`** — one per game, created by the developer (`create_game`): `authority` (developer
  wallet, gets paid), `game_id`, `price_lamports`, `license_count` (also used to derive each new
  license's PDA, so it doubles as a sold-copies counter).
- **`License`** — one per purchased copy (`buy`): `game`, `id`, `owner`, `borrower: Option<Pubkey>`,
  `expiry`, `purchased_at`. `borrower`/`expiry` are unused today — set by `lend`, coming next —
  included now so the account layout doesn't need to migrate later.
  PDA seeds are `[b"license", game, license_id]` — deliberately **not** seeded by owner, so a
  future `resell` can just overwrite the `owner` field without changing the account's address.

### Instructions

- `create_game(game_id, price_lamports)` — developer registers a game and its price. Anyone can
  call this in the current version (no gatekeeping) — fine for a hackathon demo, would need an
  allowlist/admin key in a real deployment.
- `buy()` — buyer pays `price_lamports` straight to `game.authority` (a CPI to the System Program,
  not a program-held escrow) and a new `License` PDA is created with `owner = buyer`. That new
  account, owned by the buyer's pubkey, *is* the license.
- `lend(borrower, minutes)` — the owner signs (enforced by `has_one = owner`) and the licence
  records `borrower` plus an `expiry` timestamp. Ownership does **not** move.
- `list_for_sale(price_lamports)` — the owner creates a `Listing` PDA. Its existence is the "for
  sale" flag; the transaction is the seller's standing consent.
- `cancel_listing()` — the seller withdraws the offer and gets the listing's rent back.
- `buy_listed()` — **the buyer signs alone.** Pays the seller 90% and the developer 10%, rewrites
  `license.owner`, clears any lapsed loan, and closes the listing. All in one transaction.

### How resale works (and why the seller doesn't sign)

A sale needs the buyer's signature to move their SOL. If it also needed the seller's, both parties
would have to co-sign one transaction at the same moment — unusable for a real used-copy market.

So consent is split in time: the seller signs once to list, the buyer completes the sale alone later.
That works because the `License` is a **PDA with no private key** — only the program can write to it,
and the listing authorises exactly this. Money and ownership move in the same transaction or neither
moves, with no escrow.

- **Royalty is enforced by the program, not the marketplace**, so every resale pays the developer
  however many times the copy changes hands (tested to a third owner). This is the thing centralised
  NFT marketplaces couldn't hold onto in 2022–23.
- Payout addresses are pinned by constraints, so a malicious frontend can't redirect either leg.
- **A copy on loan can't be listed or sold** — a borrower never loses access mid-loan.
- **A sale hands over a clean copy:** `borrower`/`expiry` are reset for the new owner.
- **Price `0` is a giveaway**, handled by the same code path with no royalty — that's the "give away
  a copy you're finished with" case from the context doc.

### How lending works (the one-copy-one-player claim)

The playability rule, applied identically on-chain and in the UI:

> if a borrower is set **and** `expiry > now` → the borrower plays; otherwise → the owner plays.

Consequences worth stating out loud in the pitch:

- **Nothing is returned by a transaction.** The loan just expires. There is no "return" instruction
  and nobody has to be online for access to flip back — which also means no one can get stranded
  holding a licence they can't use.
- **The owner genuinely loses access while lent out.** That's what makes it a loan rather than a
  copy, and it's the part Steam Families can't do across households.
- **The borrower never signs anything.** Lending is unilateral, like handing someone a disc. The
  borrower needs no SOL and doesn't even have to be online.
- **Re-lending is allowed only once the previous loan expires** (`AlreadyLentOut` otherwise), so a
  copy can never be on loan to two people at once.
- **Loans are capped at 30 days** (`MAX_LOAN_MINUTES`). Without a cap a "99-year loan" would be a
  transfer in disguise that dodges the resale royalty.

The concurrency caveat from the context doc §4 still applies: the chain settles *entitlement*, not
live session exclusivity. Two people could still run the binary simultaneously in the same second
unless a session-lease server sits in front — that's deliberately off-chain.

### Verifying it works

```bash
anchor build
cargo test --manifest-path programs/game_license/Cargo.toml   # 7 LiteSVM tests: buy + lend
anchor deploy --provider.cluster devnet                        # already done

# Live devnet: developer creates a game, a separate buyer keypair purchases it
node scripts/buy_license.mjs
```

The lend tests cover the cases that matter: the loan is recorded without moving ownership, a
stranger can't lend your licence, you can't lend one that's already out, you *can* lend again once
it expires (LiteSVM warps the clock forward to prove it), and self-loans/absurd durations are
rejected.

`scripts/buy_license.mjs` uses your main CLI wallet as the developer and a throwaway keypair at
`.keys/buyer.json` (gitignored) as the buyer, funded by a transfer from the main wallet. It prints
the program logs, then fetches the `License` account back and checks `owner.equals(buyer.publicKey)`
— i.e. it doesn't just trust the transaction succeeded, it re-reads the chain and confirms the
buyer, not the developer, ends up owning the license. Re-run it and it'll buy license `id 1`, `2`, ...
against the same game.

---

## app/ — store + library web page

Vite + React. Shows the connected wallet's license library and lets it buy more games.

```bash
cd app
npm install        # first time only
npm run dev        # http://localhost:5173  (copies the fresh IDL in automatically)
```

**End users need nothing but the Phantom browser extension**, switched to devnet, with some devnet
SOL. No CLI, no Rust, no toolchain.

- **Store** — the 3 games in `src/catalog.json`. Titles/blurbs/colours are deliberately off-chain
  (storefront metadata, per the architecture split in the context doc §4); **price, copies sold and
  the developer's payout address are read from the on-chain `Game` account**, which is the
  authority. A game the catalog lists but nobody has `create_game`'d shows as "not listed on-chain
  yet".
- **My Library** — `getProgramAccounts` filtered to `License` accounts whose `owner` field is the
  connected wallet (byte offset 48 = 8 discriminator + 32 game + 8 id). Nothing is stored in the
  page or a database; refresh with a different wallet and you get that wallet's library.
- **Buy** — reads `game.license_count` fresh, derives the next license PDA, and has Phantom sign
  the `buy` instruction. On success it re-reads the chain rather than assuming, so the new card
  appearing in the library is real on-chain state.
- **Lend** — each owned card has a "Lend to a friend" form (their address + 10 min / 1 hour / 1 day).
  Once lent, the card flips to "Lent out until HH:MM" with a live countdown and the Lend button
  disappears.
- **Borrowed from friends** — a section that appears only when this wallet has licences lent *to*
  it, found by matching the `borrower` field. Shows "Borrowed — playable" with a countdown, then
  "Loan ended — back with the owner" once it expires. The page re-evaluates every second, so the
  flip happens on screen with no refresh and no transaction.
- **Sell** — each owned card has a "Sell" form that shows the 90/10 split **before** you commit
  ("You get 0.315 SOL · developer royalty 0.035 SOL"). Once listed the card reads "For sale" with a
  "Withdraw from sale" button.
- **Used copies for sale** — every open listing from *other* wallets, each showing the price and
  where the money goes. "Buy used" completes the sale; the seller isn't involved.

### Demoing the loan with two wallets

Use two Phantom wallets (two browser profiles, or Phantom's account switcher) so both sides are
visible at once:

1. Wallet A buys a game, then lends it to wallet B's address for 10 minutes.
2. Wallet A's card now reads "Lent out until …" — A cannot play it.
3. Switch to wallet B: the game appears under "Borrowed from friends", playable, counting down.
4. Wait for expiry (or lend for 1 minute to make it quick): B's card flips to "Loan ended" and A's
   flips back to "Owned — playable". Nobody sent a transaction to make that happen.

---

## launcher/ — independent licence verifier

A **second, separate application** (own folder, own `package.json`, own port 5175). It answers one
question: *may this wallet play this game right now?*

```bash
cd launcher
npm install          # first time only
npm run dev          # http://localhost:5175

node verify_cli.mjs                  # verdicts for the demo keypairs
node verify_cli.mjs <wallet-address> # verdicts for any wallet
```

**Why it's a separate app, not a page in the store.** It shares no code, no server and no database
with `app/`. It needs exactly two public things — the program ID and the IDL — and talks only to a
public Solana RPC. Verified: nothing under `launcher/src` imports from `app/`, and the built bundle
contains no store URL or API reference. So it doubles as the context doc's stretch goal — stop the
store, reload the launcher, and it still works. That's the portability claim made concrete: a rival
launcher could ship this with nobody's permission.

**Verification needs no on-chain program of its own.** It's a *read*: no transaction, no fee,
nothing signed. That's why anyone can verify any wallet — the launcher accepts a pasted address, not
just a connected wallet.

Each game shows a verdict, the reason, a live countdown when a loan is involved, a mock "Launch
game" button gated on the verdict, and a **"Show evidence"** panel with the program ID, RPC URL,
licence account addresses and the raw `owner` / `borrower` / `expiry` values it decided from — so the
verdict can be audited instead of trusted.

**Shape of the queries (this matters).** `fetchEntitlements()` makes exactly **two** RPC calls per
wallet regardless of catalog size, and `verdictFor()` then decides each game locally with no network.
The first version queried per game and got HTTP 429'd off the public devnet endpoint —
`getProgramAccounts` is rate-limited hard. Deciding locally also means the expiry countdown ticks
and the verdict flips for free, with no refetch.

### Scripts

- `scripts/seed_games.mjs` — lists the catalog's games on devnet (idempotent).
- `scripts/buy_license.mjs` — a devnet purchase with a throwaway buyer keypair.
- `scripts/list_licenses.mjs` — dumps every game and licence on-chain.
- `app/verify_chain.mjs` / `app/verify_lend.mjs` / `app/verify_resell.mjs` — run the page's **real**
  data layer (`app/src/chain.js`) against devnet from the terminal. This is how the read, lend and
  resale paths were tested without a browser. `verify_lend.mjs` lends `.keys/buyer.json`'s copy to
  `.keys/friend.json`; `verify_resell.mjs` lists a copy, proves cancellation works, re-lists, buys it
  from the other keypair, and checks the 90/10 split and the ownership change on-chain.

### Wallet / funding

Uses your existing CLI keypair (`~/.config/solana/id.json`), already configured for devnet
(`solana config get`). Check balance with `solana balance`; top up with `solana airdrop 2` if it
runs low (devnet faucet, rate-limited) or transfer from the main wallet like `buy_license.mjs` does.
