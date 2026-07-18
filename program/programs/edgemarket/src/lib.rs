use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TransferChecked};

declare_id!("AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8");

/// Discriminator of TxLINE's `validate_stat` instruction (from its on-chain IDL).
const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

/// The one and only TxLINE oracle program. Pinning it on-chain is what makes settlement
/// actually trustless: a settler cannot substitute a fake program that returns a chosen verdict.
// 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J decoded to raw bytes (const, no macro dep).
const TXLINE_PROGRAM: Pubkey = Pubkey::new_from_array([
    86, 117, 159, 44, 144, 95, 120, 96, 200, 99, 119, 20, 191, 36, 145, 48,
    157, 192, 113, 129, 81, 63, 122, 36, 191, 62, 218, 248, 127, 119, 80, 3,
]);

// EdgeBot's own market venue — a standalone program the agent trades on. Independent of any
// other submission; the agent (agent.mjs / agent-live.mjs) creates, trades, and proof-settles here.
#[program]
pub mod edgemarket {
    use super::*;

    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: u64,
        market_type: MarketType,
        settle_authority: Pubkey,
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.fixture_id = fixture_id;
        m.market_type = market_type;
        m.settle_authority = settle_authority;
        m.state = MarketState::Open;
        m.yes_amount = 0;
        m.no_amount = 0;
        m.resolution = None;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn deposit_yes(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.market.state == MarketState::Open,
            MarketError::NotOpen
        );
        transfer_in(&ctx, amount)?;

        let user_key = ctx.accounts.user.key();
        let market_key = ctx.accounts.market.key();

        let m = &mut ctx.accounts.market;
        m.yes_amount = m.yes_amount.checked_add(amount).unwrap();

