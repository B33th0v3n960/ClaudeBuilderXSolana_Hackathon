# Program Notes — how it actually works

> Working notes on the `game_license` program as built. Companion to
> `solana-game-license-context.md` (which covers *why*); this covers *how*, plus the technical
> nuances that were non-obvious while building it.
>
> Everything here was measured against the live devnet deployment, not assumed.

**Status:** feature-complete for the demo — `create_game`, `buy`, `lend`, `list_for_sale`,
`cancel_listing` and `buy_listed` are implemented, tested (14 LiteSVM tests) and deployed to devnet
at `79qFZV1E5tBdLeoqAx495yW4LnP33coF81v288HpKwoe`. Built with Anchor CLI 1.1.2 / `anchor-lang` 1.2.0.
Code lives in `src/transferable_game_ownership/`.

---

## 1. The vocabulary, quickly

| Term | What it means here |
|---|---|
| **Program** | Our Rust code, deployed on-chain. Stateless — it only reads and writes accounts. Called a "smart contract" elsewhere. |
| **Account** | A chunk of storage on-chain with an address. Everything is an account: wallets, our `Game` records, our `License` records. |
| **Instruction** | One callable function of the program (`buy`, `lend`, …). |
| **Transaction** | A signed bundle of instructions. Atomic: all of it happens or none of it does. |
| **PDA** | *Program Derived Address.* An account address computed from a seed recipe instead of being a keypair. It has **no private key**, so nobody can sign for it — only our program can write to it. |
| **Discriminator** | The first 8 bytes of every Anchor account, identifying its type. Stops a `Game` being read as a `License`. |
| **Rent** | A refundable SOL deposit an account holds to stay alive, proportional to its size. |

---

## 2. Three account types, that's the whole state

### `Game` — one per title (64 bytes, 0.00097536 SOL rent)

| Field | Purpose |
|---|---|
| `authority` | The developer's wallet. Receives the money on every sale. |
| `game_id` | Our own numeric id (1, 2, 3…), used as the PDA seed. |
| `price_lamports` | Sale price. 1 SOL = 1,000,000,000 lamports. |
| `license_count` | How many copies have sold. Also the seed for the next licence, so it guarantees unique addresses. |

### `License` — one per purchased copy (129 bytes, 0.00130556 SOL rent)

| Field | Purpose |
|---|---|
| `game` | Which `Game` account this is a copy of. |
| `id` | Copy number (0, 1, 2…) within that game. |
| `owner` | **The wallet that owns this copy.** This is the entitlement. |
| `borrower` | `Option<Pubkey>` — who it's currently lent to, or `None`. |
| `expiry` | Unix timestamp the loan ends. Meaningless unless `borrower` is set. |
| `purchased_at` | Unix timestamp of purchase. |

### `Listing` — one per copy currently for sale (80 bytes, 0.00105664 SOL rent)

Only exists while a copy is on the market. **Its existence is the "for sale" flag** — there's no
`for_sale: bool` anywhere.

| Field | Purpose |
|---|---|
| `license` | Which copy is for sale. Stored explicitly because a PDA can't be reversed into its seeds, so a client listing all sales would otherwise have no way to tell what each refers to. |
| `seller` | Who listed it, and who gets paid. |
| `price_lamports` | The asking price. `0` is legal — that's a giveaway. |

Deliberately a **separate account** rather than extra fields on `License`: adding fields would have
changed `License`'s size, and the licences already live on devnet (129 bytes) would no longer
deserialize. A separate account means listings can come and go with zero migration.

That's it. No collection registry, no user profile, no global state.

---

## 3. So what *is* a licence?

**A licence is one `License` account whose `owner` field holds your wallet address.** Nothing more
exotic than that.

Note what it deliberately is **not**:

