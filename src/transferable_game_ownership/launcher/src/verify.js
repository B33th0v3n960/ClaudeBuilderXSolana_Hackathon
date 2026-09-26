/**
 * Standalone licence verifier.
 *
 * This file deliberately shares NO code with the store app. It needs only two public things — the
 * program's ID and its IDL — and talks only to a public Solana RPC. There is no store API, no
 * database, and no account with anybody. That independence is the point: a rival launcher could
 * ship this without asking anyone's permission, and it keeps working if the store disappears.
 *
 * Verification is a *read*. No transaction is sent, no fee is paid, nothing is signed.
 *
 * Shape of the work: `fetchEntitlements` makes exactly TWO RPC calls for a wallet, whatever the
 * size of the catalog, and `verdictFor` then decides each game locally with no network at all.
 * Per-game queries are what get you rate-limited off the public devnet endpoint, and a verdict that
 * re-checks the clock without re-querying is also how the expiry countdown stays live for free.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "./idl/game_license.json" with { type: "json" };
import games from "./games.json" with { type: "json" };

export const RPC_URL = "https://api.devnet.solana.com";
export const CLUSTER = "devnet";
export const PROGRAM_ID = idl.address;

export const connection = new Connection(RPC_URL, "confirmed");

// License layout: 8 discriminator + 32 game + 8 id + 32 owner, then the borrower Option tag.
const OWNER_OFFSET = 48;
const BORROWER_TAG_OFFSET = 80;

// Anchor insists on a wallet even for reads it will never sign, so hand it a stub that can't sign.
const NO_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("verifier is read-only")),
  signAllTransactions: () => Promise.reject(new Error("verifier is read-only")),
};

export function getProgram() {
  return new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, NO_WALLET, { commitment: "confirmed" })
  );
}

export function gamePda(programId, gameId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), new anchor.BN(gameId).toArrayLike(Buffer, "le", 8)],
    programId
  );
  return pda;
}

/** game account address -> catalog entry. The chain stores only ids; titles are this app's own. */
export function gameIndex(programId) {
  return new Map(games.map((g) => [gamePda(programId, g.id).toBase58(), g]));
}

function borrowerFilterBytes(wallet) {
  const tagged = new Uint8Array(33);
  tagged[0] = 1; // Option::Some
  tagged.set(wallet.toBytes(), 1);
  return anchor.utils.bytes.bs58.encode(tagged);
}

function describe(publicKey, account) {
  return {
    address: publicKey.toBase58(),
    game: account.game.toBase58(),
    copyId: account.id.toNumber(),
    owner: account.owner.toBase58(),
    borrower: account.borrower ? account.borrower.toBase58() : null,
    expiry: account.expiry.toNumber(),
  };
}

/** True when a copy is in the hands of an unexpired borrower. */
export function onLoan(copy, nowSeconds) {
  return copy.borrower !== null && copy.expiry > nowSeconds;
}

/**
 * Everything the chain knows about one wallet's licences. Exactly two RPC calls.
 */
export async function fetchEntitlements(walletAddress) {
  const program = getProgram();
  const wallet = new PublicKey(walletAddress);

  const [ownedRaw, borrowedRaw] = await Promise.all([
    program.account.license.all([
      { memcmp: { offset: OWNER_OFFSET, bytes: wallet.toBase58() } },
    ]),
    program.account.license.all([
      { memcmp: { offset: BORROWER_TAG_OFFSET, bytes: borrowerFilterBytes(wallet) } },
    ]),
  ]);

  return {
    wallet: wallet.toBase58(),
    programId: program.programId.toBase58(),
    rpcUrl: RPC_URL,
    fetchedAt: Math.floor(Date.now() / 1000),
    owned: ownedRaw.map((l) => describe(l.publicKey, l.account)),
    borrowed: borrowedRaw.map((l) => describe(l.publicKey, l.account)),
  };
}

/**
 * May this wallet play this game right now? Pure — no network. Re-run it as the clock ticks and the
 * verdict flips on its own the moment a loan lapses.
 *
 * The rule, identical to the one enforced on-chain:
 *   an unexpired borrower plays; otherwise the owner plays.
 */
export function verdictFor(entitlements, gameAccount, nowSeconds = Date.now() / 1000) {
  const owned = entitlements.owned.filter((c) => c.game === gameAccount);
  const borrowed = entitlements.borrowed.filter((c) => c.game === gameAccount);

  const evidence = {
    ...entitlements,
    gameAccount,
    checkedAt: Math.floor(nowSeconds),
    ownedCopies: owned,
    borrowedCopies: borrowed,
  };

  // A live loan to this wallet is the strongest claim: the borrower plays even though somebody else
  // owns the copy.
  const activeLoan = borrowed.find((c) => onLoan(c, nowSeconds));
  if (activeLoan) {
    return {
      playable: true,
      basis: "borrowed",
      copy: activeLoan,
      until: activeLoan.expiry,
      reason: `Borrowed from ${activeLoan.owner}. Playable until the loan expires.`,
      evidence,
    };
  }

  // Owning a copy entitles you to play only if you haven't lent it out. Owning several means one
  // being on loan doesn't block you.
  const freeCopy = owned.find((c) => !onLoan(c, nowSeconds));
  if (freeCopy) {
    return {
      playable: true,
      basis: "owned",
      copy: freeCopy,
      reason: `This wallet owns copy #${freeCopy.copyId} and it is not lent out.`,
      evidence,
    };
  }

  const lentOut = owned.find((c) => onLoan(c, nowSeconds));
  if (lentOut) {
    return {
      playable: false,
      basis: "lent-out",
      copy: lentOut,
      until: lentOut.expiry,
      reason: `This wallet owns copy #${lentOut.copyId} but has lent it to ${lentOut.borrower}. Access returns automatically when the loan expires.`,
      evidence,
    };
  }

  const expiredLoan = borrowed[0];
  return {
    playable: false,
    basis: expiredLoan ? "loan-expired" : "no-licence",
    copy: expiredLoan ?? null,
    reason: expiredLoan
      ? `A loan of copy #${expiredLoan.copyId} to this wallet has expired. It is back with its owner.`
      : "No licence for this game is recorded on-chain for this wallet.",
    evidence,
  };
}

/** Convenience for one-shot checks (the CLI). Two RPC calls, then a local decision. */
export async function verifyAccess(walletAddress, gameId) {
  const entitlements = await fetchEntitlements(walletAddress);
  const program = getProgram();
  return verdictFor(entitlements, gamePda(program.programId, gameId).toBase58());
}
