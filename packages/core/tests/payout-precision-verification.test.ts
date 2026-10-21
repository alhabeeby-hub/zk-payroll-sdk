import { AssetMetadata } from "../src/assets/types";
import { RoundingMode } from "../src/assets/amountParsing";
import {
  MAX_I128_PAYOUT_AMOUNT,
  PayoutPrecisionError,
  assertPayoutPrecision,
  assertPayoutPrecisionBatch,
  isPayoutAmountPrecise,
  verifyPayoutPrecision,
  verifyPayoutPrecisionBatch,
} from "../src/payroll/payoutPrecisionVerification";

const twoDecimalAsset: AssetMetadata = {
  id: "TST2",
  symbol: "TST2",
  label: "Test Two-Decimal Asset",
  decimals: 2,
};

const eighteenDecimalAsset: AssetMetadata = {
  id: "TST18",
  symbol: "TST18",
  label: "Test Eighteen-Decimal Asset",
  decimals: 18,
};

const zeroDecimalAsset: AssetMetadata = {
  id: "TST0",
  symbol: "TST0",
  label: "Test Zero-Decimal Asset",
  decimals: 0,
};

describe("Payout Precision Verification", () => {
  describe("exact amounts", () => {
    it("converts a decimal string amount into smallest units", () => {
      const result = verifyPayoutPrecision({
        employeeId: "emp-12345",
        amount: "1250.50",
        asset: "native",
      });

      expect(result.isValid).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.amount).toBe(12_505_000_000n);
      expect(result.decimals).toBe(7);
      expect(result.assetSymbol).toBe("XLM");
      expect(result.wasRounded).toBe(false);
    });

    it("accepts integer strings and amounts with fewer fractional digits", () => {
      expect(verifyPayoutPrecision({ amount: "100", asset: "native" }).amount).toBe(1_000_000_000n);
      expect(verifyPayoutPrecision({ amount: "0.5", asset: "native" }).amount).toBe(5_000_000n);
      expect(verifyPayoutPrecision({ amount: "0.0000001", asset: "native" }).amount).toBe(1n);
    });

    it("treats bigint amounts as canonical smallest units without rescaling", () => {
      const result = verifyPayoutPrecision({ amount: 123_456_789n, asset: "native" });

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(123_456_789n);
    });

    it("accepts safe number amounts without floating-point drift", () => {
      const result = verifyPayoutPrecision({ amount: 12.5, asset: "native" });

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(125_000_000n);
    });

    it("accepts trailing zeros beyond the asset precision as exact", () => {
      const result = verifyPayoutPrecision({ amount: "1.50000000", asset: "native" });

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(15_000_000n);
      expect(result.wasRounded).toBe(false);
    });

    it("accepts formatted amounts with separators and a trailing symbol", () => {
      expect(verifyPayoutPrecision({ amount: "1,250.50 XLM", asset: "native" }).amount).toBe(
        12_505_000_000n
      );
      expect(verifyPayoutPrecision({ amount: "$10.25", asset: twoDecimalAsset }).amount).toBe(
        1025n
      );
    });

    it("expands scientific notation before scaling", () => {
      expect(verifyPayoutPrecision({ amount: "1e-7", asset: "native" }).amount).toBe(1n);
      expect(verifyPayoutPrecision({ amount: "1.5E+3", asset: "native" }).amount).toBe(
        15_000_000_000n
      );
    });

    it("supports zero-decimal and eighteen-decimal assets", () => {
      expect(verifyPayoutPrecision({ amount: "5", asset: zeroDecimalAsset }).amount).toBe(5n);
      expect(
        verifyPayoutPrecision({ amount: "0.000000000000000001", asset: eighteenDecimalAsset })
          .amount
      ).toBe(1n);
    });

    it("resolves assets by symbol as well as by id", () => {
      const result = verifyPayoutPrecision({ amount: "2.5", asset: "USDC" });

      expect(result.isValid).toBe(true);
      expect(result.assetSymbol).toBe("USDC");
      expect(result.amount).toBe(25_000_000n);
    });
  });

  describe("excess precision", () => {
    it("rejects an amount with non-zero digits beyond the asset precision", () => {
      const result = verifyPayoutPrecision({
        employeeId: "emp-12345",
        amount: "1250.50000001",
        asset: "native",
      });

      expect(result.isValid).toBe(false);
      expect(result.amount).toBeUndefined();
      expect(result.issues).toHaveLength(1);

      const issue = result.issues[0];
      expect(issue.code).toBe("EXCESS_PRECISION");
      expect(issue.decimals).toBe(7);
      expect(issue.assetSymbol).toBe("XLM");
      expect(issue.employeeId).toBe("emp-12345");
      expect(issue.suggestedFix).toContain("7 decimal places");
    });

    it("rejects the smallest possible excess digit", () => {
      const result = verifyPayoutPrecision({ amount: "0.00000001", asset: "native" });
      expect(result.issues[0]?.code).toBe("EXCESS_PRECISION");
    });

    it("rejects excess digits for a two-decimal asset", () => {
      const result = verifyPayoutPrecision({ amount: "1.239", asset: twoDecimalAsset });
      expect(result.issues[0]?.code).toBe("EXCESS_PRECISION");
    });

    it("rounds explicitly when allowRounding is enabled", () => {
      const halfUp = verifyPayoutPrecision(
        { amount: "1.235", asset: twoDecimalAsset },
        { allowRounding: true, rounding: RoundingMode.HALF_UP }
      );
      expect(halfUp.isValid).toBe(true);
      expect(halfUp.amount).toBe(124n);
      expect(halfUp.wasRounded).toBe(true);

      const truncate = verifyPayoutPrecision(
        { amount: "1.239", asset: twoDecimalAsset },
        { allowRounding: true, rounding: RoundingMode.TRUNCATE }
      );
      expect(truncate.amount).toBe(123n);
      expect(truncate.wasRounded).toBe(true);

      const ceiling = verifyPayoutPrecision(
        { amount: "1.231", asset: twoDecimalAsset },
        { allowRounding: true, rounding: RoundingMode.CEIL }
      );
      expect(ceiling.amount).toBe(124n);
      expect(ceiling.wasRounded).toBe(true);
    });

    it("rounds half-up by default when allowRounding is enabled", () => {
      const result = verifyPayoutPrecision(
        { amount: "1.234", asset: twoDecimalAsset },
        { allowRounding: true }
      );
      expect(result.amount).toBe(123n);
      expect(result.wasRounded).toBe(true);
    });
  });

  describe("unsafe number inputs", () => {
    it("rejects numbers that cannot hold the amount at the asset precision", () => {
      const result = verifyPayoutPrecision({
        employeeId: "emp-12345",
        amount: 1_000_000_000,
        asset: "native",
      });

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("UNSAFE_NUMBER");
      expect(result.issues[0]?.decimals).toBe(7);
      expect(result.issues[0]?.suggestedFix).toContain("decimal string");
    });

    it("rejects numbers with floating-point artifacts beyond the precision", () => {
      const result = verifyPayoutPrecision({ amount: 0.1 + 0.2, asset: "native" });

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("EXCESS_PRECISION");
    });

    it("accepts numbers that stay within the safe integer range", () => {
      const result = verifyPayoutPrecision({ amount: 900_000_000, asset: "native" });

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(9_000_000_000_000_000n);
    });
  });

  describe("invalid, negative and zero amounts", () => {
    it.each([[""], ["   "], ["abc"], ["1.2.3"], ["1..2"]])(
      "rejects the malformed amount %p as INVALID_AMOUNT",
      (amount) => {
        const result = verifyPayoutPrecision({ amount, asset: "native" });
        expect(result.isValid).toBe(false);
        expect(result.issues[0]?.code).toBe("INVALID_AMOUNT");
      }
    );

    it("rejects non-finite numbers", () => {
      expect(verifyPayoutPrecision({ amount: Number.NaN, asset: "native" }).issues[0]?.code).toBe(
        "INVALID_AMOUNT"
      );
      expect(
        verifyPayoutPrecision({ amount: Number.POSITIVE_INFINITY, asset: "native" }).issues[0]?.code
      ).toBe("INVALID_AMOUNT");
    });

    it("rejects unsupported amount types", () => {
      const result = verifyPayoutPrecision({
        amount: { value: 10 } as unknown as string,
        asset: "native",
      });
      expect(result.issues[0]?.code).toBe("INVALID_AMOUNT");
    });

    it("rejects negative string and bigint amounts", () => {
      expect(verifyPayoutPrecision({ amount: "-1.5", asset: "native" }).issues[0]?.code).toBe(
        "NEGATIVE_AMOUNT"
      );
      expect(verifyPayoutPrecision({ amount: -5n, asset: "native" }).issues[0]?.code).toBe(
        "NEGATIVE_AMOUNT"
      );
    });

    it("rejects zero amounts by default", () => {
      expect(verifyPayoutPrecision({ amount: "0.0000000", asset: "native" }).issues[0]?.code).toBe(
        "ZERO_AMOUNT"
      );
      expect(verifyPayoutPrecision({ amount: 0n, asset: "native" }).issues[0]?.code).toBe(
        "ZERO_AMOUNT"
      );
      expect(verifyPayoutPrecision({ amount: 0, asset: "native" }).issues[0]?.code).toBe(
        "ZERO_AMOUNT"
      );
    });

    it("accepts zero amounts when explicitly allowed", () => {
      const result = verifyPayoutPrecision(
        { amount: 0n, asset: "native" },
        { allowZeroAmount: true }
      );

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(0n);
    });
  });

  describe("asset resolution", () => {
    it("reports unregistered assets instead of guessing their precision", () => {
      const result = verifyPayoutPrecision({ amount: "1", asset: "DOGE" });

      expect(result.isValid).toBe(false);
      expect(result.decimals).toBe(0);
      expect(result.issues[0]?.code).toBe("UNKNOWN_ASSET");
      expect(result.issues[0]?.assetSymbol).toBe("DOGE");
    });

    it("rejects assets whose decimals are outside the supported range", () => {
      const invalidAsset = {
        id: "BAD",
        symbol: "BAD",
        label: "Broken Asset",
        decimals: 19,
      } as AssetMetadata;

      const result = verifyPayoutPrecision({ amount: "1", asset: invalidAsset });

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("INVALID_DECIMALS");
      expect(result.issues[0]?.decimals).toBeUndefined();
    });

    it("uses registry metadata for native assets", () => {
      const result = verifyPayoutPrecision({ amount: "1", asset: "native" });
      expect(result.assetId).toBe("native");
      expect(result.assetSymbol).toBe("XLM");
      expect(result.decimals).toBe(7);
    });
  });

  describe("canonical range", () => {
    it("rejects amounts above a custom maximum", () => {
      const result = verifyPayoutPrecision(
        { amount: "101", asset: "native" },
        { maxAmount: 100_000_000n }
      );

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("AMOUNT_OUT_OF_RANGE");
      expect(result.issues[0]?.message).toContain("above");
      expect(result.issues[0]?.amount).toBe(1_010_000_000n);
    });

    it("rejects amounts below a custom minimum", () => {
      const result = verifyPayoutPrecision(
        { amount: "0.0000005", asset: "native" },
        { minAmount: 10n }
      );

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("AMOUNT_OUT_OF_RANGE");
      expect(result.issues[0]?.message).toContain("below");
      expect(result.issues[0]?.amount).toBe(5n);
    });

    it("rejects amounts above the Stellar i128 range", () => {
      const aboveI128 = "20000000000000000000000000000000";
      const result = verifyPayoutPrecision({ amount: aboveI128, asset: "native" });

      expect(result.isValid).toBe(false);
      expect(result.issues[0]?.code).toBe("AMOUNT_OUT_OF_RANGE");
      expect(MAX_I128_PAYOUT_AMOUNT).toBe((1n << 127n) - 1n);
    });
  });

  describe("redaction", () => {
    it("redacts employee ids and amounts in redactedMessage by default", () => {
      const result = verifyPayoutPrecision({
        employeeId: "emp-12345",
        amount: "1.12345678",
        asset: "native",
      });
      const issue = result.issues[0];

      expect(issue.redactedEmployeeId).toBe("emp***345");
      expect(issue.redactedMessage).toContain("emp***345");
      expect(issue.redactedMessage).not.toContain("emp-12345");
      expect(issue.redactedMessage).not.toContain("1.12345678");
      expect(issue.message).not.toContain("1.12345678");
      expect(issue.input).toBeUndefined();
    });

    it("exposes full detail when redaction is disabled", () => {
      const result = verifyPayoutPrecision(
        { employeeId: "emp-12345", amount: "1.12345678", asset: "native" },
        { redactAmounts: false, redactEmployeeIds: false }
      );
      const issue = result.issues[0];

      expect(issue.message).toContain("1.12345678");
      expect(issue.input).toBe("1.12345678");
      expect(issue.redactedEmployeeId).toBe("emp-12345");
    });

    it("uses an anonymous placeholder when no employee id is supplied", () => {
      const result = verifyPayoutPrecision({ amount: "1.12345678", asset: "native" });
      expect(result.issues[0]?.redactedEmployeeId).toBe("[ANONYMOUS_RECIPIENT]");
    });
  });

  describe("verifyPayoutPrecisionBatch", () => {
    it("verifies entries in order and annotates issues with their index", () => {
      const result = verifyPayoutPrecisionBatch([
        { employeeId: "emp-1", amount: "10", asset: "native" },
        { employeeId: "emp-2", amount: "10.00000001", asset: "native" },
        { employeeId: "emp-3", amount: "10", asset: "DOGE" },
        { employeeId: "emp-4", amount: 5n, asset: "USDC" },
      ]);

      expect(result.isValid).toBe(false);
      expect(result.results).toHaveLength(4);
      expect(result.results[0].isValid).toBe(true);
      expect(result.results[1].isValid).toBe(false);
      expect(result.results[2].isValid).toBe(false);
      expect(result.results[3].isValid).toBe(true);

      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].entryIndex).toBe(1);
      expect(result.issues[0].code).toBe("EXCESS_PRECISION");
      expect(result.issues[1].entryIndex).toBe(2);
      expect(result.issues[1].code).toBe("UNKNOWN_ASSET");

      expect(result.summary).toEqual({
        totalEntries: 4,
        validCount: 2,
        invalidCount: 2,
        issueCount: 2,
        excessPrecisionCount: 1,
        unsafeNumberCount: 0,
        unknownAssetCount: 1,
        outOfRangeCount: 0,
      });
    });

    it("returns a valid aggregate when every entry is exact", () => {
      const result = verifyPayoutPrecisionBatch([
        { amount: "1", asset: "native" },
        { amount: "2.5", asset: "USDC" },
      ]);

      expect(result.isValid).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.summary.validCount).toBe(2);
      expect(result.summary.invalidCount).toBe(0);
    });

    it("reports out-of-range counts in the summary", () => {
      const result = verifyPayoutPrecisionBatch(
        [
          { amount: "1000", asset: "native" },
          { amount: "0.5", asset: "native" },
        ],
        { maxAmount: 100_000_000n }
      );

      expect(result.summary.outOfRangeCount).toBe(1);
      expect(result.summary.validCount).toBe(1);
    });
  });

  describe("assertions", () => {
    it("returns the verification result for exact amounts", () => {
      const result = assertPayoutPrecision({ amount: "10", asset: "native" });

      expect(result.isValid).toBe(true);
      expect(result.amount).toBe(100_000_000n);
    });

    it("throws PayoutPrecisionError with a redacted message by default", () => {
      expect(() =>
        assertPayoutPrecision({
          employeeId: "emp-12345",
          amount: "10.123456789",
          asset: "native",
        })
      ).toThrow(PayoutPrecisionError);

      try {
        assertPayoutPrecision({
          employeeId: "emp-12345",
          amount: "10.123456789",
          asset: "native",
        });
        throw new Error("expected assertPayoutPrecision to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(PayoutPrecisionError);
        const precisionError = error as PayoutPrecisionError;
        expect(precisionError.code).toBe("EXCESS_PRECISION");
        expect(precisionError.message).not.toContain("10.123456789");
        expect(precisionError.message).not.toContain("emp-12345");
        expect(precisionError.issues).toHaveLength(1);
      }
    });

    it("throws with full detail when amount redaction is disabled", () => {
      try {
        assertPayoutPrecision(
          { employeeId: "emp-12345", amount: "10.123456789", asset: "native" },
          { redactAmounts: false }
        );
        throw new Error("expected assertPayoutPrecision to throw");
      } catch (error) {
        const precisionError = error as PayoutPrecisionError;
        expect(precisionError.message).toContain("10.123456789");
        expect(precisionError.message).toContain("emp-12345");
      }
    });

    it("throws for a batch when any entry is imprecise", () => {
      expect(() =>
        assertPayoutPrecisionBatch([
          { amount: "1", asset: "native" },
          { amount: "1.00000001", asset: "native" },
        ])
      ).toThrow(PayoutPrecisionError);

      try {
        assertPayoutPrecisionBatch([
          { amount: "1", asset: "native" },
          { amount: "1.00000001", asset: "native" },
        ]);
        throw new Error("expected assertPayoutPrecisionBatch to throw");
      } catch (error) {
        const precisionError = error as PayoutPrecisionError;
        expect(precisionError.message).toContain("1 of 2 payout entries failed");
        expect(precisionError.issues[0].entryIndex).toBe(1);
      }
    });

    it("returns the batch result when every entry is exact", () => {
      const result = assertPayoutPrecisionBatch([{ amount: "1", asset: "native" }]);
      expect(result.isValid).toBe(true);
    });

    it("exposes a boolean predicate", () => {
      expect(isPayoutAmountPrecise({ amount: "1.25", asset: "native" })).toBe(true);
      expect(isPayoutAmountPrecise({ amount: "1.12345678", asset: "native" })).toBe(false);
    });
  });
});
