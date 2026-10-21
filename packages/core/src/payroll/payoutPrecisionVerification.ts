/**
 * Payout Precision Verification (#740)
 *
 * Verifies that a payroll payout amount can be represented **exactly** in the
 * smallest unit of its asset before the payout is built and submitted to the
 * ZK Payroll contracts.
 *
 * ## Why this matters
 *
 * Every Stellar asset has a fixed number of decimal places (7 for XLM, though
 * Soroban tokens may use 6 or 18). When a payout amount carries more
 * fractional digits than the asset supports, the extra digits are silently
 * dropped or rounded. That produces:
 *
 * - **Underpayment / overpayment** — the amount that lands on-chain is not the
 *   amount payroll intended to pay;
 * - **Reconciliation drift** — the sum of payout instructions no longer
 *   matches the approved payroll total;
 * - **Failed or disputed runs** — recipients can (rightly) dispute a shortfall
 *   that the SDK never surfaced.
 *
 * Floating-point arithmetic makes this worse: `0.1 + 0.2` is
 * `0.30000000000000004` in JavaScript, which cannot be represented exactly at
 * 7 decimals even though every input was "valid".
 *
 * ## What this module does
 *
 * `verifyPayoutPrecision` inspects an amount (`bigint`, decimal `string`, or
 * `number`) against resolved asset metadata and returns structured,
 * machine-readable issues instead of silently rounding:
 *
 * - `EXCESS_PRECISION` — the amount has non-zero digits beyond the asset's
 *   precision, so building the payout would lose value;
 * - `UNSAFE_NUMBER` — a JavaScript `number` input is too large to hold the
 *   amount at the asset's precision, so the value cannot be trusted;
 * - `INVALID_AMOUNT`, `NEGATIVE_AMOUNT`, `ZERO_AMOUNT` — unusable amounts;
 * - `AMOUNT_OUT_OF_RANGE` — the canonical amount falls outside the configured
 *   bounds (defaults to `1n .. 2^127 - 1`, the Stellar `i128` range);
 * - `UNKNOWN_ASSET`, `INVALID_DECIMALS` — asset metadata problems.
 *
 * All arithmetic uses `bigint`; no binary floating-point operation is
 * performed on a payout amount.
 *
 * ## Usage
 *
 * ```ts
 * import { verifyPayoutPrecision, assertPayoutPrecision } from "@zk-payroll/core";
 *
 * // Exact amount: passes.
 * verifyPayoutPrecision({ employeeId: "emp-1", amount: "1250.50", asset: "native" });
 * // => { isValid: true, amount: 12_505_000_000n, ... }
 *
 * // One stroop too many: rejected before the payout is built.
 * const result = verifyPayoutPrecision({
 *   employeeId: "emp-1",
 *   amount: "1250.50000001",
 *   asset: "native",
 * });
 * // => { isValid: false, issues: [{ code: "EXCESS_PRECISION", ... }] }
 *
 * // Throwing variant for submission pipelines.
 * assertPayoutPrecision({ amount: "10.123456789", asset: "native" });
 * // => throws PayoutPrecisionError
 * ```
 *
 * ## Privacy & Security Guarantees
 *
 * - Employee identifiers and amounts are redacted in `redactedMessage`, which
 *   is safe for UI surfaces, telemetry, and external logs.
 * - Full detail is available in `message` for internal audit tooling and can
 *   be tightened further with `redactAmounts` / `redactEmployeeIds`.
 *
 * @module
 */

import { AssetMetadata } from "../assets/types";
import { AssetRegistry, AssetRegistryClass } from "../assets/AssetRegistry";
import {
  MAX_SUPPORTED_DECIMALS,
  MIN_SUPPORTED_DECIMALS,
  getDecimalScaleFactor,
  isValidDecimals,
} from "../assets/decimals";
import { RoundingMode } from "../assets/amountParsing";
import { redactEmployeeId } from "./minimumAmount";

