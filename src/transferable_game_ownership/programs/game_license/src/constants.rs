use anchor_lang::prelude::*;

#[constant]
pub const GAME_SEED: &[u8] = b"game";

#[constant]
pub const LICENSE_SEED: &[u8] = b"license";

/// 30 days. Caps a "loan" from being a permanent transfer in disguise, which would sidestep the
/// resale royalty.
#[constant]
pub const MAX_LOAN_MINUTES: i64 = 43_200;

#[constant]
pub const LISTING_SEED: &[u8] = b"listing";

/// Developer's cut of every resale, in basis points (1000 = 10%). A program constant rather than a
/// per-game setting, so the three Game accounts already on devnet keep their layout.
#[constant]
pub const ROYALTY_BPS: u64 = 1_000;
