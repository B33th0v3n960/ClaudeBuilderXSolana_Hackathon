import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import catalog from "../app/src/catalog.json" with { type: "json" };

const idl = JSON.parse(
  fs.readFileSync(new URL("../target/idl/game_license.json", import.meta.url), "utf8")
);

const developer = Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))
  )
);

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(developer), {
  commitment: "confirmed",
});
const program = new anchor.Program(idl, provider);

console.log("Developer (receives all sale proceeds):", developer.publicKey.toBase58());

for (const entry of catalog) {
  const [game] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), new anchor.BN(entry.id).toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  const existing = await connection.getAccountInfo(game);
  if (existing) {
    const account = await program.account.game.fetch(game);
    console.log(
      `· ${entry.title} (id ${entry.id}) already listed at`,
      account.priceLamports.toNumber() / anchor.web3.LAMPORTS_PER_SOL,
      "SOL —",
      account.licenseCount.toString(),
      "sold"
    );
    continue;
  }

  const price = new anchor.BN(entry.seedPriceSol * anchor.web3.LAMPORTS_PER_SOL);
  const sig = await program.methods
    .createGame(new anchor.BN(entry.id), price)
    .accounts({
      authority: developer.publicKey,
      game,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`✓ listed ${entry.title} (id ${entry.id}) at ${entry.seedPriceSol} SOL — tx ${sig}`);
}
