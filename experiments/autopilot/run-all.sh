#!/usr/bin/env bash
# Full experiment plan for thesis chapter 6. Resumable: finished steps are skipped.
#   E1: design + 3 baseline repetitions for all goals
#   E2: 3 goals x 3 strategies x 2 repetitions
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results
GOALS="support helpdesk travel hr_leave restaurant insurance"
SEARCH_GOALS="support helpdesk hr_leave"

for g in $GOALS; do
    [ -f "$RES/$g/design.json" ] || $RUN design "$g" || echo "!! design failed: $g"
    [ -f "$RES/$g/design.json" ] && { [ -f "$RES/$g/baseline.json" ] || $RUN baseline "$g" --reps 3 || echo "!! baseline failed: $g"; }
done

for rep in 1 2; do
    for g in $SEARCH_GOALS; do
        for s in random greedy evidence_guided; do
            [ -f "$RES/$g/baseline.json" ] || continue
            [ -f "$RES/$g/search-$s-$rep.json" ] || $RUN search "$g" --strategy "$s" --rep "$rep" || echo "!! search failed: $g $s $rep"
        done
    done
done
echo "ALL DONE"
