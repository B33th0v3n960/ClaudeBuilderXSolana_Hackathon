// Runs the launcher's verifier from the terminal, against live devnet.
// Usage: node verify_cli.mjs [walletAddress]
//        node verify_cli.mjs            -> checks the demo keypairs
import fs from "fs";
import { Keypair } from "@solana/web3.js";
import games from "./src/games.json" with { type: "json" };
import {
  PROGRAM_ID,
  RPC_URL,
  fetchEntitlements,
  gamePda,
  getProgram,
  verdictFor,
} from "./src/verify.js";

function keyFrom(path) {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8")))
  ).publicKey.toBase58();
}

console.log("Program:", PROGRAM_ID);
console.log("RPC:    ", RPC_URL, "(no store server involved)");

const arg = process.argv[2];
const wallets = arg
  ? [["cli        ", arg]]
  : [
      ["buyer.json ", keyFrom("../.keys/buyer.json")],
      ["friend.json", keyFrom("../.keys/friend.json")],
    ];

const programId = getProgram().programId;
const gameAccounts = games.map((g) => ({ ...g, account: gamePda(programId, g.id).toBase58() }));

for (const [label, wallet] of wallets) {
  const entitlements = await fetchEntitlements(wallet);
  console.log(`\n=== ${label}  ${wallet} ===`);
  console.log(
    `    (2 RPC calls: ${entitlements.owned.length} owned, ${entitlements.borrowed.length} borrowed on record)`
  );
  for (const game of gameAccounts) {
    const v = verdictFor(entitlements, game.account);
    console.log(
      `  ${v.playable ? "PLAYABLE" : "BLOCKED "} ${game.title.padEnd(18)} [${v.basis}] ${v.reason}` +
        (v.until ? ` (until ${new Date(v.until * 1000).toLocaleTimeString()})` : "")
    );
  }
}
