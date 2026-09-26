use anchor_lang::prelude::*;

use crate::{constants::*, error::LicenseError, state::License};

#[derive(Accounts)]
pub struct Lend<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub license: Account<'info, License>,
}

pub fn handle_lend(ctx: Context<Lend>, borrower: Pubkey, minutes: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let license = &mut ctx.accounts.license;

    // An expired loan is not an active one, so the owner can lend the copy out again.
    let on_loan = license.borrower.is_some() && license.expiry > now;
    require!(!on_loan, LicenseError::AlreadyLentOut);
    require!(borrower != license.owner, LicenseError::CannotLendToSelf);
    require!(
        minutes > 0 && minutes <= MAX_LOAN_MINUTES,
        LicenseError::InvalidLoanLength
    );

    license.borrower = Some(borrower);
    license.expiry = now + minutes * 60;

    msg!(
        "License {} lent to {} until {}",
        license.id,
        borrower,
        license.expiry
    );
    Ok(())
}
