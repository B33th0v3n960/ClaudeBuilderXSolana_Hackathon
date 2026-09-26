use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Game {
    /// Developer wallet — receives payment on every `buy`.
    pub authority: Pubkey,
    pub game_id: u64,
    pub price_lamports: u64,
    /// Next license's sequence number; also how many copies have been sold.
    pub license_count: u64,
}

/// A copy offered for sale. Its existence *is* the "for sale" flag, and it doubles as the seller's
/// standing consent — the buyer completes the sale alone, later, without the seller signing again.
/// Kept separate from `License` so listing a copy doesn't change the `License` layout.
#[account]
#[derive(InitSpace)]
pub struct Listing {
    /// PDA seeds bind this, but store it too: a PDA can't be reversed back into its seeds, so a
    /// client fetching all listings would otherwise not know which licence each one refers to.
    pub license: Pubkey,
    pub seller: Pubkey,
    pub price_lamports: u64,
}

#[account]
#[derive(InitSpace)]
pub struct License {
    pub game: Pubkey,
    pub id: u64,
    pub owner: Pubkey,
    /// Set by a future `lend` instruction; `None` means no active loan.
    pub borrower: Option<Pubkey>,
    /// Unix timestamp the current loan ends; ignored while `borrower` is `None`.
    pub expiry: i64,
    pub purchased_at: i64,
}
