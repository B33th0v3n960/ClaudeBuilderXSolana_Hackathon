import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "./idl/game_license.json" with { type: "json" };
import catalog from "./catalog.json" with { type: "json" };

export const CLUSTER = "devnet";
export const connection = new Connection("https://api.devnet.solana.com", "confirmed");
export const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;

// License layout: 8 discriminator + 32 game + 8 id, so `owner` starts at byte 48.
const LICENSE_OWNER_OFFSET = 48;
// `borrower` is an Option<Pubkey> right after owner: a 1-byte tag at 80, then the key. Matching
// from byte 80 with the tag included means a never-lent licence (tag 0) can never match.
const LICENSE_BORROWER_TAG_OFFSET = 80;

// Anchor requires a wallet on the provider even for reads it will never sign.
const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only wallet")),
  signAllTransactions: () => Promise.reject(new Error("read-only wallet")),
};

export function getProgram(wallet) {
  const provider = new anchor.AnchorProvider(connection, wallet ?? READ_ONLY_WALLET, {
    commitment: "confirmed",
  });
  return new anchor.Program(idl, provider);
}

export function gamePda(programId, gameId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), new anchor.BN(gameId).toArrayLike(Buffer, "le", 8)],
    programId
  );
  return pda;
}

/** Developer's cut of a resale, in basis points. Mirrors ROYALTY_BPS in the program. */
export const ROYALTY_BPS = 1000;

/** The 90/10 split the program will apply. Kept here so the UI can show it before you commit. */
export function splitPrice(priceLamports) {
  const royalty = Math.floor((priceLamports * ROYALTY_BPS) / 10_000);
  return { royalty, toSeller: priceLamports - royalty };
}

export function listingPda(programId, license) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), license.toBuffer()],
    programId
  );
  return pda;
}

export function licensePda(programId, game, licenseId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("license"), game.toBuffer(), new anchor.BN(licenseId).toArrayLike(Buffer, "le", 8)],
    programId
  );
  return pda;
}

/**
 * Catalog metadata (titles, art) is deliberately off-chain; price and copies-sold come from the
 * on-chain Game account. `listed: false` means nobody has run create_game for that id yet.
 */
export async function fetchStore(program) {
  const pdas = catalog.map((entry) => gamePda(program.programId, entry.id));
  const accounts = await program.account.game.fetchMultiple(pdas);

  return catalog.map((entry, i) => {
    const account = accounts[i];
    return {
      ...entry,
      pda: pdas[i],
      listed: account !== null,
      priceLamports: account ? account.priceLamports.toNumber() : null,
      soldCount: account ? account.licenseCount.toNumber() : 0,
      developer: account ? account.authority : null,
    };
  });
}

function catalogByGamePda(program) {
  return new Map(catalog.map((e) => [gamePda(program.programId, e.id).toBase58(), e]));
}

function toLicenseView(program, { publicKey, account }, lookup) {
  const entry = lookup.get(account.game.toBase58());
  const expiry = account.expiry.toNumber();
  return {
    address: publicKey,
    licenseId: account.id.toNumber(),
    owner: account.owner,
    borrower: account.borrower,
    expiry,
    purchasedAt: account.purchasedAt.toNumber(),
    title: entry?.title ?? "Unknown game",
    accent: entry?.accent ?? "#8a8f98",
  };
}

/** Licences this wallet owns — including ones it has lent out, which it still owns. */
export async function fetchLibrary(program, owner) {
  const licenses = await program.account.license.all([
    { memcmp: { offset: LICENSE_OWNER_OFFSET, bytes: owner.toBase58() } },
  ]);
  const lookup = catalogByGamePda(program);
  return licenses
    .map((l) => toLicenseView(program, l, lookup))
    .sort((a, b) => a.purchasedAt - b.purchasedAt);
}

/** Licences lent *to* this wallet. Someone else still owns these. */
export async function fetchBorrowed(program, borrower) {
  const tagged = new Uint8Array(33);
  tagged[0] = 1; // Option::Some
  tagged.set(borrower.toBytes(), 1);

  const licenses = await program.account.license.all([
    {
      memcmp: {
        offset: LICENSE_BORROWER_TAG_OFFSET,
        bytes: anchor.utils.bytes.bs58.encode(tagged),
      },
    },
  ]);
  const lookup = catalogByGamePda(program);
  return licenses
    .map((l) => toLicenseView(program, l, lookup))
    .sort((a, b) => b.expiry - a.expiry);
}

/**
 * The playability rule: an unexpired borrower plays, otherwise the owner does. `nowSeconds` is the
 * wall clock, which is what the on-chain expiry is compared against.
 */
export function isOnLoan(license, nowSeconds = Date.now() / 1000) {
  return license.borrower !== null && license.expiry > nowSeconds;
}

/**
 * Every copy currently for sale, joined to its licence and catalog entry. The `Listing` account's
 * existence is the for-sale flag, so this is just "fetch all listings".
 */
export async function fetchListings(program) {
  const listings = await program.account.listing.all();
  if (listings.length === 0) return [];

  const licenses = await program.account.license.fetchMultiple(
    listings.map((l) => l.account.license)
  );
  const lookup = catalogByGamePda(program);

  return listings
    .map(({ publicKey, account }, i) => {
      const license = licenses[i];
      if (!license) return null; // listing whose licence vanished; nothing sensible to show
      const entry = lookup.get(license.game.toBase58());
      const priceLamports = account.priceLamports.toNumber();
      return {
        listingAddress: publicKey,
        licenseAddress: account.license,
        seller: account.seller,
        priceLamports,
        ...splitPrice(priceLamports),
        licenseId: license.id.toNumber(),
        game: license.game,
        title: entry?.title ?? "Unknown game",
        accent: entry?.accent ?? "#8a8f98",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.priceLamports - b.priceLamports);
}

export async function listForSale(program, license, priceSol) {
  return program.methods
    .listForSale(new anchor.BN(Math.round(priceSol * LAMPORTS_PER_SOL)))
    .accounts({
      owner: program.provider.wallet.publicKey,
      license: license.address,
      listing: listingPda(program.programId, license.address),
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
}

export async function cancelListing(program, licenseAddress) {
  return program.methods
    .cancelListing()
    .accounts({
      seller: program.provider.wallet.publicKey,
      license: licenseAddress,
      listing: listingPda(program.programId, licenseAddress),
    })
    .rpc();
}

/** The buyer completes the sale alone — the seller's consent was the listing itself. */
export async function buyListedLicense(program, listing) {
  const game = await program.account.game.fetch(listing.game);
  return program.methods
    .buyListed()
    .accounts({
      buyer: program.provider.wallet.publicKey,
      game: listing.game,
      developer: game.authority,
      license: listing.licenseAddress,
      seller: listing.seller,
      listing: listing.listingAddress,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
}

export async function lendLicense(program, license, borrowerAddress, minutes) {
  const borrower = new PublicKey(borrowerAddress);
  return program.methods
    .lend(borrower, new anchor.BN(minutes))
    .accounts({ owner: program.provider.wallet.publicKey, license: license.address })
    .rpc();
}

export async function buyLicense(program, game) {
  // license_count is the seed for the next license PDA, so read it fresh right before buying.
  const gameAccount = await program.account.game.fetch(game.pda);
  const license = licensePda(program.programId, game.pda, gameAccount.licenseCount);

  return program.methods
    .buy()
    .accounts({
      buyer: program.provider.wallet.publicKey,
      game: game.pda,
      developer: gameAccount.authority,
      license,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
}

export function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

export function explorerAddress(address) {
  return `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;
}