        let d = &mut ctx.accounts.deposit;
        d.owner = user_key;
        d.market = market_key;
        d.amount = d.amount.checked_add(amount).unwrap();
        d.is_yes = true;
        Ok(())
    }

    pub fn deposit_no(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.market.state == MarketState::Open,
            MarketError::NotOpen
        );
        transfer_in(&ctx, amount)?;

        let user_key = ctx.accounts.user.key();
        let market_key = ctx.accounts.market.key();

        let m = &mut ctx.accounts.market;
        m.no_amount = m.no_amount.checked_add(amount).unwrap();

        let d = &mut ctx.accounts.deposit;
        d.owner = user_key;
        d.market = market_key;
        d.amount = d.amount.checked_add(amount).unwrap();
        d.is_yes = false;
        Ok(())
    }

    /// Trustless settlement. **Permissionless** — anyone can settle, because the
    /// outcome is derived on-chain from TxLINE's cryptographic verdict, not chosen
    /// by the caller. `args` carries the finalised (full-time) score proof; we bind
    /// it to this market's fixture, constrain its predicate to the market's canonical
    /// question, CPI to TxLINE's `validate_stat`, and read the returned bool to set
    /// the resolution. A garbage or tampered proof reverts inside `validate_stat`.
    pub fn settle(ctx: Context<Settle>, args: ValidateStatArgs) -> Result<()> {
        require!(
            ctx.accounts.market.state == MarketState::Open,
            MarketError::NotOpen
        );

        let fixture_id = ctx.accounts.market.fixture_id;
        let market_type = ctx.accounts.market.market_type.clone();

        // 1) Bind the proof to THIS market's fixture — a caller can't settle with
        //    some other match's proof.
        require!(
            args.fixture_summary.fixture_id == fixture_id as i64,
            MarketError::FixtureMismatch
        );

        // 2) Re-derive the daily-roots PDA from the proof's own timestamp and require
        //    the passed account matches — a caller can't substitute a fake roots account.
        let day = (args.fixture_summary.update_stats.min_timestamp / 86_400_000) as u16;
        let (expected_roots, _) = Pubkey::find_program_address(
            &[b"daily_scores_roots", &day.to_le_bytes()],
            &ctx.accounts.txline_program.key(),
        );
        require_keys_eq!(
            ctx.accounts.daily_scores_merkle_roots.key(),
            expected_roots,
            MarketError::RootsMismatch
        );

        // 3) Finality: only the full-time total (period 100) can settle the match.
        require!(
            args.stat_a.stat_to_prove.period == 100,
            MarketError::NotFinal
        );
        if let Some(b) = &args.stat_b {
            require!(b.stat_to_prove.period == 100, MarketError::NotFinal);
        }

        // 4) Constrain the proven predicate to the market's canonical question, so the
        //    caller can only prove the thing this market actually asks (YES-defining).
        match market_type {
            MarketType::MatchWinner { team1_key, team2_key } => {
                // YES <=> team1_goals - team2_goals > 0
                require!(
                    args.stat_a.stat_to_prove.key == team1_key as u32
                        && args.stat_b.as_ref().map(|s| s.stat_to_prove.key)
                            == Some(team2_key as u32)
                        && matches!(args.op, Some(BinaryExpression::Subtract))
                        && args.predicate.threshold == 0
                        && matches!(args.predicate.comparison, Comparison::GreaterThan),
                    MarketError::PredicateMismatch
                );
            }
            MarketType::OverUnder { stat_key, threshold } => {
                // YES <=> stat > threshold
                require!(
                    args.stat_a.stat_to_prove.key == stat_key as u32
                        && args.stat_b.is_none()
                        && args.op.is_none()
                        && args.predicate.threshold == threshold as i32
                        && matches!(args.predicate.comparison, Comparison::GreaterThan),
                    MarketError::PredicateMismatch
                );
            }
            MarketType::ExactScore { stat_key, target } => {
                // YES <=> stat == target
                require!(
                    args.stat_a.stat_to_prove.key == stat_key as u32
                        && args.predicate.threshold == target as i32
                        && matches!(args.predicate.comparison, Comparison::EqualTo),
                    MarketError::PredicateMismatch
                );
            }
        }

        // 5) CPI to validate_stat. Reverts here if the Merkle proof is invalid.
        let mut data = Vec::with_capacity(1024);
        data.extend_from_slice(&VALIDATE_STAT_DISCRIMINATOR);
        args.serialize(&mut data)?;
        let ix = Instruction {
            program_id: ctx.accounts.txline_program.key(),
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.daily_scores_merkle_roots.key(),
                false,
            )],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txline_program.to_account_info(),
            ],
        )?;

        // 6) Read validate_stat's verdict (return-data bool) and DERIVE the outcome.
        //    validate_stat does not revert on a false predicate — it returns 0x00 —
        //    so we must read it rather than trust the caller.
        let (ret_program, ret) = anchor_lang::solana_program::program::get_return_data()
            .ok_or(MarketError::ProofRejected)?;
        require_keys_eq!(
            ret_program,
            ctx.accounts.txline_program.key(),
            MarketError::ProofRejected
        );
        let predicate_true = ret.first() == Some(&1u8);

        let m = &mut ctx.accounts.market;
        m.resolution = Some(if predicate_true { Outcome::Yes } else { Outcome::No });
        m.state = MarketState::Settled;
        Ok(())
    }

    /// `_claimed_amount` is intentionally IGNORED — the payout is derived from the
    /// claimant's own on-chain deposit, never a caller-supplied number. (Trusting a
    /// caller `amount` let the first winner pass `amount = total_winning` and drain
    /// the whole vault.) Kept in the signature only for ABI compatibility.
    pub fn claim_winnings(ctx: Context<Claim>, _claimed_amount: u64) -> Result<()> {
        require!(
            ctx.accounts.market.state == MarketState::Settled,
            MarketError::NotSettled
        );
        let resolution = ctx
            .accounts
            .market
            .resolution
            .ok_or(MarketError::NoResolution)?;

        require!(
            ctx.accounts.deposit.owner == ctx.accounts.user.key(),
            MarketError::Unauthorized
        );
        require!(!ctx.accounts.deposit.claimed, MarketError::AlreadyClaimed);

        let is_yes = ctx.accounts.deposit.is_yes;
        let won = matches!(
            (resolution, is_yes),
            (Outcome::Yes, true) | (Outcome::No, false)
        );
        require!(won, MarketError::Lost);

        // Snapshot pools are frozen once the market is Settled (no more deposits), so
        // total/winning pools are stable denominators — unlike the live vault balance,
        // which shrinks as earlier winners claim and would under-pay later ones.
        let stake = ctx.accounts.deposit.amount;
        let winning_pool = if is_yes {
            ctx.accounts.market.yes_amount
        } else {
            ctx.accounts.market.no_amount
        };
        let total_pool = (ctx.accounts.market.yes_amount as u128)
            .checked_add(ctx.accounts.market.no_amount as u128)
            .unwrap();
        require!(winning_pool > 0, MarketError::NoResolution);

        // Pro-rata share of the whole pool, floored so summed payouts can never exceed
        // deposits (dust stays in the vault).
        let payout = ((stake as u128)
            .checked_mul(total_pool)
            .unwrap()
            .checked_div(winning_pool as u128)
            .unwrap()) as u64;

        if payout > 0 {
            let market_key = ctx.accounts.market.key();
            let vault_bump = ctx.bumps.vault_authority;
            let decimals = ctx.accounts.mint.decimals;
            let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[vault_bump]];

            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.user_token.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
                decimals,
            )?;
        }

        ctx.accounts.deposit.claimed = true;
        Ok(())
    }
}

