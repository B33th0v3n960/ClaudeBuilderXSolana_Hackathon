use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const GAME_ID: u64 = 11;
const PRICE_LAMPORTS: u64 = 100_000_000; // first-sale price, 0.1 SOL
const RESALE_PRICE: u64 = 1_000_000_000; // 1 SOL

fn try_send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> TransactionResult {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx)
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) {
    let res = try_send(svm, ix, payer);
    assert!(res.is_ok(), "transaction failed: {:?}", res.err());
}

fn assert_fails_with(res: TransactionResult, expected: &str) {
    let err = res.expect_err("expected the transaction to fail");
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(expected),
        "expected error `{expected}`, got logs:\n{logs}"
    );
}

fn read_license(svm: &LiteSVM, license: Pubkey) -> game_license::state::License {
    let account = svm.get_account(&license).unwrap();
    let mut data: &[u8] = &account.data;
    game_license::state::License::try_deserialize(&mut data).unwrap()
}

struct World {
    svm: LiteSVM,
    program_id: Pubkey,
    developer: Keypair,
    owner: Keypair,
    game: Pubkey,
    license: Pubkey,
    listing: Pubkey,
}

fn setup() -> World {
    let program_id = game_license::id();
    let developer = Keypair::new();
    let owner = Keypair::new();

    let (game, _) = Pubkey::find_program_address(
        &[game_license::constants::GAME_SEED, &GAME_ID.to_le_bytes()],
        &program_id,
    );
    let (license, _) = Pubkey::find_program_address(
        &[
            game_license::constants::LICENSE_SEED,
            game.as_ref(),
            &0u64.to_le_bytes(),
        ],
        &program_id,
    );
    let (listing, _) = Pubkey::find_program_address(
        &[game_license::constants::LISTING_SEED, license.as_ref()],
        &program_id,
    );

    let mut svm = LiteSVM::new();
    svm.add_program(
        program_id,
        include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/game_license.so"
        )),
    )
    .unwrap();
    svm.airdrop(&developer.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&owner.pubkey(), 5_000_000_000).unwrap();

    let create = Instruction::new_with_bytes(
        program_id,
        &game_license::instruction::CreateGame {
            game_id: GAME_ID,
            price_lamports: PRICE_LAMPORTS,
        }
        .data(),
        game_license::accounts::CreateGame {
            authority: developer.pubkey(),
            game,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, create, &developer);

    let buy = Instruction::new_with_bytes(
        program_id,
        &game_license::instruction::Buy {}.data(),
        game_license::accounts::Buy {
            buyer: owner.pubkey(),
            game,
            developer: developer.pubkey(),
            license,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, buy, &owner);

    World {
        svm,
        program_id,
        developer,
        owner,
        game,
        license,
        listing,
    }
}

impl World {
    fn list_ix(&self, seller: &Keypair, price: u64) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &game_license::instruction::ListForSale {
                price_lamports: price,
            }
            .data(),
            game_license::accounts::ListForSale {
                owner: seller.pubkey(),
                license: self.license,
                listing: self.listing,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn cancel_ix(&self, seller: &Keypair) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &game_license::instruction::CancelListing {}.data(),
            game_license::accounts::CancelListing {
                seller: seller.pubkey(),
                license: self.license,
                listing: self.listing,
            }
            .to_account_metas(None),
        )
    }

    fn buy_listed_ix(&self, buyer: &Keypair, seller: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &game_license::instruction::BuyListed {}.data(),
            game_license::accounts::BuyListed {
                buyer: buyer.pubkey(),
                game: self.game,
                developer: self.developer.pubkey(),
                license: self.license,
                seller,
                listing: self.listing,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn lend_ix(&self, owner: &Keypair, borrower: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            self.program_id,
            &game_license::instruction::Lend {
                borrower,
                minutes: 10,
            }
            .data(),
            game_license::accounts::Lend {
                owner: owner.pubkey(),
                license: self.license,
            }
            .to_account_metas(None),
        )
    }
}

#[test]
fn resale_moves_ownership_and_splits_the_money_90_10() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 5_000_000_000).unwrap();

    let ix = w.list_ix(&owner, RESALE_PRICE);
    send(&mut w.svm, ix, &owner);

    // The listing's rent is refunded to the seller when it closes, so count it separately.
    let listing_rent = w.svm.get_balance(&w.listing).unwrap();
    let seller_before = w.svm.get_balance(&owner.pubkey()).unwrap();
    let developer_before = w.svm.get_balance(&w.developer.pubkey()).unwrap();

    let ix = w.buy_listed_ix(&buyer, owner.pubkey());
    send(&mut w.svm, ix, &buyer);

    let state = read_license(&w.svm, w.license);
    assert_eq!(state.owner, buyer.pubkey());
    // The copy arrives clean, carrying no loan record from the previous owner.
    assert!(state.borrower.is_none());
    assert_eq!(state.expiry, 0);

    // 90% to the seller, 10% to the developer, settled in the same transaction.
    let seller_gain = w.svm.get_balance(&owner.pubkey()).unwrap() - seller_before;
    let developer_gain = w.svm.get_balance(&w.developer.pubkey()).unwrap() - developer_before;
    assert_eq!(developer_gain, RESALE_PRICE / 10);
    assert_eq!(seller_gain, RESALE_PRICE / 10 * 9 + listing_rent);

    // The listing is gone, so the same copy cannot be sold twice.
    let listing_account = w.svm.get_account(&w.listing);
    assert!(listing_account.is_none() || listing_account.unwrap().data.is_empty());
}

