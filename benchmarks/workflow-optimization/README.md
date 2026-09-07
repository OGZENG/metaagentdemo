# Workflow Optimization Benchmark

This benchmark compares the fixed multi-agent Baseline with the Iterative variant on the same 20 multiple-choice mathematics tasks. It calls Flowise through the Prediction API, runs tasks sequentially with isolated sessions, scores answer options, and exports execution metrics from `agentFlowExecutedData`.

## Prerequisites

1. Build and start Flowise.
2. Save both Agentflows.
3. Keep all shared node prompts and model settings identical. The only intended experimental difference is the conditional revision branch.
4. If the flows require an API key, create one in Flowise and pass it with `--api-key` or `FLOWISE_API_KEY`.

## Smoke test

Run the first five cases before spending tokens on the complete benchmark:

```powershell
node benchmarks/workflow-optimization/run-benchmark.mjs `
  --baseline-id "BASELINE_FLOW_ID" `
  --iterative-id "ITERATIVE_FLOW_ID" `
  --limit 5
```

## Complete benchmark

```powershell
node benchmarks/workflow-optimization/run-benchmark.mjs `
  --baseline-id "BASELINE_FLOW_ID" `
  --iterative-id "ITERATIVE_FLOW_ID"
```

For a server on another address or a protected flow:

```powershell
$env:FLOWISE_API_KEY = "YOUR_API_KEY"
node benchmarks/workflow-optimization/run-benchmark.mjs `
  --baseline-id "BASELINE_FLOW_ID" `
  --iterative-id "ITERATIVE_FLOW_ID" `
  --base-url "http://localhost:3000/api/v1" `
  --repetitions 1
```

Each task is executed sequentially and receives a unique `chatId` and `sessionId`. This prevents conversation memory from leaking between test cases and avoids distorting latency measurements with client-side concurrency.

## Outputs

Every run creates a timestamped directory under `benchmarks/workflow-optimization/results/` containing:

- `benchmark-results.json`: complete responses and node-level counts for reproducibility.
- `benchmark-results.csv`: one row per task execution for spreadsheet analysis.
- `benchmark-summary.md`: comparison of accuracy, answer extraction, tokens, cost, latency, model calls, and revision rate.
- `baseline-checkpoint.json` and `iterative-checkpoint.json`: updated after every task so partial results survive interruption.

The primary Accuracy metric is strict: an extraction failure counts as incorrect. Conditional Accuracy is also reported over responses where an option A–D was extracted. Always inspect `answerExtractionRate`; a low value means the output template or answer parser needs correction before the run can be treated as a formal experiment.

If answer extraction rules are improved after a run, rescore the saved responses without making additional model calls:

```powershell
node benchmarks/workflow-optimization/rescore-report.mjs `
  benchmarks/workflow-optimization/results/formal-20/benchmark-results.json
```

## Tests

```powershell
node --test benchmarks/workflow-optimization/benchmark-lib.test.mjs
```

## Formal experiment notes

- Use the same dataset, model, temperature, maximum tokens, credentials, and shared prompts for both variants.
- Do not edit the dataset after collecting formal results. Create a versioned copy instead.
- First use `--limit 5` as a smoke test. Only run all 20 after answer extraction and token collection are verified.
- One repetition is sufficient for pipeline validation. Multiple repetitions are preferable when measuring stochastic model behavior, but they multiply API cost.