/**
 * Largest value a Stellar `i128` can hold (`2^127 - 1`), expressed in an
 * asset's smallest unit. Amounts above this cannot be encoded for the
 * contracts and are rejected by {@link verifyPayoutPrecision}.
 */
export const MAX_I128_PAYOUT_AMOUNT = (1n << 127n) - 1n;

/**
 * Machine-readable classification of a payout precision problem.
 *
 * - `UNKNOWN_ASSET` — the asset identifier could not be resolved to metadata.
 * - `INVALID_DECIMALS` — the asset declares a decimal count outside `0..18`.
 * - `INVALID_AMOUNT` — the value is not a usable decimal / base-unit amount.
 * - `NEGATIVE_AMOUNT` — negative amounts are not payable.
 * - `ZERO_AMOUNT` — zero amounts are not payable unless explicitly allowed.
 * - `EXCESS_PRECISION` — representing the amount would drop non-zero digits.
 * - `UNSAFE_NUMBER` — a `number` input cannot carry the asset's precision.
 * - `AMOUNT_OUT_OF_RANGE` — the canonical amount is outside the bounds
 *   (by default `1n .. MAX_I128_PAYOUT_AMOUNT`).
 */
export type PayoutPrecisionIssueCode =
  | "UNKNOWN_ASSET"
  | "INVALID_DECIMALS"
  | "INVALID_AMOUNT"
  | "NEGATIVE_AMOUNT"
  | "ZERO_AMOUNT"
  | "EXCESS_PRECISION"
  | "UNSAFE_NUMBER"
  | "AMOUNT_OUT_OF_RANGE";

/**
 * A single actionable problem found while verifying a payout amount.
 */
export interface PayoutPrecisionIssue {
  /** Machine-readable classification of the problem. */
  code: PayoutPrecisionIssueCode;
  /** Index of the entry in the batch that produced this issue, when applicable. */
  entryIndex?: number;
  /** Employee identifier as supplied, when present. */
  employeeId?: string;
  /** Privacy-safe employee identifier (always populated). */
  redactedEmployeeId: string;
  /** Resolved asset id (or the unresolved identifier for `UNKNOWN_ASSET`). */
  assetId: string;
  /** Resolved asset symbol, or the supplied identifier when unresolved. */
  assetSymbol: string;
  /** Asset decimal precision, when it could be resolved. */
  decimals?: number;
  /** Raw input amount as supplied, when `redactAmounts` is disabled. */
  input?: string;
  /** Full diagnostic message (may include the amount and employee id). */
  message: string;
  /** Privacy-safe message suitable for UI, telemetry, and external logs. */
  redactedMessage: string;
  /** Concrete remediation the caller can apply. */
  suggestedFix: string;
  /** Canonical smallest-unit amount, when it could be computed safely. */
  amount?: bigint;
}

/**
 * A payout amount to verify.
 */
export interface PayoutPrecisionEntry {
  /** Employee or recipient identifier, used for redacted diagnostics. */
  employeeId?: string;
  /**
   * Amount to verify.
   *
   * - `bigint` values are treated as **canonical smallest-unit** amounts and
   *   are never rescaled.
   * - `string` values are human-readable decimal amounts (e.g. `"1250.50"`,
   *   `"1,250.50 XLM"`, `"1e-7"`).
   * - `number` values are human-readable decimal amounts, subject to the
   *   JavaScript safe-integer limit at the asset's precision.
   */
  amount: bigint | string | number;
  /** Asset metadata, or an asset id / symbol resolvable through the registry. */
  asset: string | AssetMetadata;
}

/**
 * Configuration for {@link verifyPayoutPrecision}.
 */
