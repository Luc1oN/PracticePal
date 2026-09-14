#!/usr/bin/env python3
"""Fix the six court diagrams Shane rejected. Each note described a real
sequencing error: a ball landing on the wrong side, balls leaving before the
previous shot was played, a returner charging a serve, a volley never struck."""
import json, os, glob

FIXES = {
  # Zones drill: the third ball landed at y=0.6, which is the hitter's OWN
  # side of the net. Send it deep into the far court instead (a different
  # zone from the short ball in step 1, which is the point of the drill).
  'call-your-zone-rally': [
    {"from": "P1", "to": [0.5, 0.35], "style": "ball", "step": 1},
    {"from": "P2", "to": [0.5, 0.35], "style": "movement", "step": 1},
    {"from": "P2", "to": [0.5, 0.92], "style": "ball", "step": 2},
    {"from": "P2", "to": "P2", "style": "movement", "step": 3},
    {"from": "P1", "to": [0.5, 0.06], "style": "ball", "step": 4},
  ],
  # P2 was shown sprinting to a far corner at the same moment as striking the
  # ball. They already moved to the ball in step 1; drop the stray run.
  'deep-ball-denial-points': [
    {"from": "P1", "to": [0.3, 0.1], "style": "ball", "step": 1},
    {"from": "P2", "to": [0.3, 0.1], "style": "movement", "step": 1},
    {"from": "P2", "to": [0.7, 0.9], "style": "ball", "step": 2},
    {"from": "P1", "to": [0.7, 0.9], "style": "movement", "step": 2},
    {"from": "P1", "to": [0.2, 0.08], "style": "ball", "step": 3},
  ],
  # The next ball was fired while P1 was still recovering, so it arrived at
  # empty court. Recovery gets its own step; the ball follows, with P1
  # tracking across to meet it.
  'inside-out-runaround-rally': [
    {"from": "P2", "to": [0.26, 0.9], "style": "ball", "step": 1},
    {"from": "P1", "to": [0.2, 0.96], "style": "movement", "step": 1},
    {"from": "P1", "to": [0.72, 0.1], "style": "ball", "step": 2},
    {"from": "P1", "to": [0.42, 0.95], "style": "movement", "step": 3},
    {"from": "P2", "to": [0.26, 0.9], "style": "ball", "step": 4},
    {"from": "P1", "to": [0.24, 0.93], "style": "movement", "step": 4},
  ],
  # Same fault: the second lob left while P1 was still walking back in. Give
  # the recovery its own step, then lob with P1 dropping back to meet it.
  'lob-and-overhead-loop': [
    {"from": "P2", "to": [0.5, 0.82], "style": "ball", "step": 1},
    {"from": "P1", "to": [0.5, 0.82], "style": "movement", "step": 1},
    {"from": "P1", "to": [0.45, 0.1], "style": "ball", "step": 2},
    {"from": "P1", "to": "P1", "style": "movement", "step": 3},
    {"from": "P2", "to": [0.5, 0.82], "style": "ball", "step": 4},
    {"from": "P1", "to": [0.5, 0.82], "style": "movement", "step": 4},
  ],
  # The returner was shown charging in to meet the serve, which reads as a
  # SABR. This drill is about returning from the baseline: stand, return,
  # then recover to the middle.
  'return-beyond-the-line': [
    {"from": "P1", "to": [0.38, 0.3], "style": "ball", "step": 1},
    {"from": "P2", "to": [0.7, 0.92], "style": "ball", "step": 2},
    {"from": "P2", "to": [0.5, 0.06], "style": "movement", "step": 3},
  ],
  # The passing shot was played and nothing answered it. The whole point of
  # the drill is the volley, so P1 now moves to it and puts it away.
  'short-ball-approach-and-close': [
    {"from": "P2", "to": [0.6, 0.68], "style": "ball", "step": 1},
    {"from": "P1", "to": [0.62, 0.72], "style": "movement", "step": 1},
    {"from": "P1", "to": [0.85, 0.08], "style": "ball", "step": 2},
    {"from": "P1", "to": [0.66, 0.6], "style": "movement", "step": 2},
    {"from": "P2", "to": [0.85, 0.08], "style": "movement", "step": 2},
    {"from": "P2", "to": [0.3, 0.62], "style": "ball", "step": 3},
    {"from": "P1", "to": [0.32, 0.6], "style": "movement", "step": 4},
    {"from": "P1", "to": [0.18, 0.12], "style": "ball", "step": 5},
  ],
}

patched = {}
for path in sorted(glob.glob('batches/batch-2[345].json')):
    drills = json.load(open(path))
    changed = False
    for d in drills:
        if d['slug'] in FIXES:
            d['court_diagram']['paths'] = FIXES[d['slug']]
            patched[d['slug']] = (path, d['court_diagram'])
            changed = True
    if changed:
        json.dump(drills, open(path, 'w'), indent=1, ensure_ascii=False)
        print('patched', path)

missing = set(FIXES) - set(patched)
assert not missing, f'not found in batch files: {missing}'
json.dump({k: v[1] for k, v in patched.items()}, open(os.environ['SCRATCH'] + '/fixed_diagrams.json', 'w'))
print('all six patched')
