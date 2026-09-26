use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::LicenseError,
    state::{Game, License, Listing},
};

/// Field order matters: Anchor validates accounts top to bottom, so a constraint can only reference
/// an account declared above it (`license.owner`, `game.authority`).
#[derive(Accounts)]
pub struct BuyListed<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub game: Account<'info, Game>,
    /// Developer wallet, pinned to the game's recorded authority so the royalty can't be redirected.
    #[account(mut, address = game.authority)]
    pub developer: SystemAccount<'info>,
    #[account(mut, has_one = game)]
    pub license: Account<'info, License>,
    /// The current owner. Deliberately NOT a signer: they consented when they created the listing,
    /// and the licence is a PDA this program controls, so no second signature is needed to move it.
    #[account(mut, address = license.owner)]
    pub seller: SystemAccount<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, license.key().as_ref()],
        bump,
        has_one = license,
        has_one = seller
    )]
    pub listing: Account<'info, Listing>,
    pub system_program: Program<'info, System>,
}

fn transfer_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: from.clone(),
        to: to.clone(),
    };
    anchor_lang::system_program::transfer(
        CpiContext::new(anchor_lang::system_program::ID, cpi_accounts),
        lamports,
    )
}

pub fn handle_buy_listed(ctx: Context<BuyListed>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let license = &ctx.accounts.license;

    let on_loan = license.borrower.is_some() && license.expiry > now;
    require!(!on_loan, LicenseError::CannotSellWhileLentOut);
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
        LicenseError::CannotBuyYourOwnListing
    );

    // u128 intermediate: `price * ROYALTY_BPS` would overflow u64 for absurd prices, and the
    // release profile has overflow-checks on, which would panic instead of erroring.
    let price = ctx.accounts.listing.price_lamports;
    let royalty = ((price as u128) * (ROYALTY_BPS as u128) / 10_000) as u64;
    let to_seller = price - royalty; // rounding dust favours the seller

    // A zero price is a giveaway, not a bug — skip both CPIs rather than transferring nothing.
    if to_seller > 0 {
        transfer_lamports(
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            to_seller,
        )?;
    }
    if royalty > 0 {
        transfer_lamports(
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.developer.to_account_info(),
            royalty,
        )?;
    }

    let license = &mut ctx.accounts.license;
    license.owner = ctx.accounts.buyer.key();
    // A sale hands over a clean copy: any lapsed loan record goes with the previous owner.
    license.borrower = None;
    license.expiry = 0;

    msg!(
        "License {} sold for {} lamports: {} to seller, {} royalty to developer. New owner {}",
        license.id,
        price,
        to_seller,
        royalty,
        license.owner
    );
    Ok(())
}