- **Not an NFT / SPL token.** We wrote a bespoke program account instead of minting a token.
  - *Why:* full control over the lend rules, no fighting the token program, far less code, and no
    dependency on Token-2022 extension behaviour. Fast to build and easy to reason about.
  - *The cost:* no wallet or marketplace knows what it is. It will **not** appear in Phantom's
    collectibles tab, and no NFT marketplace can list it. Anything that wants to display or trade
    these licences has to be written against our IDL.
  - This is the fork in the road the context doc flagged (§6 fallback). We took the bespoke-account
    branch. Moving to Token-2022 later would buy wallet/marketplace support and native
    fee-on-transfer royalties, at the cost of a rewrite.
- **Not a key or a file.** It grants nothing technically — it's a *record of entitlement*. Something
  on the player's machine still has to read it and refuse to launch. The chain does not enforce
  anything on your PC (see the honest-weaknesses section of the context doc).

---

## 4. How ownership is verified

This is the important bit, and it's verified in four different places at four different levels of
trust.

### 4.0 First, untangle the two "owners"

This trips up everyone new to Solana:

| | What it is | Who sets it |
|---|---|---|
| The account's **metadata owner** | The *program* allowed to modify this account. For our licences it's our program ID. | The Solana runtime, at creation. Unforgeable. |
| Our **`owner` field** | The *player's wallet* that owns the copy. Just 32 bytes of data we chose to call `owner`. | Our program logic. |

So a licence is "owned by the program" (runtime-level) *and* "owned by a player" (our field). Both
statements are true and they mean different things.

### 4.1 Write path — proving you are the owner

To lend, `Lend` requires:

```rust
pub owner: Signer<'info>,                      // must have signed the transaction
#[account(mut, has_one = owner)]               // license.owner must equal owner.key()
pub license: Account<'info, License>,
```

- `Signer` means the Solana **runtime** verified a real cryptographic signature from that keypair
  before our code ran. We never check a password or a session token; we can't be tricked by a
  spoofed request.
- `has_one = owner` compares the stored `owner` field against the signer's key and aborts otherwise.

Together: *only the holder of the private key recorded in `owner` can lend the copy.* This is tested
(`a_stranger_cannot_lend_someone_elses_licence` — fails with `ConstraintHasOne`).

### 4.2 Read path — proving the account is genuine

`Account<'info, License>` is not just a type annotation. When the account is loaded, Anchor checks:

1. the account's metadata owner is **our program** — so you can't hand us an account you created
   yourself and control, and
2. the first 8 bytes match the `License` **discriminator** — so you can't pass a `Game`, or a
   look-alike struct, in its place.

Without those two checks an attacker could fabricate an account claiming any `owner` they liked.
This is why a fake licence can't be forged: you'd need our program to have written it.

### 4.3 Client queries — convenience, not proof

The web page finds your library with `getProgramAccounts`, filtering on the raw bytes of the `owner`
field (offset 48):

```js
program.account.license.all([{ memcmp: { offset: 48, bytes: wallet.toBase58() } }])
```

Anchor only returns accounts owned by our program with the right discriminator, so the results are
trustworthy. **But the query itself is a convenience.** A launcher that actually gates gameplay must
do the check itself (fetch the account, confirm the program owns it, deserialize, compare `owner`) —
never trust a store's API saying "yes, they own it". That independence is the whole portability
claim.

That check is built, as a deliberately separate app in `launcher/` (see the README). Two points worth
carrying into the pitch:

- **Verification needs no on-chain program.** It is a read: no transaction, no fee, nothing signed,
  no deployed code required. Anyone can verify any wallet's entitlement from a pasted address. Adding
  a second on-chain program to "do verification" would only introduce a dependency and weaken the
  claim.
- **Query shape is a real constraint.** The public devnet RPC rate-limits `getProgramAccounts`
  aggressively (HTTP 429). The first version of the verifier queried per game and got throttled
  immediately. The fix: two calls per wallet (owned + borrowed, across all games), then decide each
  game locally. Deciding locally also makes the expiry countdown free — the verdict re-derives from
  the clock with no refetch, so access flips on screen the instant a loan lapses.

