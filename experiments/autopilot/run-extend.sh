#!/usr/bin/env bash
# Extension of run-all.sh: E2 on all six goals with three repetitions per
# strategy, then E3. Resumable: finished searches are skipped.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results
GOALS="support helpdesk travel hr_leave restaurant insurance"

for rep in 1 2 3; do
    for g in $GOALS; do
        for s in random greedy evidence_guided; do
            [ -f "$RES/$g/baseline.json" ] || continue
            [ -f "$RES/$g/search-$s-$rep.json" ] || $RUN search "$g" --strategy "$s" --rep "$rep" || echo "!! search failed: $g $s $rep"
        done
    done
done

[ -f "$RES/parallel/parallel.json" ] || node --no-warnings experiments/autopilot/parallel.mjs --reps 3 || echo "!! parallel failed"
echo "EXTEND DONE"
