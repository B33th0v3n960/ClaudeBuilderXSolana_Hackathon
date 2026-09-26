use anchor_lang::prelude::*;

use crate::{constants::*, state::Game};

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Game::INIT_SPACE,
        seeds = [GAME_SEED, &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_game(
    ctx: Context<CreateGame>,
    game_id: u64,
    price_lamports: u64,
) -> Result<()> {
    let game = &mut ctx.accounts.game;
    game.authority = ctx.accounts.authority.key();
    game.game_id = game_id;
    game.price_lamports = price_lamports;
    game.license_count = 0;

    msg!("Game {} created, price {} lamports", game_id, price_lamports);
    Ok(())
}
