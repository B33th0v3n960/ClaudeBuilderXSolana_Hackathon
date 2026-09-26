# Project Context: Portable Game Licenses on Solana

> Handoff document for an AI assistant. Contains the problem framing, analysis already
> completed, architectural decisions already made, and what remains open.
> Assume the user is **new to Solana and to blockchain generally** — explain terminology,
> do not assume prior knowledge.

---

## 1. Situation

- **Event:** one-day, open-track Solana hackathon.
- **User's experience level:** new to Solana. Comfortable being taught; does not want jargon assumed.
- **Deliverable:** a working prototype plus a short demo/pitch.
- **Time available:** 10:00–16:00 (6 hours), submission deadline included.

## 2. Problem being addressed

Digital game ownership. Specifically: a purchased digital game cannot be lent outside a
narrow household group, and cannot be resold or given away at all.

"Not owning your games" is actually three separate complaints, and they need different fixes:

| # | Complaint | Can blockchain fix it? |
|---|---|---|
| 1 | Access lost when publisher pulls the game / kills servers | **No.** Needs DRM-free files or end-of-life legislation. |
| 2 | Can't lend to a friend outside the household | Partly — this is the target. |
| 3 | Can't resell or give away a copy you're finished with | Yes — this is the target. |

**Scope decision: the project targets #2 and #3 only.** Claiming #1 would be dishonest and
will not survive questioning by informed judges.

### Prior art constraint (Steam Families, current as of 2026)
Steam already partly solves lending, which is why the gap must be stated precisely.
Steam Families: hard six-member cap, one-year cooldown on leaving a family, region checks on
members, and one owned copy supports only one active player in that game. It is intended for
people in the same household.

**The genuine gap:** lending to a friend in another household/town, for a short period, and
resale/transfer of a copy — none of which Steam supports.

## 3. Verdict on whether blockchain is justified

**Yes, but narrowly.** The defensible pitch is:

> Portable, lendable, resellable licenses that pay the developer a cut on every resale.

NOT "true ownership," NOT "stops piracy," NOT "keeps your games alive forever." Those claims
are false and will be challenged.

### Where blockchain genuinely wins
1. **Portability across storefronts.** A public ledger record can be read and honoured by a
   rival launcher without a business deal, API key, or the original store still existing.
   This is the one irreplaceable advantage; the project rests on it.
2. **Atomic settlement between strangers.** Money and license move in one transaction or
   neither moves. Removes the trusted middleman from used-copy sales.
3. **Enforceable developer royalties on resale.** Centralised royalties get bypassed by
   competing marketplaces (as happened across NFT markets in 2022–23). On Solana this can be
   made structural — see §5.
4. **Publicly verifiable rules.** "We never revoke your license" becomes a checkable fact
   rather than a company's promise. Matters for a product premised on distrust of stores.

### Where blockchain loses, and normal infrastructure should be used
- **Enforcement at launch.** The chain says who owns; something on the user's machine must
  still refuse to run. That is ordinary DRM and is identical either way. The chain does
  **not** reduce piracy.
- **One-player-at-a-time exclusivity.** A session server handles crashed clients, dropped
  connections, and prompt lock release. On-chain locks cost money, add latency, and strand
  the license if a client dies. See the split design in §4.
- **Refunds, chargebacks, recovering a stolen copy, banning cheaters, pulling illegal
  content.** Irreversibility is a liability here.
- **Account recovery.** Lost private key = library gone permanently.
- **Game files, patching, storefront, regional pricing, VAT, age ratings.** Ordinary
  infrastructure and law.
- **Privacy.** A public ledger exposes purchase/loan/resale history. This is a real
  regression versus a private Steam library. Name it before a judge does.

### Honest weaknesses to state up front in the pitch
- Does nothing against piracy.
- Publishers have weak incentives to adopt (resale competes with new sales).
- Gamers are broadly hostile to "NFTs in games" after several failed launches — framing matters.

## 4. Architectural decision: thin-chain, fat-everything-else

**Test for any feature:** *"Does this need to still work if my company disappears?"*

| On-chain (passes the test) | Off-chain (fails it) |
|---|---|
| License ownership record | Game files / CDN |
| `buy`, `lend`, `resell` instructions | Storefront pages, search, discovery |
| Royalty split on resale | **Session lease** (the concurrency lock) |
| | Refunds, support, fiat payments |

**Concurrency design (decided):** the chain holds the *entitlement*; a short **session lease**
(~15 min, heartbeat-renewed, issued by a lightweight server) holds the *exclusivity*.
Rationale: if the lease server dies, worst case is brief double-play — far better than a
failure mode where someone's library becomes unusable.

## 5. Solana specifics worth knowing

- **Why Solana rather than another chain:** short-term lending only makes sense if a
  transaction is fast and costs a fraction of a cent. On expensive chains the fee exceeds the
  value of an evening's loan.
