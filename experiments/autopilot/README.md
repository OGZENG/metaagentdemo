# Workflow Autopilot experiments

Headless harness for the evaluation chapter of the thesis *Workflow Autopilot: Automated Design and
Optimization of Multi-Agent LLM Workflows*. It drives a running Flowise instance through the same
endpoints as the studio and imports the studio's decision rules from
`packages/ui/src/views/metaagent/studioUtils.js`, so a headless run makes the same decisions as the UI.

## Setup

1. Start Flowise from this repository (`node packages/server/bin/run start`, port 3000).
2. Create an API key in Flowise (API Keys, all permissions) and put it into `experiments/autopilot/.env`:

   ```
   FLOWISE_API_KEY=...
   ```

   `.env` is git-ignored and the key is never printed or stored in results.
3. `model.json` holds the chat model configuration used for every role (the studio's model picker
   object: `chatOpenAI`, `gpt-5.4-mini`, temperature 0.9, credential id of the Flowise credential).

## Running

| Command | Purpose |
|---|---|
| `node run.mjs design <goal>` | Generate and freeze the design (contract, test world, crew) |
| `node run.mjs baseline <goal> --reps 3` | Compile the baseline once, measure it on dev + test |
| `node run.mjs search <goal> --strategy random\|greedy\|evidence_guided\|evidence_guided_v2\|regenerate --rep N` | One complete crew search (`regenerate` is the baseline without operators) |
| `node run.mjs confirm <goal> --reps 2` | Re-measure every crew a search recommended, next to the baseline |
| `node parallel.mjs --reps 3 --out parallel-checked.json` | E3: serial vs. parallel execution of a four-solver crew, with answer checks |
| `bash run-all.sh`, `run-extend.sh`, `run-v2.sh`, `run-regenerate.sh` | Full plan (resumable; finished steps are skipped) |
| `node summarize.mjs --tex <thesis>/AIRStudentThesis/tables` | Regenerate `results/summary.json` and the LaTeX tables |
| `node sensitivity.mjs --tex <dir>` | Re-score all evaluations under other assertion weights and thresholds |
| `node analysis.mjs --tex <dir>` | Offline re-selection under both selection rules, Fisher tests, robustness of the strategy comparison |
| `node audit-assertions.mjs sample` / `report --tex <dir>` | Draw the audit sample of failed assertions / summarize the manual labels |

The searches are run with the earlier `cost_first` selection rule (`DEFAULT_SETTINGS.selectionRule`
in `lib/runner.mjs`), so that all strategies are comparable; `analysis.mjs` re-selects every search
under the `pass_first` rule that is now the studio default.

Goals are defined in `goals.json`. All searches of a goal share its frozen design and the first
baseline repetition. For the random strategy, `--rep` is the seed.

Connection failures (Flowise down, network lost, machine asleep) abort the current run without
writing a result file instead of being recorded as crew failures; re-running the script resumes.

## Results

`results/<goal>/design.json`, `baseline.json` and `search-<strategy>-<rep>.json` contain every
reply, tool call, execution trace, assertion result and grader output; `confirm-*.json` the
re-measurements. `results/parallel/parallel-checked.json` contains the E3 runs with stored answers
(`parallel.json` is an earlier run that recorded latency only). `assertion-audit-sample.json` and
`assertion-audit-labels.json` hold the audited failed assertions with their labels and reasons.
`online/deployment-support.json` is the record of the deployment used in the online case study
(credential ids removed). The console logs of the runs (`results/*.log`) are git-ignored.

## Repeated experiment on the validated test world (E4)

| Command | Purpose |
|---|---|
| `node run.mjs validate <goal> --world validated` | Validate the frozen design of `results/<goal>` once and freeze it in `results-validated/<goal>` |
| `node rescore.mjs` | Re-score the recorded original baseline replies with the validated world and semantic phrase checks |
| `bash run-validated.sh <goal> ...` | Baselines, interleaved searches (random, evidence_guided_v2, regenerate) and re-measurement with `VALIDATED_SETTINGS` |
| `node summarize-validated.mjs --tex <dir>` | Tables `e4_*` of the thesis |
| `node audit-assertions.mjs sample\|report --results results-validated` | Second assertion audit |

A first run of E4 used an ambiguous fact-check field (`holds`) and was discarded before
analysis; it is kept locally in `results-validated-discarded/` (git-ignored).

## Repeated experiment on the repaired environment (E5)

| Command | Purpose |
|---|---|
| `node run.mjs prepare <goal> --world repaired [--heldout 8]` | Extend the held-out suite, repair the environment (add fixtures for unanswered required tools) and validate; freezes `results-repaired/<goal>/design.json` |
| `WORLD=repaired bash run-validated.sh <goal> ...` | Same protocol as E4 on the repaired world |
| `node summarize-validated.mjs --world repaired --tex <dir>` | Tables `e5_*` of the thesis (compared with E4) |

Three searches were aborted by infrastructure failures and rerun. A further attempt of
`support/search-evidence_guided_v2-2` was started by mistake after the valid rerun (the
v2 selector had abstained in both rounds, a legitimate outcome); it is kept locally in
`results-repaired-discarded/` (git-ignored) and excluded from the analysis.
