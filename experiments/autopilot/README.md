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
| `node run.mjs search <goal> --strategy random\|greedy\|evidence_guided --rep N` | One complete crew search |
| `node parallel.mjs --reps 3` | E3: serial vs. parallel execution of a four-solver crew |
| `bash run-all.sh`, `bash run-extend.sh` | Full plan (resumable; finished steps are skipped) |
| `node summarize.mjs --tex <thesis>/AIRStudentThesis/tables` | Regenerate `results/summary.json` and the LaTeX tables |

Goals are defined in `goals.json`. All searches of a goal share its frozen design and the first
baseline repetition. For the random strategy, `--rep` is the seed.

Connection failures (Flowise down, network lost, machine asleep) abort the current run without
writing a result file instead of being recorded as crew failures; re-running the script resumes.

## Results

`results/<goal>/design.json`, `baseline.json` and `search-<strategy>-<rep>.json` contain every
reply, tool call, execution trace, assertion result and grader output. `results/parallel/parallel.json`
contains the E3 runs. `results/run-all.log` is the console log of the full run.
