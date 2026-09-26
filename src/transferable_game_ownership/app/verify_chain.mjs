// Exercises the app's real data layer (src/chain.js) against devnet without a browser.
// Verifies the exact shapes App.jsx renders. Run: node verify_chain.mjs
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, fetchLibrary, fetchStore, getProgram } from "./src/chain.js";

const program = getProgram(null);
console.log("Program:", program.programId.toBase58());

console.log("\n--- fetchStore() ---");
const store = await fetchStore(program);
for (const g of store) {
  console.log(
    `${g.listed ? "✓" : "·"} ${g.title.padEnd(18)}`,
    g.listed
      ? `${(g.priceLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL · ${g.soldCount} sold · dev ${g.developer
          .toBase58()
          .slice(0, 8)}…`
      : "NOT LISTED on-chain"
  );
}

const buyer = new PublicKey(
  JSON.parse(fs.readFileSync("../.keys/buyer.json", "utf8")).slice(32)
);
console.log("\n--- fetchLibrary() for", buyer.toBase58(), "---");
const library = await fetchLibrary(program, buyer);
for (const l of library) {
  console.log(
    `  ${l.title.padEnd(18)} copy #${l.licenseId} · ${new Date(
      l.purchasedAt * 1000
    ).toLocaleString()} · borrower: ${l.borrower ?? "none"}`
  );
}
console.log("total licenses:", library.length);
