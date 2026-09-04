#!/bin/sh
# Validate drills/batches/batch-NN.json with the expectations from
# batch-plan.json, using the anchors and every earlier validated batch as the
# library for slug clashes and the --names duplicate-check lists.
#   sh drills/validate_batch.sh 2
set -e
cd "$(dirname "$0")"
n="$1"; [ -n "$n" ] || { echo "usage: validate_batch.sh <batch number> [extra validator args]"; exit 2; }
shift
nn=$(printf '%02d' "$n")
plan=$(python3 -c "
import json,sys
for b in json.load(open('batch-plan.json')):
    if b['batch']==int(sys.argv[1]):
        print('--expect-count %d --expect-two-player %d --expect-small-space %s:%d %s' % (b['count'], b['n_two_player'], b['small_space'], b['n_small_space'], '--no-intensity-spread' if b.get('no_intensity_spread') else ''))
" "$n")
libs="--library anchors.json"
i=1
while [ "$i" -lt "$n" ]; do
  f=$(printf 'batches/batch-%02d.validated.json' "$i")
  [ -f "$f" ] && libs="$libs --library $f"
  i=$((i+1))
done
# shellcheck disable=SC2086
python3 validate_drills.py "batches/batch-$nn.json" $plan $libs "$@"