export interface PayoutPrecisionVerificationOptions {
  /**
   * Preserve excess digits by rounding to the asset's precision instead of
   * rejecting them. The result then carries `wasRounded: true`. Defaults to
   * `false` — silent rounding is exactly what this module exists to prevent.
   */
  allowRounding?: boolean;
  /** Rounding strategy used when `allowRounding` is enabled. Defaults to `HALF_UP`. */
  rounding?: RoundingMode;
  /** Allow zero-valued payouts. Defaults to `false`. */
  allowZeroAmount?: boolean;
  /** Minimum acceptable canonical amount. Defaults to `1n` (one smallest unit). */
  minAmount?: bigint;
  /** Maximum acceptable canonical amount. Defaults to `MAX_I128_PAYOUT_AMOUNT`. */
  maxAmount?: bigint;
  /** Redact amounts in diagnostic messages. Defaults to `true`. */
  redactAmounts?: boolean;
  /** Redact employee ids in `redactedMessage`. Defaults to `true`. */
  redactEmployeeIds?: boolean;
  /** Registry used to resolve string asset identifiers. Defaults to `AssetRegistry`. */
  registry?: AssetRegistryClass;
}

/**
 * Result of verifying a single payout amount.
 */
export interface PayoutPrecisionVerificationResult {
  /** True when no issues were found and `amount` is safe to build a payout from. */
  isValid: boolean;
  /** Canonical smallest-unit amount; present when `isValid` is true. */
  amount?: bigint;
  /** Resolved asset id (or the unresolved identifier). */
  assetId: string;
  /** Resolved asset symbol (or the unresolved identifier). */
  assetSymbol: string;
  /** Asset decimal precision; `0` when the asset could not be resolved. */
  decimals: number;
  /** True when `allowRounding` preserved the payout by rounding excess digits. */
  wasRounded: boolean;
  /** Every problem found, in evaluation order. Empty when valid. */
  issues: PayoutPrecisionIssue[];
}

/**
 * Aggregated result of verifying a batch of payout amounts.
 */
export interface PayoutPrecisionBatchResult {
  /** True when every entry passed verification. */
  isValid: boolean;
  /** Per-entry results, in the same order as the input batch. */
  results: PayoutPrecisionVerificationResult[];
  /** Flattened issues across the batch, each carrying its `entryIndex`. */
  issues: PayoutPrecisionIssue[];
  /** Counts useful for dashboards and preflight summaries. */
  summary: {
    totalEntries: number;
    validCount: number;
    invalidCount: number;
    issueCount: number;
    excessPrecisionCount: number;
    unsafeNumberCount: number;
    unknownAssetCount: number;
    outOfRangeCount: number;
  };
}

/**
 * Error thrown by {@link assertPayoutPrecision} and
 * {@link assertPayoutPrecisionBatch}.
 */
export class PayoutPrecisionError extends Error {
  /** Code of the first issue that caused the failure. */
  public readonly code: PayoutPrecisionIssueCode;
  /** Every issue that caused the failure. */
  public readonly issues: PayoutPrecisionIssue[];

