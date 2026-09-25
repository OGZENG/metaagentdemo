#!/usr/bin/env bash
# Contemporaneous control: evidence_guided (v1) re-run once per goal in the
# same time window as the v2 runs, to separate the v2 effect from provider drift.
set -u
cd "$(dirname "$0")/../.."
RUN="node --no-warnings experiments/autopilot/run.mjs"
RES=experiments/autopilot/results
for g in support helpdesk travel hr_leave restaurant insurance; do
    [ -f "$RES/$g/search-evidence_guided-4.json" ] || $RUN search "$g" --strategy evidence_guided --rep 4 || echo "!! search failed: $g v1 control"
done
echo "V1 CONTROL DONE"
