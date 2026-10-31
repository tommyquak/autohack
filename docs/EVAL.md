# Evaluation table (test set)

Produced by `uv run python -m triage.evaluate` on `main` @ `48c28d4`, test file sha256 starts `fc4110e979e7d569` (matches docs/algorithm/VERIFICATION.md).
24,484 CDMs. True classes: 15,756 below threshold, 6,501 Elevated, 2,227 Critical. Per CDM; split by event; `risk` is the label only.

| Method | Critical recall | False alarms (truly below threshold, flagged) | Flagged for review | Under-tiered CDMs | Macro F1 |
|---|---|---|---|---|---|
| Always below threshold | 0.0% | 0 | 0.0% | 8,728 | 0.261 |
| Miss-distance rule | 95.9% | 0 | 31.4% | 1,116 | 0.952 |
| Pc upper-bound rule (status quo) | 100.0% | 4,534 | 54.2% | 0 | 0.841 |
| **Second Look (rules + model)** | 100.0% | 2,214 | 44.7% | 1 | 0.910 |

**Where we lose:** the miss-distance rule has the highest macro F1, but it under-tiers 91 truly Critical CDMs. We never accept that trade.
**Critical recall 100% comes from the rules**, which set Critical; the model may only demote Pc-only Elevated warnings.

## By days to closest approach (Second Look)

| Days to TCA | CDMs | Critical recall | Flagged: status quo → Second Look |
|---|---|---|---|
| 2-4 d | 10,964 | 100.0% | 52.2% → 40.5% |
| 4-7 d | 13,520 | 100.0% | 55.7% → 48.1% |

No test CDM is closer than 2 days to TCA, so the 0-2 day buckets are empty.

## Provenance
- Reproduced independently: the model-v2 workflow's verifier re-ran v1 on the test set and got the identical confusion matrix `[[13542, 2206, 8], [1, 6335, 165], [0, 0, 2227]]`.
- **Kalent (evaluation owner) to sign off** by re-running the command above.
