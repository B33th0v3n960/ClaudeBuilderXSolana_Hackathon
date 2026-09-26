import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";

const idl = JSON.parse(
  fs.readFileSync(new URL("../target/idl/game_license.json", import.meta.url), "utf8")
);

// License layout: 8 discriminator + 32 game + 8 id, so `owner` starts at byte 48.
const LICENSE_OWNER_OFFSET = 48;

const developer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")))
);
const buyer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(new URL("../.keys/buyer.json", import.meta.url).pathname, "utf8")))
);

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(developer), {});
const program = new anchor.Program(idl, provider);

console.log("--- all games ---");
for (const g of await program.account.game.all()) {
  console.log(
    g.publicKey.toBase58(),
    "game_id:", g.account.gameId.toString(),
    "price:", g.account.priceLamports.toNumber() / anchor.web3.LAMPORTS_PER_SOL, "SOL",
    "sold:", g.account.licenseCount.toString()
  );
}

console.log("\n--- all licenses ---");
for (const l of await program.account.license.all()) {
  console.log(l.publicKey.toBase58(), "owner:", l.account.owner.toBase58(), "id:", l.account.id.toString());
}

console.log("\n--- licenses filtered to buyer", buyer.publicKey.toBase58(), "---");
const owned = await program.account.license.all([
  { memcmp: { offset: LICENSE_OWNER_OFFSET, bytes: buyer.publicKey.toBase58() } },
]);
for (const l of owned) {
  console.log(l.publicKey.toBase58(), "game:", l.account.game.toBase58(), "id:", l.account.id.toString());
}
console.log("count:", owned.length);