### 4.4 The playability rule

Ownership alone doesn't decide who can play. Both the program and the UI apply the identical rule:

> if `borrower` is set **and** `expiry > now` → **the borrower** plays; otherwise → **the owner** plays.

The comparison is written the same way in `lend.rs` and in `isOnLoan()` in `app/src/chain.js`. If
those two ever drift, the UI would offer to lend a copy the chain then refuses — worth keeping in
mind when adding `resell`.

---

## 4.5 Resale: how a sale happens without the seller signing

This is the most interesting mechanic in the program, and the part worth explaining to a judge.

**The naive design fails.** A sale needs the buyer's signature (nobody can spend their SOL without
it). If it *also* needed the seller's signature in the same transaction, both parties would have to
be online at the same moment, co-signing one transaction — hopeless for a real used-game market and
awkward even in a two-window demo.

**So the consent is split in time:**

1. `list_for_sale(price)` — the seller signs **once**, creating a `Listing`. That transaction *is*
   their consent to sell at that price.
2. `buy_listed()` — the buyer signs **alone**, possibly days later. The program takes their SOL,
   splits it, rewrites `license.owner`, and closes the listing. The seller is a *non-signer* account
   that merely receives lamports.

The reason step 2 can move someone else's property without their signature: **the `License` is a PDA
owned by our program.** It has no private key; the seller never could write to it directly. Only the
program can, and the program's rules say the listing authorises exactly this. That's what "atomic
settlement between strangers" in the context doc actually means in code.

Both halves of the trade happen in one transaction, so there is no moment where the buyer has paid
but doesn't own the copy, and no escrow account holding funds in between.

**The royalty split** (`ROYALTY_BPS = 1000`, i.e. 10%):

```
royalty   = price * 1000 / 10000      // to game.authority
to_seller = price - royalty           // rounding dust favours the seller
```

Both transfers are System Program CPIs from the buyer, and the recipients are pinned by constraints
(`address = game.authority`, `address = license.owner`), so a malicious frontend cannot redirect
either leg. Because the rule lives in the program rather than in a marketplace, **every resale pays
the developer, however many times the copy changes hands** — tested to a third owner. This is the
thing centralised NFT marketplaces failed to enforce in 2022–23.

Other rules worth knowing:

- **A copy on loan cannot be listed or sold** (`CannotSellWhileLentOut`), so a borrower never loses
  access mid-loan and a buyer never buys something someone else is playing.
- **A sale hands over a clean copy.** `borrower` and `expiry` are reset, so a lapsed loan record
  doesn't follow the copy to its new owner.
- **`cancel_listing`** withdraws an offer and refunds the listing's rent to the seller. Without it a
  copy would be stuck at its original asking price forever.
- **Price `0` is a giveaway, not a bug.** That's complaint #3 in the context doc ("can't give away a
  copy you're finished with") handled by the same code path, with no royalty on a zero-value trade.
- **The seller cannot buy their own listing** (`CannotBuyYourOwnListing`) — it would just burn a
  royalty for nothing.

---

## 5. PDA seed design (and why owner is not in the seeds)

| Account | Seeds | Address depends on |
|---|---|---|
| `Game` | `["game", game_id]` | the game id only |
| `License` | `["license", game_pubkey, license_id]` | which game + which copy |
| `Listing` | `["listing", license_pubkey]` | which copy is for sale (so one copy can only have one listing — `init` fails on a duplicate) |

The deliberate decision: **`owner` is not a seed.** Ownership is *mutable data at a fixed address*,
not part of the address.

If the owner were in the seeds, then reselling a copy would change its address — every saved link,
cached reference and external record pointing at that licence would break, and the program would
have to close one account and open another on every trade. Keeping the address stable means
`resell` can be a one-line field update.

