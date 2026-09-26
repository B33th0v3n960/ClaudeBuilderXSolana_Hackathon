use anchor_lang::prelude::*;

#[error_code]
pub enum LicenseError {
    #[msg("This licence is already lent out and the loan has not expired yet")]
    AlreadyLentOut,
    #[msg("You cannot lend a licence to yourself")]
    CannotLendToSelf,
    #[msg("Loan length must be between 1 minute and 30 days")]
    InvalidLoanLength,
    #[msg("A licence that is out on loan cannot be sold until the loan expires")]
    CannotSellWhileLentOut,
    #[msg("You cannot buy your own listing")]
    CannotBuyYourOwnListing,
}
