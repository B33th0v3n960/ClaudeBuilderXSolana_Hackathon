use anchor_lang::prelude::*;

use crate::{constants::*, state::{Game, License}};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, Game>,
    /// The developer's wallet — must match `game.authority`. Receives payment directly.
    #[account(mut, address = game.authority)]
    pub developer: SystemAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = 8 + License::INIT_SPACE,
        seeds = [LICENSE_SEED, game.key().as_ref(), game.license_count.to_le_bytes().as_ref()],
        bump
    )]
    pub license: Account<'info, License>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy(ctx: Context<Buy>) -> Result<()> {
    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.buyer.to_account_info(),
        to: ctx.accounts.developer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(anchor_lang::system_program::ID, cpi_accounts);
    anchor_lang::system_program::transfer(cpi_ctx, ctx.accounts.game.price_lamports)?;

    let license = &mut ctx.accounts.license;
    license.game = ctx.accounts.game.key();
    license.id = ctx.accounts.game.license_count;
    license.owner = ctx.accounts.buyer.key();
    license.borrower = None;
    license.expiry = 0;
    license.purchased_at = Clock::get()?.unix_timestamp;

    ctx.accounts.game.license_count += 1;

    msg!(
        "License {} for game {} bought by {}",
        license.id,
        ctx.accounts.game.game_id,
        license.owner
    );
    Ok(())
}
