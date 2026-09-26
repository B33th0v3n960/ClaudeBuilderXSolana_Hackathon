// Drives the app's real lend path (src/chain.js) against devnet, with no browser.
// The owner keypair is .keys/buyer.json, the borrower .keys/friend.json.
// Run from app/: node verify_lend.mjs
import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import {
  connection,
  explorerTx,
  fetchBorrowed,
  fetchLibrary,
  getProgram,
  isOnLoan,
  lendLicense,
} from "./src/chain.js";

function loadKeypair(relPath) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(relPath, "utf8"))));
}

const owner = loadKeypair("../.keys/buyer.json");
const friend = loadKeypair("../.keys/friend.json");

const program = getProgram(new anchor.Wallet(owner));
console.log("Owner (lender):", owner.publicKey.toBase58());
console.log("Friend (borrower):", friend.publicKey.toBase58());

const library = await fetchLibrary(program, owner.publicKey);
console.log("\nOwner's library:");
for (const l of library) {
  console.log(
    `  ${l.title} copy #${l.licenseId} — ${isOnLoan(l) ? `LENT OUT until ${new Date(l.expiry * 1000).toLocaleTimeString()}` : "playable by owner"}`
  );
}

const lendable = library.find((l) => !isOnLoan(l));
if (!lendable) {
  console.log("\nEvery copy is already on loan; nothing to lend. Wait for one to expire.");
  process.exit(0);
}

console.log(`\nLending ${lendable.title} copy #${lendable.licenseId} to friend for 10 minutes...`);
const sig = await lendLicense(program, lendable, friend.publicKey.toBase58(), 10);
console.log("lend tx:", sig);
console.log("Explorer:", explorerTx(sig));

const tx = await connection.getTransaction(sig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
console.log("\n--- program logs ---");
for (const line of tx.meta.logMessages) console.log(line);

// The borrower-side query the app's "Borrowed" section depends on.
const borrowed = await fetchBorrowed(program, friend.publicKey);
console.log("\n--- fetchBorrowed(friend) ---");
for (const l of borrowed) {
  console.log(
    `  ${l.title} copy #${l.licenseId} · owner ${l.owner.toBase58().slice(0, 8)}… · playable until ${new Date(l.expiry * 1000).toLocaleTimeString()} · onLoan=${isOnLoan(l)}`
  );
}

// And confirm the owner now sees it as lent out rather than playable.
const ownerAfter = await fetchLibrary(program, owner.publicKey);
const same = ownerAfter.find((l) => l.address.equals(lendable.address));
console.log("\n--- owner's view of that same copy ---");
console.log("  still owned by owner:", same.owner.equals(owner.publicKey));
console.log("  borrower recorded:   ", same.borrower?.toBase58());
console.log("  owner can play now:  ", !isOnLoan(same), "(false is correct — it's lent out)");
