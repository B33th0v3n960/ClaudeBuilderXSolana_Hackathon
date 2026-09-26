use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const GAME_ID: u64 = 1;
const PRICE_LAMPORTS: u64 = 1_000_000_000; // 1 SOL

fn program_bytes() -> &'static [u8] {
    include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/game_license.so"
    ))
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx);
    assert!(res.is_ok(), "transaction failed: {:?}", res.err());
}

#[test]
fn buyer_owns_license_and_developer_gets_paid() {
    let program_id = game_license::id();
    let developer = Keypair::new();
    let buyer = Keypair::new();

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

    let mut svm = LiteSVM::new();
    svm.add_program(program_id, program_bytes()).unwrap();
    svm.airdrop(&developer.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&buyer.pubkey(), 5_000_000_000).unwrap();

    let create_game_ix = Instruction::new_with_bytes(
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
    send(&mut svm, &[create_game_ix], &developer, &[&developer]);

    let developer_balance_before = svm.get_balance(&developer.pubkey()).unwrap();

    let buy_ix = Instruction::new_with_bytes(
        program_id,
        &game_license::instruction::Buy {}.data(),
        game_license::accounts::Buy {
            buyer: buyer.pubkey(),
            game,
            developer: developer.pubkey(),
            license,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[buy_ix], &buyer, &[&buyer]);

    // Ownership: the License account says the buyer owns it.
    let license_account = svm.get_account(&license).unwrap();
    let mut data: &[u8] = &license_account.data;
    let license_state = game_license::state::License::try_deserialize(&mut data).unwrap();
    assert_eq!(license_state.owner, buyer.pubkey());
    assert_eq!(license_state.game, game);
    assert_eq!(license_state.id, 0);
    assert!(license_state.borrower.is_none());

    // Payment: the developer actually got paid the listed price.
    let developer_balance_after = svm.get_balance(&developer.pubkey()).unwrap();
    assert_eq!(
        developer_balance_after - developer_balance_before,
        PRICE_LAMPORTS
    );

    // Game bookkeeping: license_count advanced so the next buy gets a distinct PDA.
    let game_account = svm.get_account(&game).unwrap();
    let mut data: &[u8] = &game_account.data;
    let game_state = game_license::state::Game::try_deserialize(&mut data).unwrap();
    assert_eq!(game_state.license_count, 1);
}

#[test]
fn second_buyer_gets_a_distinct_license_and_first_owner_unaffected() {
    let program_id = game_license::id();
    let developer = Keypair::new();
    let buyer_a = Keypair::new();
    let buyer_b = Keypair::new();

    let (game, _) = Pubkey::find_program_address(
        &[game_license::constants::GAME_SEED, &GAME_ID.to_le_bytes()],
        &program_id,
    );

    let mut svm = LiteSVM::new();
    svm.add_program(program_id, program_bytes()).unwrap();
    svm.airdrop(&developer.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&buyer_a.pubkey(), 5_000_000_000).unwrap();
    svm.airdrop(&buyer_b.pubkey(), 5_000_000_000).unwrap();

    let create_game_ix = Instruction::new_with_bytes(
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
    send(&mut svm, &[create_game_ix], &developer, &[&developer]);

    let buy_for = |svm: &mut LiteSVM, buyer: &Keypair, license_id: u64| -> Pubkey {
        let (license, _) = Pubkey::find_program_address(
            &[
                game_license::constants::LICENSE_SEED,
                game.as_ref(),
                &license_id.to_le_bytes(),
            ],
            &program_id,
        );
        let ix = Instruction::new_with_bytes(
            program_id,
            &game_license::instruction::Buy {}.data(),
            game_license::accounts::Buy {
                buyer: buyer.pubkey(),
                game,
                developer: developer.pubkey(),
                license,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(svm, &[ix], buyer, &[buyer]);
        license
    };

    let license_a = buy_for(&mut svm, &buyer_a, 0);
    let license_b = buy_for(&mut svm, &buyer_b, 1);

    assert_ne!(license_a, license_b);

    let mut data: &[u8] = &svm.get_account(&license_a).unwrap().data;
    let state_a = game_license::state::License::try_deserialize(&mut data).unwrap();
    assert_eq!(state_a.owner, buyer_a.pubkey());

    let mut data: &[u8] = &svm.get_account(&license_b).unwrap().data;
    let state_b = game_license::state::License::try_deserialize(&mut data).unwrap();
    assert_eq!(state_b.owner, buyer_b.pubkey());
}