`license_count` as the copy id is what makes each address unique. Note this has a **race
condition**: two people buying the same game in the same moment derive the same PDA, and the second
transaction fails with "account already in use". Acceptable for a demo; a real version would use a
different id scheme.

---

## 6. Byte layout, and a genuine trap

Offsets matter because the client filters on raw bytes.

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 32 | `game` |
| 40 | 8 | `id` |
| 48 | 32 | `owner` |
| 80 | 1 | `borrower` Option tag (0 = None, 1 = Some) |
| 81 | 32 | `borrower` key (only present when the tag is 1) |

**The trap: `Option<Pubkey>` is variable length in borsh.** `None` serializes to 1 byte, `Some` to 33.
So every field *after* `borrower` physically moves depending on whether the copy is on loan.
Verified on the live accounts:

| | `expiry` actually lives at |
|---|---|
| Never lent (`None`) | byte **81** |
| Lent (`Some`) | byte **113** |

Consequences:

- **Never byte-filter on `expiry` or `purchased_at`.** There is no single correct offset. (Anchor's
  deserializer is fine — it reads sequentially — so `.fetch()` always returns the right values.)
- The `borrower` filter matches **33 bytes starting at offset 80**, tag included. Matching from 81
  alone could in principle collide with a never-lent account's unrelated tail bytes; including the
  tag makes a `None` account impossible to match.
- `#[derive(InitSpace)]` reserves the maximum (33 bytes), so the account is 129 bytes whether lent or
  not, and **never needs resizing** when a loan starts. Measured: both states allocate 129 bytes.

---

## 7. Where the money goes

`buy` transfers `price_lamports` from the buyer **straight to the developer's wallet** via a CPI
(cross-program invocation) to the System Program. There is no escrow and the program never holds
funds.

- *Why:* no withdrawal step to build, no pot of money to secure, and the developer is paid
  atomically in the same transaction that creates the licence. Both happen or neither does.
- The recipient is pinned by `#[account(mut, address = game.authority)]`, so a malicious frontend
  **cannot redirect the payment** — the instruction fails if the account passed isn't the one
  recorded on-chain.
- Separately, the buyer pays ~0.0013 SOL of rent for the licence account itself. That deposit is
  recoverable only by closing the account, and we have no close instruction, so treat it as sunk.

---

## 8. The lending model

- The owner sets `borrower` and `expiry`. **Ownership never moves** — asserted in the tests.
- **There is no return instruction.** The loan lapses because the clock passes `expiry`. Nobody has
  to be online, no transaction is needed, and a crashed or vanished borrower cannot strand the
  licence. This is a deliberate contrast with an on-chain lock.
- **The borrower never signs.** Lending is unilateral, like handing someone a disc — they need no
  SOL and needn't ever have used the chain. (It also means you can lend to a typo'd address, and
  it's gone until expiry.)
- After expiry the `borrower` field is **left as `Some(...)`**, stale. That's harmless because every
  read applies `expiry > now`, but it means *`borrower` being set never by itself means "currently
  lent"*. Always check the timestamp too.
- Re-lending is allowed only once the previous loan has lapsed (`AlreadyLentOut` otherwise), so a
  copy can never be out to two people at once.
- Loans are capped at 30 days (`MAX_LOAN_MINUTES`). Without a cap, a 99-year "loan" would be a
  transfer in disguise that dodges the resale royalty.
- `Clock::get()` is the cluster's notion of time, which can drift slightly from your wall clock, so
  a countdown in the UI is approximate to within a few seconds.

---

## 9. Gotchas worth remembering

1. **Anchor 1.x changed `CpiContext::new`.** It now takes a `Pubkey`, not an `AccountInfo`:
   `CpiContext::new(anchor_lang::system_program::ID, accounts)`. Nearly every tutorial online shows
   the old 0.3x form and will not compile. This cost a build cycle.
