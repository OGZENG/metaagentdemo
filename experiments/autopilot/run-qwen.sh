#!/usr/bin/env bash
# E5 protocol on the self-hosted Qwen model (model-qwen.json, reached through
# an SSH tunnel to the lab server): the frozen designs of the repaired world,
# Qwen for every role including the grader. Results in results-repaired-qwen/.
# Usage: run-qwen.sh <goal> [<goal> ...]. Resumable: finished steps are skipped.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
OPTS="--world repaired --model qwen"
RES="experiments/autopilot/results-repaired-qwen"
GOALS="$*"
for g in $GOALS; do
    [ -f "$RES/$g/baseline.json" ] || $RUN baseline "$g" --reps 3 $OPTS || echo "!! baseline failed: $g"
done
for rep in 1 2 3; do
    for g in $GOALS; do
        for s in random evidence_guided_v2 regenerate; do
            [ -f "$RES/$g/search-$s-$rep.json" ] || $RUN search "$g" --strategy "$s" --rep "$rep" $OPTS || echo "!! search failed: $g $s $rep"
        done
    done
done
for g in $GOALS; do
    $RUN confirm "$g" --reps 2 $OPTS || echo "!! confirm failed: $g"
done
echo "qwen DONE: $GOALS"