#[test]
fn the_new_owner_can_lend_and_the_old_owner_cannot() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let buyer = Keypair::new();
    let friend = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 5_000_000_000).unwrap();

    let ix = w.list_ix(&owner, RESALE_PRICE);
    send(&mut w.svm, ix, &owner);
    let ix = w.buy_listed_ix(&buyer, owner.pubkey());
    send(&mut w.svm, ix, &buyer);

    // The seller kept no residual control over the copy they sold.
    let ix = w.lend_ix(&owner, friend.pubkey());
    assert_fails_with(try_send(&mut w.svm, ix, &owner), "ConstraintHasOne");

    // The new owner has the full rights of ownership.
    let ix = w.lend_ix(&buyer, friend.pubkey());
    send(&mut w.svm, ix, &buyer);
    assert_eq!(
        read_license(&w.svm, w.license).borrower,
        Some(friend.pubkey())
    );
}

#[test]
fn a_copy_out_on_loan_cannot_be_listed() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let friend = Keypair::new();

    let ix = w.lend_ix(&owner, friend.pubkey());
    send(&mut w.svm, ix, &owner);

    let ix = w.list_ix(&owner, RESALE_PRICE);
    assert_fails_with(try_send(&mut w.svm, ix, &owner), "CannotSellWhileLentOut");
}

#[test]
fn only_the_seller_can_cancel_and_cancelling_stops_the_sale() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let buyer = Keypair::new();
    let stranger = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 5_000_000_000).unwrap();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    let ix = w.list_ix(&owner, RESALE_PRICE);
    send(&mut w.svm, ix, &owner);

    let ix = w.cancel_ix(&stranger);
    assert_fails_with(try_send(&mut w.svm, ix, &stranger), "ConstraintHasOne");

    let ix = w.cancel_ix(&owner);
    send(&mut w.svm, ix, &owner);

    // With the listing withdrawn there is nothing left to buy.
    let ix = w.buy_listed_ix(&buyer, owner.pubkey());
    assert!(
        try_send(&mut w.svm, ix, &buyer).is_err(),
        "buying a withdrawn listing should fail"
    );
    assert_eq!(read_license(&w.svm, w.license).owner, owner.pubkey());
}

#[test]
fn cannot_buy_your_own_listing() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();

    let ix = w.list_ix(&owner, RESALE_PRICE);
    send(&mut w.svm, ix, &owner);

    let ix = w.buy_listed_ix(&owner, owner.pubkey());
    assert_fails_with(try_send(&mut w.svm, ix, &owner), "CannotBuyYourOwnListing");
}

#[test]
fn a_zero_price_listing_is_a_giveaway() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let recipient = Keypair::new();
    w.svm.airdrop(&recipient.pubkey(), 1_000_000_000).unwrap();

    let ix = w.list_ix(&owner, 0);
    send(&mut w.svm, ix, &owner);

    let developer_before = w.svm.get_balance(&w.developer.pubkey()).unwrap();
    let ix = w.buy_listed_ix(&recipient, owner.pubkey());
    send(&mut w.svm, ix, &recipient);

    assert_eq!(read_license(&w.svm, w.license).owner, recipient.pubkey());
    // Nothing changes hands on a gift, so there is no royalty either.
    assert_eq!(
        w.svm.get_balance(&w.developer.pubkey()).unwrap(),
        developer_before
    );
}

#[test]
fn a_resold_copy_can_be_resold_again() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let second = Keypair::new();
    let third = Keypair::new();
    w.svm.airdrop(&second.pubkey(), 5_000_000_000).unwrap();
    w.svm.airdrop(&third.pubkey(), 5_000_000_000).unwrap();

    let ix = w.list_ix(&owner, RESALE_PRICE);
    send(&mut w.svm, ix, &owner);
    let ix = w.buy_listed_ix(&second, owner.pubkey());
    send(&mut w.svm, ix, &second);

    // The developer earns on every hop, not just the first resale.
    let developer_before = w.svm.get_balance(&w.developer.pubkey()).unwrap();
    let ix = w.list_ix(&second, RESALE_PRICE);
    send(&mut w.svm, ix, &second);
    let ix = w.buy_listed_ix(&third, second.pubkey());
    send(&mut w.svm, ix, &third);

    assert_eq!(read_license(&w.svm, w.license).owner, third.pubkey());
    assert_eq!(
        w.svm.get_balance(&w.developer.pubkey()).unwrap() - developer_before,
        RESALE_PRICE / 10
    );
}

