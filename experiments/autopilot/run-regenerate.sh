#!/usr/bin/env bash
# Baseline strategy without operators: regenerate the whole crew from failure
# evidence (same budget: two rounds, three candidates), then E3 with answer checks.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results
for rep in 1 2 3; do
    for g in support helpdesk travel hr_leave restaurant insurance; do
        [ -f "$RES/$g/search-regenerate-$rep.json" ] || $RUN search "$g" --strategy regenerate --rep "$rep" || echo "!! search failed: $g regenerate $rep"
    done
done
for g in support helpdesk travel hr_leave restaurant insurance; do
    $RUN confirm "$g" --reps 2 || echo "!! confirm failed: $g"
done
[ -f "$RES/parallel/parallel-checked.json" ] || node --no-warnings experiments/autopilot/parallel.mjs --reps 3 --out parallel-checked.json
echo "REGENERATE DONE"
