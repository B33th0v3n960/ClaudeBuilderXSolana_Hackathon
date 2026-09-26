import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const idl = JSON.parse(
  fs.readFileSync(new URL("../target/idl/game_license.json", import.meta.url), "utf8")
);

function loadKeypair(p) {
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

const developer = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
const buyer = loadKeypair(new URL("../.keys/buyer.json", import.meta.url).pathname);

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

function programFor(payerKeypair) {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payerKeypair), {});
  return new anchor.Program(idl, provider);
}

const GAME_ID = new anchor.BN(1);
const PRICE_LAMPORTS = new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL);

const devProgram = programFor(developer);
const [game] = PublicKey.findProgramAddressSync(
  [Buffer.from("game"), GAME_ID.toArrayLike(Buffer, "le", 8)],
  devProgram.programId
);

console.log("Developer:", developer.publicKey.toBase58());
console.log("Buyer:    ", buyer.publicKey.toBase58());
console.log("Game PDA: ", game.toBase58());

let gameAccount = await connection.getAccountInfo(game);
if (!gameAccount) {
  console.log("\nCreating game (price: 0.1 SOL)...\n");
  const sig = await devProgram.methods
    .createGame(GAME_ID, PRICE_LAMPORTS)
    .accounts({ authority: developer.publicKey, game, systemProgram: anchor.web3.SystemProgram.programId })
    .rpc();
  console.log("create_game tx:", sig);
} else {
  console.log("\nGame already exists, skipping create_game.\n");
}

const gameState = await devProgram.account.game.fetch(game);
const licenseId = gameState.licenseCount;
const [license] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("license"),
    game.toBuffer(),
    licenseId.toArrayLike(Buffer, "le", 8),
  ],
  devProgram.programId
);

console.log("Next license PDA:", license.toBase58(), "(id", licenseId.toString(), ")");

const devBalanceBefore = await connection.getBalance(developer.publicKey);

const buyProgram = programFor(buyer);
console.log("\nBuyer purchasing license...\n");
const buySig = await buyProgram.methods
  .buy()
  .accounts({
    buyer: buyer.publicKey,
    game,
    developer: developer.publicKey,
    license,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .rpc();

console.log("buy tx:", buySig);
console.log("Explorer:", `https://explorer.solana.com/tx/${buySig}?cluster=devnet`);

const tx = await connection.getTransaction(buySig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
console.log("\n--- Program logs ---");
for (const line of tx.meta.logMessages) console.log(line);

const licenseState = await buyProgram.account.license.fetch(license);
const devBalanceAfter = await connection.getBalance(developer.publicKey);

console.log("\n--- Result ---");
console.log("License owner:      ", licenseState.owner.toBase58());
console.log("Is buyer the owner? ", licenseState.owner.equals(buyer.publicKey));
console.log("Developer paid:      ", (devBalanceAfter - devBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL, "SOL");
