use anchor_lang::prelude::*;

use crate::{
    constants::*,
    state::{License, Listing},
};

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub license: Account<'info, License>,
    // `close` refunds the listing's rent to the seller who paid it.
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, license.key().as_ref()],
        bump,
        has_one = license,
        has_one = seller
    )]
    pub listing: Account<'info, Listing>,
}

pub fn handle_cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
    msg!("Listing for license {} withdrawn", ctx.accounts.license.id);
    Ok(())
}
