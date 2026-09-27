#!/usr/bin/env bash
# E4: the repeated experiment on the validated test world (semantic phrase
# checks, judging at temperature 0, two measurements per case, pass-first
# selection with a minimum gain of one case). Strategies are interleaved so that
# they run in the same period. Usage: run-validated.sh <goal> [<goal> ...]
# (the thesis ran two streams in parallel: support travel restaurant /
# helpdesk hr_leave insurance). Resumable: finished steps are skipped.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results-validated
GOALS="$*"
for g in $GOALS; do
    [ -f "$RES/$g/baseline.json" ] || $RUN baseline "$g" --reps 3 --world validated || echo "!! baseline failed: $g"
done
for rep in 1 2 3; do
    for g in $GOALS; do
        for s in random evidence_guided_v2 regenerate; do
            [ -f "$RES/$g/search-$s-$rep.json" ] || $RUN search "$g" --strategy "$s" --rep "$rep" --world validated || echo "!! search failed: $g $s $rep"
        done
    done
done
for g in $GOALS; do
    $RUN confirm "$g" --reps 2 --world validated || echo "!! confirm failed: $g"
done
echo "VALIDATED DONE: $GOALS"