  constructor(issues: PayoutPrecisionIssue[], useRedactedMessage = true) {
    const first = issues[0];
    const fallback = "Payout amount failed precision verification.";
    super(first ? (useRedactedMessage ? first.redactedMessage : first.message) : fallback);
    this.name = "PayoutPrecisionError";
    this.code = first?.code ?? "INVALID_AMOUNT";
    this.issues = issues;
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Result of analysing an amount without any asset/range context. */
type AmountAnalysis =
  | { ok: true; amount: bigint; wasRounded: boolean }
  | {
      ok: false;
      code: PayoutPrecisionIssueCode;
      /** Full detail; may include the raw amount when redaction is disabled. */
      detail: string;
      /** Privacy-safe detail that never includes the raw amount. */
      redactedDetail: string;
      suggestedFix: string;
    };

const DECIMAL_PATTERN = /^[+-]?(\d+)(?:\.(\d*))?$/;

/**
 * Expand scientific notation (e.g. `"1e-7"`, `"1.5E+3"`) into a plain decimal
 * string so it can be handled with integer arithmetic.
 *
 * Returns `null` for exponents outside `-40..40`, which cannot correspond to a
 * meaningful payroll amount and would only produce unusable strings.
 */
function expandExponential(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const [, sign, intPart, fracPart = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) {
    return null;
  }

  const digits = `${intPart}${fracPart}`;
  const pointPosition = intPart.length + exponent;

  let whole: string;
  let fraction: string;

  if (pointPosition <= 0) {
    whole = "0";
    fraction = `${"0".repeat(-pointPosition)}${digits}`;
  } else if (pointPosition >= digits.length) {
    whole = `${digits}${"0".repeat(pointPosition - digits.length)}`;
    fraction = "";
  } else {
    whole = digits.slice(0, pointPosition);
    fraction = digits.slice(pointPosition);
  }

  return `${sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

/**
 * Normalise a human-readable amount string:
 * - trims whitespace,
 * - removes thousands separators,
 * - strips a leading currency symbol and a trailing asset symbol,
 * - expands scientific notation.
 *
 * Returns `null` when the value cannot be reduced to a plain decimal.
 */
function normalizeDecimalString(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  text = text.replace(/,/g, "").replace(/^[$€£¥]\s*/, "");
  text = text.replace(/\s+[A-Za-z][A-Za-z0-9]{0,9}$/, "").trim();

  if (/[eE]/.test(text)) {
    const expanded = expandExponential(text);
    if (expanded === null) {
      return null;
    }
    text = expanded;
  }

  return DECIMAL_PATTERN.test(text) ? text : null;
}

/** Render a canonical amount as a decimal string for diagnostics. */
function formatCanonicalAmount(amount: bigint, decimals: number, symbol: string): string {
  const scale = getDecimalScaleFactor(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;

  if (fraction === 0n) {
    return `${whole} ${symbol}`;
  }

  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${whole}.${fractionText} ${symbol}`;
}

/** Options that affect how a raw amount is interpreted. */
interface AmountAnalysisOptions {
  allowRounding: boolean;
  rounding: RoundingMode;
  allowZeroAmount: boolean;
  redactAmounts: boolean;
}

/**
 * Analyse an amount against an asset's decimal precision.
 *
 * All arithmetic is integer (`bigint`) arithmetic: decimal inputs are split on
 * the decimal point and scaled by `10^decimals`, never multiplied as floats.
 */
function analyzeAmount(
  input: PayoutPrecisionEntry["amount"],
  decimals: number,
  options: AmountAnalysisOptions
): AmountAnalysis {
  const { allowRounding, rounding, allowZeroAmount, redactAmounts } = options;

  if (typeof input === "bigint") {
    if (input < 0n) {
      return {
        ok: false,
        code: "NEGATIVE_AMOUNT",
        detail: `Negative payout amount ${input.toString()} is not payable.`,
        redactedDetail: "Negative payout amounts are not payable.",
        suggestedFix: "Use a non-negative amount in the asset's smallest unit.",
      };
    }

    if (input === 0n && !allowZeroAmount) {
      return {
        ok: false,
        code: "ZERO_AMOUNT",
        detail: "Zero payout amount is not permitted; omit the payout instead.",
        redactedDetail: "Zero payout amounts are not permitted; omit the payout instead.",
        suggestedFix: "Remove zero-valued entries or enable `allowZeroAmount` explicitly.",
      };
    }

    return { ok: true, amount: input, wasRounded: false };
  }

  if (typeof input === "number" && !Number.isFinite(input)) {
    const rendered = redactAmounts ? "[REDACTED]" : String(input);
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      detail: `Payout amount ${rendered} is not a finite number.`,
      redactedDetail: "Payout amount is not a finite number.",
      suggestedFix: "Pass a finite decimal number, decimal string, or bigint amount.",
    };
  }

  if (typeof input !== "string" && typeof input !== "number") {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      detail: `Payout amount must be a bigint, decimal string, or number; received ${typeof input}.`,
      redactedDetail: "Payout amount has an unsupported type.",
      suggestedFix: "Pass a bigint, decimal string, or number amount.",
    };
  }

