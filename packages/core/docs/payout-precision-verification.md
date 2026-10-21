# Payout Precision Verification (#740)

`verifyPayoutPrecision` / `assertPayoutPrecision` guarantee that every payout
amount can be represented **exactly** in its asset's smallest unit before the
payroll payout instructions are built and submitted.

## Why this exists

Stellar assets have a fixed precision (7 decimals for XLM; registered Soroban
tokens may use 6 or 18). Amounts carrying more fractional digits than the asset
supports are silently truncated by conversion helpers, which causes:

- recipients being paid an amount different from the approved payroll;
- payout totals that no longer reconcile with the approved run;
- disputed or failed runs that the SDK never surfaced.

`0.1 + 0.2 === 0.30000000000000004` cannot be represented at 7 decimals even
though each operand "looks" valid. This module performs all arithmetic with
`bigint` and rejects values that would lose value instead of rounding silently.

## API

```typescript
import {
  verifyPayoutPrecision,
  verifyPayoutPrecisionBatch,
  assertPayoutPrecision,
  assertPayoutPrecisionBatch,
  isPayoutAmountPrecise,
  PayoutPrecisionError,
  MAX_I128_PAYOUT_AMOUNT,
} from "@zk-payroll/core";
```

### `verifyPayoutPrecision(entry, options?)`

Returns a `PayoutPrecisionVerificationResult`:

```typescript
interface PayoutPrecisionVerificationResult {
  isValid: boolean;
  amount?: bigint; // canonical smallest-unit amount (set when valid)
  assetId: string;
  assetSymbol: string;
  decimals: number;
  wasRounded: boolean;
  issues: PayoutPrecisionIssue[];
}
```

Amount inputs:

| Input    | Interpreted as                                                      |
| -------- | ------------------------------------------------------------------- |
| `bigint` | Canonical smallest units — never rescaled                           |
| `string` | Human-readable decimal (`"1250.50"`, `"1,250.50 XLM"`, `"1e-7"`)    |
| `number` | Human-readable decimal; rejected when unsafe at the asset precision |

Assets are resolved from `AssetMetadata` or from the `AssetRegistry` by id or
symbol (`"native"`, `"USDC"`, `"EUROC"`).

### Options

| Option              | Default                  | Description                                                     |
| ------------------- | ------------------------ | --------------------------------------------------------------- |
| `allowRounding`     | `false`                  | Round excess digits instead of rejecting the amount             |
| `rounding`          | `RoundingMode.HALF_UP`   | `HALF_UP`, `TRUNCATE`, `CEIL`, or `FLOOR` when rounding         |
| `allowZeroAmount`   | `false`                  | Permit zero-valued payouts                                      |
| `minAmount`         | `1n`                     | Minimum canonical amount                                        |
| `maxAmount`         | `MAX_I128_PAYOUT_AMOUNT` | Maximum canonical amount (`2^127 - 1`, the Stellar i128 range)  |
| `redactAmounts`     | `true`                   | Hide amounts in diagnostic messages                             |
| `redactEmployeeIds` | `true`                   | Hide employee ids in `redactedMessage`                          |
| `registry`          | `AssetRegistry`          | Custom registry for string asset identifiers                    |

### Issue codes

| Code                  | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `EXCESS_PRECISION`    | Non-zero digits beyond the asset precision would be dropped        |
| `UNSAFE_NUMBER`       | `number` input too large to hold the amount at the asset precision |
| `INVALID_AMOUNT`      | Malformed or unsupported amount value                              |
| `NEGATIVE_AMOUNT`     | Negative amounts are not payable                                   |
| `ZERO_AMOUNT`         | Zero amount without `allowZeroAmount`                              |
| `AMOUNT_OUT_OF_RANGE` | Canonical amount outside `minAmount..maxAmount`                    |
| `UNKNOWN_ASSET`       | Asset identifier is not registered                                 |
| `INVALID_DECIMALS`    | Asset decimals are not an integer in `0..18`                       |

Each issue includes `message` (full detail for internal audit), `redactedMessage`
(safe for UI/telemetry), `suggestedFix`, and `redactedEmployeeId`.

## Examples

### Reject value-losing amounts

```typescript
const result = verifyPayoutPrecision({
  employeeId: "emp-12345",
  amount: "1250.50000001",
  asset: "native",
});

result.isValid; // false
result.issues[0].code; // "EXCESS_PRECISION"
result.issues[0].redactedMessage; // no employee id, no amount
```

### Preflight an entire payroll run

```typescript
const report = verifyPayoutPrecisionBatch(payrollEntries);

if (!report.isValid) {
  // report.issues[i].entryIndex maps each problem back to its payroll row
  console.error(report.summary);
}
// => { totalEntries, validCount, invalidCount, issueCount,
//      excessPrecisionCount, unsafeNumberCount, unknownAssetCount, outOfRangeCount }
```

### Fail fast before submitting

```typescript
try {
  const { amount } = assertPayoutPrecision(
    { employeeId: "emp-12345", amount: "1250.50", asset: "native" },
    { maxAmount: 100_000_000_000n }
  );
  // build and submit the payout with `amount` (bigint smallest units)
} catch (error) {
  if (error instanceof PayoutPrecisionError) {
    // error.code, error.issues
  }
}
```

### Opt into explicit rounding

```typescript
const result = verifyPayoutPrecision(
  {
    amount: "1.235",
    asset: { id: "TST2", symbol: "TST2", label: "Test", decimals: 2 },
  },
  { allowRounding: true }
);

result.amount; // 124n
result.wasRounded; // true
```

## Integration guidance

1. Call `verifyPayoutPrecisionBatch` on the approved payroll payload before
   building payout instructions.
2. Block submission when `isValid` is `false`; surface `redactedMessage` and
   `suggestedFix` in the UI.
3. Normalise source data to the asset's precision (or pass `bigint` smallest
   units) rather than enabling `allowRounding`; rounding changes what the
   recipient is paid and must be a deliberate, audited decision.
4. Persist `issue.code` and `entryIndex` for reconciliation and audit trails;
   never log raw amounts or employee ids from `redactedMessage` contexts.

## Limitations

- The asset must be registered (or supplied as full `AssetMetadata`); the
  registry performs no network lookup.
- The check validates representability and configured bounds. It does not check
  treasury balance, network fees, or on-chain state.
- `number` amounts are limited by `Number.MAX_SAFE_INTEGER / 10^decimals`; prefer
  strings or `bigint` for large institutional amounts.

