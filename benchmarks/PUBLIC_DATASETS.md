# Public benchmark experiment profiles

The Agent Optimizer and Workflow Benchmark use the same deterministic partition manifest, generated
with seed `20260815`. Optimization and validation cases are visible only to Agent Optimizer; benchmark
cases are visible only to Workflow Benchmark.

| Dataset | Quick Test | Paper-aligned | Source/license |
| --- | --- | --- | --- |
| MMLU-Pro | 40 optimization + 20 validation + 100 pilot test | 112 optimization + 48 validation + 500 final test | TIGER-AI-Lab/MMLU-Pro, Apache-2.0 |
| MuSR | 40 optimization + 20 validation + 100 pilot test | 112 optimization + 48 validation + 596 final test | Zayne-sprague/MuSR, MIT |
| GPQA | 40 optimization + 20 validation + 100 pilot test | 112 optimization + 48 validation from non-Diamond GPQA + all 198 Diamond final test | idavidrein/gpqa, CC BY 4.0 |

The paper-aligned MMLU-Pro and GPQA counts follow the automatic MAS search protocol in *Grammar
Search for Multi-Agent Systems* (ACL 2026): a 160-question search/development pool and respectively
500 MMLU-Pro or all 198 GPQA Diamond final-test questions. This project divides the 160 development
questions into 112 optimization and 48 held-out validation questions as an additional quality gate.
MuSR has no published MAS-search split; its full 756 question instances are stratified into the same
160-question development pool and 596-question final test.

The Quick Test profile is intentionally a **pilot**, not the thesis final evaluation. Its 40 + 20 +
100 cases partition the same 160-case development pool used by the paper-aligned profile, while every
paper-aligned final-test case is disjoint from all Quick Test cases. This lets the quick profile be run
repeatedly without leaking answers from the final evaluation.

Sources:

- <https://github.com/TIGER-AI-Lab/MMLU-Pro>
- <https://github.com/Zayne-sprague/MuSR>
- <https://github.com/idavidrein/gpqa>
- <https://aclanthology.org/2026.acl-long.75/>

The generated browser assets contain questions and answer keys only. Explanations, chain-of-thought
and annotator metadata are excluded.

Regenerate after obtaining the official source files:

```powershell
python benchmarks/scripts/build_public_benchmark_subsets.py `
  --mmlu-parquet path/to/mmlu-pro-test.parquet `
  --musr-root path/to/MuSR `
  --gpqa-main-csv path/to/gpqa_main.csv `
  --gpqa-diamond-csv path/to/gpqa_diamond.csv `
  --output-dir packages/ui/src/views/benchmark/datasets `
  --profile-output-dir packages/ui/public/benchmarks
```

Do not use final-test results to change prompts, pruning thresholds or Agentflow topology. Such a
change starts a new experiment and requires a new unseen final-test partition.