  const rawText = typeof input === "number" ? String(input) : input;
  const renderedRaw = redactAmounts ? "[REDACTED]" : `"${rawText}"`;

  // A `number` can only carry `MAX_SAFE_INTEGER` exactly. Once the amount is
  // scaled to the asset's smallest unit, anything larger is already lossy —
  // even if it looks like a clean decimal in source code.
  if (typeof input === "number" && input !== 0) {
    const maxSafeMagnitude = Number.MAX_SAFE_INTEGER / 10 ** decimals;
    if (Math.abs(input) > maxSafeMagnitude) {
      return {
        ok: false,
        code: "UNSAFE_NUMBER",
        detail:
          `Payout amount ${renderedRaw} is too large to be represented safely as a JavaScript ` +
          `number at ${decimals}-decimal precision; its value may already be rounded.`,
        redactedDetail:
          `Payout amount is too large to be represented safely as a JavaScript number at ` +
          `${decimals}-decimal precision.`,
        suggestedFix: "Pass the amount as a decimal string or as a bigint smallest-unit value.",
      };
    }
  }

  const normalized = normalizeDecimalString(rawText);
  if (normalized === null) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      detail: `Payout amount ${renderedRaw} is not a valid decimal number.`,
      redactedDetail: "Payout amount is not a valid decimal number.",
      suggestedFix: 'Use digits with at most one decimal point, e.g. "1250.50" or "1250.50 XLM".',
    };
  }

  if (normalized.startsWith("-")) {
    return {
      ok: false,
      code: "NEGATIVE_AMOUNT",
      detail: `Negative payout amount ${renderedRaw} is not payable.`,
      redactedDetail: "Negative payout amounts are not payable.",
      suggestedFix: "Use a non-negative amount.",
    };
  }

  const unsigned = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const isZero = /^0*$/.test(whole) && (fraction.length === 0 || /^0*$/.test(fraction));
  if (isZero) {
    if (allowZeroAmount) {
      return { ok: true, amount: 0n, wasRounded: false };
    }
    return {
      ok: false,
      code: "ZERO_AMOUNT",
      detail: "Zero payout amount is not permitted; omit the payout instead.",
      redactedDetail: "Zero payout amounts are not permitted; omit the payout instead.",
      suggestedFix: "Remove zero-valued entries or enable `allowZeroAmount` explicitly.",
    };
  }

  const keptFraction = fraction.slice(0, decimals);
  const droppedDigits = fraction.slice(decimals);
  const dropsValue = droppedDigits.length > 0 && !/^0+$/.test(droppedDigits);

  if (dropsValue && !allowRounding) {
    return {
      ok: false,
      code: "EXCESS_PRECISION",
      detail:
        `Payout amount ${renderedRaw} has ${fraction.length} fractional digits, but the asset ` +
        `supports only ${decimals}; the extra digits would be dropped, changing the amount paid.`,
      redactedDetail:
        `Payout amount has more fractional digits than the asset supports (${decimals}); the ` +
        `extra digits would be dropped, changing the amount paid.`,
      suggestedFix:
        `Round the amount to at most ${decimals} decimal places, or pass the exact ` +
        `smallest-unit value as a bigint.`,
    };
  }

  const scale = getDecimalScaleFactor(decimals);
  const baseAmount =
    BigInt(whole || "0") * scale + BigInt((keptFraction || "").padEnd(decimals, "0") || "0");

  // Digits beyond the asset's precision are all zeros (`"1.50000000"` at 7
  // decimals) — the value is exact, so it is not marked as rounded.
  if (!dropsValue) {
    return { ok: true, amount: baseAmount, wasRounded: false };
  }

  let roundUp: boolean;
  switch (rounding) {
    case RoundingMode.CEIL:
      roundUp = true;
      break;
    case RoundingMode.TRUNCATE:
    case RoundingMode.FLOOR:
      roundUp = false;
      break;
    case RoundingMode.HALF_UP:
    default:
      roundUp = Number(droppedDigits[0]) >= 5;
      break;
  }

  return { ok: true, amount: roundUp ? baseAmount + 1n : baseAmount, wasRounded: true };
}

