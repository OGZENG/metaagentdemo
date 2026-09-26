#!/usr/bin/env bash
# Everything that needs the restarted server (evidence_guided_v2), in order:
# v2 searches, the contemporaneous v1 control, then E2b confirmation runs.
set -u
cd "$(dirname "$0")/../.."
bash experiments/autopilot/run-extend.sh   # fills in files removed by audit.mjs
bash experiments/autopilot/run-v2.sh
bash experiments/autopilot/run-v1-control.sh
for g in support helpdesk travel hr_leave restaurant insurance; do
    node --no-warnings experiments/autopilot/run.mjs confirm "$g" --reps 2 || echo "!! confirm failed: $g"
done
node --no-warnings experiments/autopilot/audit.mjs
echo "AFTER RESTART DONE"