2. **Field order in an `Accounts` struct is load-bearing.** `developer`'s `address = game.authority`
   constraint only works because `game` is declared *above* it — Anchor validates in declaration
   order, so a constraint can only reference already-validated accounts. Reordering the struct
   breaks it in a confusing way.
3. **The IDL is a build artefact and goes stale.** The web app imports a *copy* of
   `target/idl/game_license.json`. Adding `lend` and forgetting to re-copy produced
   `program.methods.lend is not a function`. `npm run dev` re-copies automatically (`predev`), but
   running a script directly does not — run `npm run sync-idl` after any program change.
4. **Deploying is not running.** `anchor deploy` only uploads code. Nothing executes, and no logs
   exist, until a transaction invokes an instruction.
5. **Reading logs is how you debug.** `connection.getTransaction(sig).meta.logMessages` returns the
   program's `msg!()` output. Anchor errors appear there by name (`Error Code: AlreadyLentOut`),
   which is also how the tests assert a failure happened *for the right reason*.
6. **LiteSVM can time-travel.** `svm.set_sysvar(&clock)` with an advanced `unix_timestamp` is how
   expiry is tested in 0.17 seconds instead of waiting 10 real minutes.

---

## 10. Measured costs

| | Value |
|---|---|
| `buy` compute | ~12,600–14,100 CU of the 200,000 default budget |
| `lend` compute | ~4,900 CU |
| `buy_listed` compute | ~14,500 CU (two transfers + an account close) |
| Transaction fee | ~0.000005 SOL (5,000 lamports), the standard base fee |
| `Game` account | 64 bytes, 0.00097536 SOL rent |
| `License` account | 129 bytes, 0.00130556 SOL rent |
| `Listing` account | 80 bytes, 0.00105664 SOL rent (refunded to the seller when it closes) |

Everything is an order of magnitude under the compute ceiling. A measured devnet resale of 0.2 SOL
paid the seller 0.18 + 0.00105664 rent refund and the developer exactly 0.02.

---

## 11. Known gaps — say these before a judge does

1. **The program is upgradeable, and we hold the key.** The upgrade authority is the deploy wallet,
   which means we could silently replace the rules — including "we never revoke your licence". Until
   that authority is transferred to a multisig or revoked (making the program immutable), the
   "publicly verifiable rules" advantage in the pitch is a promise, not a guarantee. Cheap to fix;
   important to be honest about.
2. **Game titles are not on-chain.** Only `game_id` is. The catalog (`app/src/catalog.json`) holds
   "Neon Drifter". So a rival launcher reading the ledger today sees *"this wallet owns copy #0 of
   game 1"* and has no idea what game 1 is — which dents the portability claim that the whole project
   rests on. Fixing it needs either on-chain metadata or a shared registry.
3. **Anyone can call `create_game`.** There's no check that you're the real publisher. Fine for a
   demo, needs an allowlist or signature check in reality.
4. **The royalty rate is a program constant (10%), not a per-game setting.** A real version would put
   `royalty_bps` on the `Game` account so each developer picks their own. It's a constant here purely
   to avoid changing the layout of the `Game` accounts already deployed.
5. **Listings are open to anyone, not directed at a named buyer.** The context doc sketched
   `resell(buyer, price)`; what's built is an open offer any wallet can take. That's a better fit for
   a real used-copy market, but "sell privately to this specific friend" would need a
   `restricted_to: Option<Pubkey>` on the `Listing`.
6. **A listed copy can still be lent out**, which then blocks its own sale until the loan expires
   (the buyer's transaction fails with `CannotSellWhileLentOut`). Harmless — the seller only
   inconveniences themselves — but the state machine isn't airtight. Closing it properly means
   passing the listing account into `lend` so it can refuse.
7. **Buy has a race condition** on `license_count` (see §5).
8. **No account recovery.** Lose the key, lose the library. Unchanged from the context doc.
9. **The ledger is public.** Every purchase and loan is visible forever, tied to a wallet. A real
   privacy regression against a private Steam library.
