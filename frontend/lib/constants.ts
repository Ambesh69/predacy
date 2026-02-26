/** USDC has 6 decimal places */
export const USDC_DECIMALS = 6;

/** Price precision (6 decimals, where 1_000_000 = 100%) */
export const PRICE_DECIMALS = 6;

/** Default batch window in seconds */
export const BATCH_WINDOW_SECONDS = 30;

/** Seconds remaining when timer shows "urgent" state */
export const URGENT_THRESHOLD_SECONDS = 8;

/** Minimum order amount in USDC (whole units) */
export const MIN_ORDER_AMOUNT_USDC = 1;

/** Maximum order amount in USDC (whole units) */
export const MAX_ORDER_AMOUNT_USDC = 1_000_000;

/** Price step for limit price slider (1% = 10_000 in 6-decimal space) */
export const PRICE_STEP = 10_000;

/** Minimum price (0.1% = 1000 in 6-decimal space) */
export const MIN_PRICE = 1_000;

/** Maximum price (99% = 990_000 in 6-decimal space) */
export const MAX_PRICE = 990_000;
