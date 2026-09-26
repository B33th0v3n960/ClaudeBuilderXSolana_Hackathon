// Drives the app's real resale path (src/chain.js) against devnet, with no browser.
// buyer.json sells a copy; friend.json buys it. Run from app/: node verify_resell.mjs
import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import {
  LAMPORTS_PER_SOL,
  buyListedLicense,
  cancelListing,
  connection,
  explorerTx,
  fetchLibrary,
  fetchListings,
  getProgram,
  isOnLoan,
  listForSale,
} from "./src/chain.js";

function loadKeypair(p) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const seller = loadKeypair("../.keys/buyer.json");
const buyer = loadKeypair("../.keys/friend.json");
const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6);

const sellerProgram = getProgram(new anchor.Wallet(seller));
const buyerProgram = getProgram(new anchor.Wallet(buyer));

console.log("Seller:", seller.publicKey.toBase58());
console.log("Buyer: ", buyer.publicKey.toBase58());

// The buyer needs SOL to pay with; top up from the seller if they're short.
const buyerBalance = await connection.getBalance(buyer.publicKey);
console.log("Buyer balance:", sol(buyerBalance), "SOL");
if (buyerBalance < 0.3 * LAMPORTS_PER_SOL) {
  console.log("Buyer is short — this script needs it funded manually first.");
  process.exit(1);
}

const library = await fetchLibrary(sellerProgram, seller.publicKey);
const sellable = library.find((l) => !isOnLoan(l));
if (!sellable) {
  console.log("Every copy is out on loan — nothing can be listed until one expires.");
  process.exit(0);
}

const PRICE_SOL = 0.2;
console.log(`\n1. Listing ${sellable.title} copy #${sellable.licenseId} for ${PRICE_SOL} SOL...`);
const listSig = await listForSale(sellerProgram, sellable, PRICE_SOL);
console.log("   tx:", listSig);

let listings = await fetchListings(buyerProgram);
console.log("\n2. Marketplace as the buyer sees it (fetchListings):");
for (const l of listings) {
  console.log(
    `   ${l.title} copy #${l.licenseId} — ${sol(l.priceLamports)} SOL` +
      ` (seller gets ${sol(l.toSeller)}, developer royalty ${sol(l.royalty)})` +
      ` · seller ${l.seller.toBase58().slice(0, 8)}…`
  );
}

const target = listings.find((l) => l.licenseAddress.equals(sellable.address));

// Prove cancellation works, then re-list so the sale can go ahead.
console.log("\n3. Withdrawing the listing to prove cancel works...");
console.log("   tx:", await cancelListing(sellerProgram, sellable.address));
console.log("   listings now:", (await fetchListings(buyerProgram)).length);
console.log("   re-listing...");
await listForSale(sellerProgram, sellable, PRICE_SOL);

const sellerBefore = await connection.getBalance(seller.publicKey);
const devBefore = await connection.getBalance(
  (await sellerProgram.account.game.fetch(target.game)).authority
);

console.log("\n4. Buyer purchases it (seller does not sign)...");
const listing = (await fetchListings(buyerProgram)).find((l) =>
  l.licenseAddress.equals(sellable.address)
);
const buySig = await buyListedLicense(buyerProgram, listing);
console.log("   tx:", buySig);
console.log("   Explorer:", explorerTx(buySig));

const tx = await connection.getTransaction(buySig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
console.log("\n--- program logs ---");
for (const line of tx.meta.logMessages) console.log(line);

const developer = (await sellerProgram.account.game.fetch(target.game)).authority;
const sellerGain = (await connection.getBalance(seller.publicKey)) - sellerBefore;
const devGain = (await connection.getBalance(developer)) - devBefore;

console.log("\n5. Result");
console.log("   seller received:   ", sol(sellerGain), "SOL (includes refunded listing rent)");
console.log("   developer royalty: ", sol(devGain), "SOL");
console.log("   expected royalty:  ", sol(listing.royalty), "SOL");

const sellerLibrary = await fetchLibrary(sellerProgram, seller.publicKey);
const buyerLibrary = await fetchLibrary(buyerProgram, buyer.publicKey);
console.log("   seller still owns that copy:", sellerLibrary.some((l) => l.address.equals(sellable.address)));
console.log("   buyer now owns that copy:   ", buyerLibrary.some((l) => l.address.equals(sellable.address)));
console.log("   open listings remaining:    ", (await fetchListings(buyerProgram)).length);