fn transfer_in(ctx: &Context<Deposit>, amount: u64) -> Result<()> {
    let decimals = ctx.accounts.mint.decimals;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        decimals,
    )
}

// ---------------------------------------------------------------------------
// TxLINE validate_stat argument types (mirror the on-chain IDL exactly so the
// Borsh serialization is byte-compatible with TxLINE's program).
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketState {
    Open,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Yes,
    No,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum MarketType {
    MatchWinner { team1_key: u16, team2_key: u16 },
    OverUnder { stat_key: u16, threshold: u64 },
    ExactScore { stat_key: u16, target: u64 },
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub fixture_id: u64,
    pub market_type: MarketType,
    pub settle_authority: Pubkey,
    pub state: MarketState,
    pub yes_amount: u64,
    pub no_amount: u64,
    pub resolution: Option<Outcome>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserDeposit {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub is_yes: bool,
    pub claimed: bool,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(fixture_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", fixture_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserDeposit::INIT_SPACE,
        seeds = [b"deposit", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, UserDeposit>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: seed-verified vault authority PDA (owns the vault ATA)
    #[account(
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,

    pub settler: Signer<'info>,

    /// CHECK: CPI target — pinned to the REAL TxLINE oracle on-chain. This one constraint is what
    /// makes settlement trustless: a fake oracle can no longer be substituted.
    #[account(address = TXLINE_PROGRAM)]
    pub txline_program: UncheckedAccount<'info>,

    /// CHECK: TxLINE daily_scores_merkle_roots PDA — must be OWNED by the real TxLINE program.
    #[account(owner = TXLINE_PROGRAM)]
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [b"deposit", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, UserDeposit>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: seed-verified vault authority PDA (owns the vault ATA)
    #[account(
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token2022>,
}

#[error_code]
pub enum MarketError {
    #[msg("Market is not open")]
    NotOpen,
    #[msg("Market is not settled yet")]
    NotSettled,
    #[msg("No resolution available")]
    NoResolution,
    #[msg("You lost this bet")]
    Lost,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Proof is for a different fixture than this market")]
    FixtureMismatch,
    #[msg("daily_scores_roots account does not match the proof's day")]
    RootsMismatch,
    #[msg("Proof is not the full-time (period 100) result")]
    NotFinal,
    #[msg("Proof predicate does not match this market's question")]
    PredicateMismatch,
    #[msg("TxLINE rejected the proof (no/invalid verdict)")]
    ProofRejected,
}
