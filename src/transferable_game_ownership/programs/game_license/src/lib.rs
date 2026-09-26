pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("79qFZV1E5tBdLeoqAx495yW4LnP33coF81v288HpKwoe");

#[program]
pub mod game_license {
    use super::*;

    pub fn create_game(ctx: Context<CreateGame>, game_id: u64, price_lamports: u64) -> Result<()> {
        crate::instructions::create_game::handle_create_game(ctx, game_id, price_lamports)
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        crate::instructions::buy::handle_buy(ctx)
    }

    pub fn lend(ctx: Context<Lend>, borrower: Pubkey, minutes: i64) -> Result<()> {
        crate::instructions::lend::handle_lend(ctx, borrower, minutes)
    }

    pub fn list_for_sale(ctx: Context<ListForSale>, price_lamports: u64) -> Result<()> {
        crate::instructions::list_for_sale::handle_list_for_sale(ctx, price_lamports)
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        crate::instructions::cancel_listing::handle_cancel_listing(ctx)
    }

    pub fn buy_listed(ctx: Context<BuyListed>) -> Result<()> {
        crate::instructions::buy_listed::handle_buy_listed(ctx)
    }
}
