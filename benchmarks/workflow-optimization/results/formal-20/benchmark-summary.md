# Workflow Optimization Benchmark

- Run ID: `workflow-benchmark-2026-08-14T15-34-33-121Z`
- Dataset: `C:\Users\zengy\Documents\Codex\2026-07-18\github-plugin-github-openai-curated-remote-2\flowise-mvp\Flowise-main\benchmarks\workflow-optimization\math-mcq-20.json`
- Generated: 2026-08-14T15:48:51.840Z

| Workflow | Accuracy | Conditional Accuracy | Extraction | Avg Tokens | Avg Cost | Avg Latency | Avg Calls | Revision Rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 100.0% | 100.0% | 100.0% | 3835 | $0.0070 | 19.99 s | 7.0 | 0.0% |
| Iterative | 100.0% | 100.0% | 100.0% | 3967 | $0.0071 | 20.33 s | 7.3 | 5.0% |

## Difference (second minus first)

- Accuracy: 0.0 percentage points
- Average tokens: 132
- Average cost: $0.0001
- Average latency: 0.35 seconds
- Average model calls: 0.3

## Scoring notes

- Accuracy is strict: an answer extraction failure counts as incorrect.
- Conditional Accuracy is calculated only over responses where an answer option was extracted.
- Failed API calls are reported separately and are never counted as correct.
- Every task and repetition uses an isolated chat/session ID.