- **Token-2022 (a.k.a. Token Extensions)** provides the royalty mechanism:
  - **Fee-on-transfer** — takes the cut natively at the token-program level, deterministically,
    without depending on an external program or wallet behaving correctly. **Use this for the money.**
  - **Transfer hooks** — custom on-chain logic run on every transfer; the way to check external
    state and permit/deny a transfer. **Use this for the rules** (e.g. requiring transfers to go
    through the licensing program).
  - **Known pitfall:** do *not* try to take the royalty fee inside a transfer hook. A hook cannot
    upgrade an account's permissions mid-transfer, so fee-taking there fails in practice. Fee-on-transfer
    is the correct layer.
  - **Permanent delegate / freeze authority** allow clawback and account freezing. Useful for fraud
    recovery, **but** holding such a key substantially undercuts the decentralisation claim.
    Treat as an explicit, acknowledged trade-off.
- **Devnet** is the free test network. Build entirely there.
- **Solana Playground (beta.solpg.io)** — browser-based editor, deploy and test on devnet with no
  local toolchain setup. Recommended for a beginner under time pressure.

## 6. Prototype plan (working name: "LendKey")

**Demo runs as two browser windows with two wallets — the user and "a friend."**

1. **Buy** — store page with 2–3 fictional games; connect wallet; license appears in library.
2. **Play** — mock launcher (can be a trivial browser mini-game) checks chain: "✅ Licence verified."
3. **Lend** — lend to friend for 10 minutes. Owner's launcher: "🔒 Lent out until 14:20."
   Friend's: "✅ Borrowed — playable." *This is the money shot: proves one-copy-one-player.*
4. **Return** — access flips back automatically on expiry.
5. **Resell** — sell to friend; screen shows 90% to seller, 10% to developer wallet.
6. **Stretch — "the store shuts down":** kill the store server, show a second independent
   launcher page still reading the library from chain. *Strongest proof of the core claim.*

### Minimum on-chain surface
- Instructions: `buy`, `lend(borrower, minutes)`, `resell(buyer, price)`.
- One small account per license holding: `owner`, `borrower`, `expiry`.
- Playability rule: *if a borrower exists and the loan has not expired → borrower plays;
  otherwise → owner plays.*

### Fallback if the custom program overruns
Use a standard NFT as the license and handle lend/expiry logic in the front end — then state
plainly in the demo that this logic moves on-chain in the real version.

### Day plan — compressed to 10:00–16:00 (6 hours)
| Time | Goal |
|---|---|
| 10:00–11:00 | Phantom wallet installed, switched to devnet, funded with test SOL; "hello world" deployed in Solana Playground |
| 11:00–13:00 | License program (`buy`, `lend`, `resell`) written and tested in Playground — this is the core; protect this block |
| 13:00–14:30 | Store + launcher front ends, wired to wallet and program |
| 14:30–15:00 | Royalty display. **Cut the "store shuts down" stretch goal** unless the above finished early |
| 15:00–15:30 | Buffer — fix whatever broke; this block is expected to be needed, not optional |
| 15:30–15:50 | Rehearse the 3-minute demo |
| 15:50–16:00 | Submit |

**If behind schedule at 13:00:** drop straight to the fallback (§ below) — standard NFT + front-end
lend/expiry logic — rather than continuing to debug the custom program. A working fallback demo
beats a broken custom program at submission time.

## 7. Pitch line

> "This doesn't stop piracy or keep servers alive. It gives players what the disc gave them —
> lending and resale — while paying developers a cut the used-disc market never did."

Stating the limits explicitly is a strength here, not a weakness: most blockchain gaming
projects lose credibility by claiming the chain does everything.

## 8. Open items / next steps

- [ ] Design the account structure and instruction set in detail before coding begins.
- [ ] Decide whether to include the permanent-delegate clawback, and how to justify it.
- [ ] Decide whether the session-lease server is built for the demo or merely described.
- [ ] Wallet-vs-account onboarding story for non-crypto gamers (currently unaddressed).

## 9. Glossary (user is new — keep using these plainly)

- **Wallet** — identity on the chain (e.g. Phantom). Proves "this is me" with no company-held password.
- **Token / NFT** — a record saying "wallet X owns item Y." Here: a game licence.
- **Program** — on-chain code enforcing rules. Called a "smart contract" on other chains.
- **Transaction** — any change to the ledger. On Solana: ~a second, a fraction of a cent.
- **Devnet** — free test network with fake money.
- **Mint** — the on-chain definition of a token type.

---

### Sources consulted
- Steam Families rules — steamdb.com/en/articles/steam-family-sharing-complete-guide
- Steam Families limits — itechguides.com, virtwave.com
- Token-2022 transfer hooks & fee-on-transfer — chainstack.com/solana-token-2022-fee-transfer-hooks/
- Token-2022 extensions overview — neodyme.io/en/blog/token-2022/
- Token Extensions feature reference — solana.com/developers/evm-to-svm/erc3643
