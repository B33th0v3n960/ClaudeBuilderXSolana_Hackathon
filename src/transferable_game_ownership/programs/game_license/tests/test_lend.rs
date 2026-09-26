use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const GAME_ID: u64 = 7;
const PRICE_LAMPORTS: u64 = 100_000_000;

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

fn lend_ix(
    program_id: Pubkey,
    license: Pubkey,
    owner: &Keypair,
    borrower: Pubkey,
    minutes: i64,
) -> Instruction {
    Instruction::new_with_bytes(
        program_id,
        &game_license::instruction::Lend { borrower, minutes }.data(),
        game_license::accounts::Lend {
            owner: owner.pubkey(),
            license,
        }
        .to_account_metas(None),
    )
}

fn read_license(svm: &LiteSVM, license: Pubkey) -> game_license::state::License {
    let account = svm.get_account(&license).unwrap();
    let mut data: &[u8] = &account.data;
    game_license::state::License::try_deserialize(&mut data).unwrap()
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn warp_seconds(svm: &mut LiteSVM, seconds: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp += seconds;
    svm.set_sysvar(&clock);
}

/// Sets up a game and one purchased licence. Returns (svm, program_id, owner, license).
fn setup() -> (LiteSVM, Pubkey, Keypair, Pubkey) {
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

    (svm, program_id, owner, license)
}

#[test]
fn owner_can_lend_and_the_loan_is_recorded_on_chain() {
    let (mut svm, program_id, owner, license) = setup();
    let friend = Keypair::new();

    assert!(read_license(&svm, license).borrower.is_none());

    let before = now(&svm);
    send(
        &mut svm,
        lend_ix(program_id, license, &owner, friend.pubkey(), 10),
        &owner,
    );

    let state = read_license(&svm, license);
    assert_eq!(state.borrower, Some(friend.pubkey()));
    assert_eq!(state.expiry, before + 600);
    // Ownership does not move — this is a loan, not a transfer.
    assert_eq!(state.owner, owner.pubkey());
}

#[test]
fn a_stranger_cannot_lend_someone_elses_licence() {
    let (mut svm, program_id, _owner, license) = setup();
    let attacker = Keypair::new();
    let friend = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let res = try_send(
        &mut svm,
        lend_ix(program_id, license, &attacker, friend.pubkey(), 10),
        &attacker,
    );

    // Anchor's has_one = owner constraint rejects it.
    assert_fails_with(res, "ConstraintHasOne");
    assert!(read_license(&svm, license).borrower.is_none());
}

#[test]
fn cannot_lend_a_licence_that_is_already_on_loan() {
    let (mut svm, program_id, owner, license) = setup();
    let friend = Keypair::new();
    let other = Keypair::new();

    send(
        &mut svm,
        lend_ix(program_id, license, &owner, friend.pubkey(), 10),
        &owner,
    );
    let res = try_send(
        &mut svm,
        lend_ix(program_id, license, &owner, other.pubkey(), 10),
        &owner,
    );

    assert_fails_with(res, "AlreadyLentOut");
    // First borrower keeps it.
    assert_eq!(read_license(&svm, license).borrower, Some(friend.pubkey()));
}

#[test]
fn the_owner_can_lend_again_once_the_loan_expires() {
    let (mut svm, program_id, owner, license) = setup();
    let friend = Keypair::new();
    let other = Keypair::new();

    send(
        &mut svm,
        lend_ix(program_id, license, &owner, friend.pubkey(), 10),
        &owner,
    );

    // Walk the clock past the 10-minute loan. No transaction returns the licence — it just expires.
    warp_seconds(&mut svm, 601);

    send(
        &mut svm,
        lend_ix(program_id, license, &owner, other.pubkey(), 5),
        &owner,
    );
    assert_eq!(read_license(&svm, license).borrower, Some(other.pubkey()));
}

#[test]
fn rejects_lending_to_yourself_and_nonsense_durations() {
    let (mut svm, program_id, owner, license) = setup();
    let friend = Keypair::new();

    assert_fails_with(
        try_send(
            &mut svm,
            lend_ix(program_id, license, &owner, owner.pubkey(), 10),
            &owner,
        ),
        "CannotLendToSelf",
    );
    assert_fails_with(
        try_send(
            &mut svm,
            lend_ix(program_id, license, &owner, friend.pubkey(), 0),
            &owner,
        ),
        "InvalidLoanLength",
    );
    assert_fails_with(
        try_send(
            &mut svm,
            lend_ix(program_id, license, &owner, friend.pubkey(), 43_201),
            &owner,
        ),
        "InvalidLoanLength",
    );
}
