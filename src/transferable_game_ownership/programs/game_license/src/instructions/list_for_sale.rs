use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::LicenseError,
    state::{License, Listing},
};

#[derive(Accounts)]
pub struct ListForSale<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner)]
    pub license: Account<'info, License>,
    // `init` also enforces "not already listed": creating a PDA that exists fails.
    #[account(
        init,
        payer = owner,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, license.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    pub system_program: Program<'info, System>,
}

pub fn handle_list_for_sale(ctx: Context<ListForSale>, price_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let license = &ctx.accounts.license;

    // Don't let someone sell a copy a friend is currently playing.
    let on_loan = license.borrower.is_some() && license.expiry > now;
    require!(!on_loan, LicenseError::CannotSellWhileLentOut);

    let listing = &mut ctx.accounts.listing;
    listing.license = license.key();
    listing.seller = ctx.accounts.owner.key();
    listing.price_lamports = price_lamports;

    msg!(
        "License {} listed for {} lamports by {}",
        license.id,
        price_lamports,
        listing.seller
    );
    Ok(())
}
