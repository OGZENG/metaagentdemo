#!/usr/bin/env bash
# Evidence-guided v2 (checked selection) on all goals, three repetitions.
# Requires a Flowise server built from the commit that adds evidence_guided_v2.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results
for rep in 1 2 3; do
    for g in support helpdesk travel hr_leave restaurant insurance; do
        [ -f "$RES/$g/search-evidence_guided_v2-$rep.json" ] || $RUN search "$g" --strategy evidence_guided_v2 --rep "$rep" || echo "!! search failed: $g v2 $rep"
    done
done
echo "V2 DONE"