/** Build a fully-populated, privacy-aware issue object. */
function buildIssue(params: {
  code: PayoutPrecisionIssueCode;
  detail: string;
  redactedDetail: string;
  suggestedFix: string;
  employeeId?: string;
  assetId: string;
  assetSymbol: string;
  decimals?: number;
  rawInput?: string;
  amount?: bigint;
  entryIndex?: number;
  redactEmployeeIds: boolean;
  redactAmounts: boolean;
}): PayoutPrecisionIssue {
  const {
    code,
    detail,
    redactedDetail,
    suggestedFix,
    employeeId,
    assetId,
    assetSymbol,
    decimals,
    rawInput,
    amount,
    entryIndex,
    redactEmployeeIds,
    redactAmounts,
  } = params;

  const trimmedEmployeeId = employeeId?.trim();
  const employeeLabel = trimmedEmployeeId || "anonymous recipient";
  const safeEmployeeLabel = redactEmployeeIds ? redactEmployeeId(trimmedEmployeeId) : employeeLabel;

  const issue: PayoutPrecisionIssue = {
    code,
    redactedEmployeeId: safeEmployeeLabel,
    assetId,
    assetSymbol,
    message: `${detail} (asset: ${assetSymbol}; employee: ${employeeLabel})`,
    redactedMessage: `${redactedDetail} (asset: ${assetSymbol}; employee: ${safeEmployeeLabel})`,
    suggestedFix,
  };

  if (entryIndex !== undefined) {
    issue.entryIndex = entryIndex;
  }
  if (trimmedEmployeeId) {
    issue.employeeId = trimmedEmployeeId;
  }
  if (decimals !== undefined) {
    issue.decimals = decimals;
  }
  if (rawInput !== undefined && !redactAmounts) {
    issue.input = rawInput;
  }
  if (amount !== undefined) {
    issue.amount = amount;
  }

  return issue;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify that a single payout amount can be represented exactly in its asset's
 * smallest unit.
 *
 * The check never rounds implicitly: an amount whose non-zero digits exceed the
 * asset's precision is reported as `EXCESS_PRECISION` so the caller can fix the
 * source data (or explicitly opt into rounding with `allowRounding`).
 *
 * @param entry - Amount and asset to verify.
 * @param options - Verification configuration (bounds, rounding, redaction).
 * @returns A structured result; `isValid` is `true` only when `issues` is empty.
 */
export function verifyPayoutPrecision(
  entry: PayoutPrecisionEntry,
  options: PayoutPrecisionVerificationOptions = {}
): PayoutPrecisionVerificationResult {
  return verifySingleEntry(entry, options);
}

function verifySingleEntry(
  entry: PayoutPrecisionEntry,
  options: PayoutPrecisionVerificationOptions,
  entryIndex?: number
): PayoutPrecisionVerificationResult {
  const {
    allowRounding = false,
    rounding = RoundingMode.HALF_UP,
    allowZeroAmount = false,
    minAmount = 1n,
    maxAmount = MAX_I128_PAYOUT_AMOUNT,
    redactAmounts = true,
    redactEmployeeIds = true,
    registry = AssetRegistry,
  } = options;

  const issueContext = {
    employeeId: entry?.employeeId,
    entryIndex,
    redactAmounts,
    redactEmployeeIds,
  };

  if (!entry || typeof entry !== "object") {
    const issue = buildIssue({
      ...issueContext,
      code: "INVALID_AMOUNT",
      detail: "Payout entry is missing.",
      redactedDetail: "Payout entry is missing.",
      suggestedFix: "Provide an object with `amount` and `asset`.",
      assetId: "unknown",
      assetSymbol: "unknown",
    });
    return {
      isValid: false,
      assetId: "unknown",
      assetSymbol: "unknown",
      decimals: 0,
      wasRounded: false,
      issues: [issue],
    };
  }

  // ── 1. Resolve asset metadata ────────────────────────────────────────────
  let metadata: AssetMetadata | undefined;
  let assetId = "unknown";

  if (typeof entry.asset === "object" && entry.asset !== null) {
    metadata = entry.asset;
    assetId = metadata.id || metadata.symbol || "unknown";
  } else if (typeof entry.asset === "string" && entry.asset.trim().length > 0) {
    assetId = entry.asset.trim();
    metadata = registry.get(assetId);
  }

  if (!metadata) {
    const issue = buildIssue({
      ...issueContext,
      code: "UNKNOWN_ASSET",
      detail: `Asset "${assetId}" is not registered, so its payout precision cannot be verified.`,
      redactedDetail: `Asset "${assetId}" is not registered, so its payout precision cannot be verified.`,
      suggestedFix: "Register the asset by id or symbol, or pass its full AssetMetadata.",
      assetId,
      assetSymbol: assetId.toUpperCase(),
    });

    return {
      isValid: false,
      assetId,
      assetSymbol: issue.assetSymbol,
      decimals: 0,
      wasRounded: false,
      issues: [issue],
    };
  }

  const assetSymbol = metadata.symbol || metadata.id || assetId;

  // ── 2. Validate asset precision ──────────────────────────────────────────
  if (!isValidDecimals(metadata.decimals)) {
    const issue = buildIssue({
      ...issueContext,
      code: "INVALID_DECIMALS",
      detail:
        `Asset ${assetSymbol} declares ${String(metadata.decimals)} decimal places, but payout ` +
        `precision must be an integer between ${MIN_SUPPORTED_DECIMALS} and ` +
        `${MAX_SUPPORTED_DECIMALS}.`,
      redactedDetail:
        `Asset ${assetSymbol} declares an unsupported decimal precision; expected an integer ` +
        `between ${MIN_SUPPORTED_DECIMALS} and ${MAX_SUPPORTED_DECIMALS}.`,
      suggestedFix: "Set the asset's decimals to an integer between 0 and 18.",
      assetId,
      assetSymbol,
    });

    return {
      isValid: false,
      assetId,
      assetSymbol,
      decimals: 0,
      wasRounded: false,
      issues: [issue],
    };
  }

  const decimals = metadata.decimals;

  // ── 3. Verify the amount itself ──────────────────────────────────────────
  const analysis = analyzeAmount(entry.amount, decimals, {
    allowRounding,
    rounding,
    allowZeroAmount,
    redactAmounts,
  });

  const rawInput =
    typeof entry.amount === "bigint" ? entry.amount.toString() : String(entry.amount);

  if (!analysis.ok) {
    const issue = buildIssue({
      ...issueContext,
      code: analysis.code,
      detail: analysis.detail,
      redactedDetail: analysis.redactedDetail,
      suggestedFix: analysis.suggestedFix,
      assetId,
      assetSymbol,
      decimals,
      rawInput,
    });

    return {
      isValid: false,
      assetId,
      assetSymbol,
      decimals,
      wasRounded: false,
      issues: [issue],
    };
  }

  // ── 4. Enforce canonical bounds ──────────────────────────────────────────
  const amount = analysis.amount;
  const zeroAllowed = allowZeroAmount && amount === 0n;
  const belowMinimum = amount < minAmount && !zeroAllowed;
  const aboveMaximum = amount > maxAmount;

  if (belowMinimum || aboveMaximum) {
    const direction = belowMinimum ? "below" : "above";
    const rangeText =
      `${formatCanonicalAmount(minAmount, decimals, assetSymbol)} to ` +
      `${formatCanonicalAmount(maxAmount, decimals, assetSymbol)}`;

    const issue = buildIssue({
      ...issueContext,
      code: "AMOUNT_OUT_OF_RANGE",
      detail:
        `Payout amount ${formatCanonicalAmount(amount, decimals, assetSymbol)} is ${direction} ` +
        `the permitted range (${rangeText}).`,
      redactedDetail: `Payout amount is ${direction} the permitted range (${rangeText}).`,
      suggestedFix: "Adjust the amount to fall within the permitted payout range.",
      assetId,
      assetSymbol,
      decimals,
      rawInput,
      amount,
    });

    return {
      isValid: false,
      amount,
      assetId,
      assetSymbol,
      decimals,
      wasRounded: analysis.wasRounded,
      issues: [issue],
    };
  }

  // ── 5. Valid ─────────────────────────────────────────────────────────────
  return {
    isValid: true,
    amount,
    assetId,
    assetSymbol,
    decimals,
    wasRounded: analysis.wasRounded,
    issues: [],
  };
}

/**
 * Verify a batch of payout amounts, preserving input order.
 *
 * Each issue is annotated with the `entryIndex` of the entry that produced it,
 * which lets the caller map problems back to payroll rows.
 *
 * @param entries - Payout amounts to verify.
 * @param options - Verification configuration applied to every entry.
 * @returns Per-entry results, flattened issues, and summary counts.
 */
export function verifyPayoutPrecisionBatch(
  entries: readonly PayoutPrecisionEntry[],
  options: PayoutPrecisionVerificationOptions = {}
): PayoutPrecisionBatchResult {
  const results = entries.map((entry, index) => verifySingleEntry(entry, options, index));
  const issues = results.flatMap((result) => result.issues);
  const countByCode = (code: PayoutPrecisionIssueCode): number =>
    issues.filter((issue) => issue.code === code).length;
  const validCount = results.filter((result) => result.isValid).length;

  return {
    isValid: issues.length === 0,
    results,
    issues,
    summary: {
      totalEntries: results.length,
      validCount,
      invalidCount: results.length - validCount,
      issueCount: issues.length,
      excessPrecisionCount: countByCode("EXCESS_PRECISION"),
      unsafeNumberCount: countByCode("UNSAFE_NUMBER"),
      unknownAssetCount: countByCode("UNKNOWN_ASSET"),
      outOfRangeCount: countByCode("AMOUNT_OUT_OF_RANGE"),
    },
  };
}

/**
 * Convenience predicate for UI and preflight badges.
 *
 * @returns `true` when the amount passes verification.
 */
export function isPayoutAmountPrecise(
  entry: PayoutPrecisionEntry,
  options: PayoutPrecisionVerificationOptions = {}
): boolean {
  return verifyPayoutPrecision(entry, options).isValid;
}

/**
 * Verify a payout amount and throw when it cannot be represented exactly.
 *
 * @throws {PayoutPrecisionError} When one or more issues are found.
 */
export function assertPayoutPrecision(
  entry: PayoutPrecisionEntry,
  options: PayoutPrecisionVerificationOptions = {}
): PayoutPrecisionVerificationResult {
  const result = verifyPayoutPrecision(entry, options);
  if (!result.isValid) {
    throw new PayoutPrecisionError(result.issues, options.redactAmounts !== false);
  }
  return result;
}

/**
 * Verify a batch of payout amounts and throw when any entry fails.
 *
 * @throws {PayoutPrecisionError} Carrying every issue, annotated with `entryIndex`.
 */
export function assertPayoutPrecisionBatch(
  entries: readonly PayoutPrecisionEntry[],
  options: PayoutPrecisionVerificationOptions = {}
): PayoutPrecisionBatchResult {
  const result = verifyPayoutPrecisionBatch(entries, options);
  if (!result.isValid) {
    const error = new PayoutPrecisionError(result.issues, options.redactAmounts !== false);
    error.message =
      `${result.summary.invalidCount} of ${result.summary.totalEntries} payout entries failed ` +
      `precision verification: ${error.message}`;
    throw error;
  }
  return result;
}
