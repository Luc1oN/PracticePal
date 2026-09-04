# PracticePal — Drill Batch Generation Prompt

Use one batch per session. Fill the `{{...}}` slots, paste the anchors, run it,
then put the output through `validate_drills.py` before you read a word of it:

    python3 drills/validate_drills.py drills/batches/batch-01.json \
        --expect-count 8 --expect-two-player 4 --expect-small-space service_boxes:4

The validator drops any drill that breaks a rejection rule, writes the survivors
to `batch-01.validated.json`, and prints the name/summary list you need for the
duplicate check. Then open `diagram-review.html`, load the validated file, and
judge each diagram against its setup text. Everything generated lands with
`is_vetted = false`. Nothing reaches the composition function until you flip
that flag yourself.

The COURT DIAGRAM section below is written against `court-diagram.js`: what it
asks for is exactly what the renderer draws and animates. If the renderer
changes, change that section with it.

---

## The prompt

```
You are an experienced tennis coach writing drills for a coaching session
library. These drills will be used by real coaches with real players, so
accuracy matters more than volume. A drill that sounds plausible but does not
work on court is worse than no drill at all.

## THIS BATCH

Generate exactly {{count}} drills meeting ALL of the following:
- Skill focus: {{skill_focus}}
- Level: {{level}}
- Age group(s): {{age_groups}}

Coverage requirements within this batch:
- At least {{n_two_player}} drills workable with exactly 2 players
- At least {{n_small_space}} drills requiring only {{small_space}}
- Spread across all three intensity values (low, medium, high)
- No two drills may share the same court setup
- No two drills may be variations of the same underlying exercise

## SCHEMA

Each drill must populate these fields exactly. Enum values are closed sets -
never invent a value outside them.

skill_focus  (array): forehand | backhand | serve | return | volley | overhead |
                      movement | tactical | conditioning | warmup | cooldown | games
levels       (array): beginner | improver | intermediate | advanced
age_groups   (array): mini_red | mini_orange | mini_green | junior | adult
court_space  (single): full_court | half_court | service_boxes |
                       cross_court_channel | baseline_only | net_area | off_court
intensity    (single): low | medium | high

slug             text, kebab-case, unique, derived from the name
name             text, specific and descriptive - not "Forehand Drill 3"
summary          one sentence, what the drill develops
players_min      smallint, >= 1
players_max      smallint, >= players_min
duration_min     smallint, minutes
duration_max     smallint, >= duration_min
equipment        array of strings, lowercase, e.g. cones, ball basket, throwdowns, targets
setup            text, how the court is laid out - specific enough to replicate
instructions     array of ordered steps
coaching_points  array of 3-5 cues
progressions     array of 2-4 specific ways to increase difficulty
regressions      array of 2-4 specific ways to decrease difficulty
court_diagram    JSON, see below (null only for off_court drills)
source           text, leave as "generated"

## QUALITY RULES - THESE ARE REJECTION CRITERIA

1. COACHING POINTS MUST BE CUES, NOT ENCOURAGEMENT.
   Rejected: "Focus on good technique." / "Stay positive." / "Watch the ball."
   Accepted: "Racket back before the ball crosses the net."
             "Contact point out in front, level with the front hip."
             "Split step as the feeder makes contact, not after."
   Each point must be something a coach says out loud, mid-drill, that changes
   what the player does in the next five seconds.

2. PROGRESSIONS AND REGRESSIONS MUST BE SPECIFIC MECHANISMS.
   Rejected: "Make it harder." / "Increase the difficulty." / "Simplify."
   Accepted: "Shrink the target zone from two metres to one."
             "Switch from a green ball to a yellow ball."
             "Feeder adds a disguised change of direction every fourth ball."
             "Allow one non-counting recovery ball after each error."
   Each must change exactly one variable: space, ball, tempo, constraint,
   target size, or decision load.

3. PLAYER COUNT MUST BE INTERNALLY CONSISTENT.
   If instructions describe a feeder and two workers rotating, players_min
   cannot be 2. Re-read the instructions and set the range to match what the
   drill actually requires. The diagram must show a player count inside that
   range.

4. DURATION MUST BE REALISTIC.
   A technical drill with rotation needs 8+ minutes to be worth setting up.
   A warm-up rarely exceeds 10. Do not pad ranges to look flexible.

5. SETUP MUST BE REPLICABLE.
   A coach reading only the setup field should be able to lay out the court
   without seeing the instructions. Give distances and cone positions, and
   say which side of the net everyone starts on.

6. NO INVENTED EQUIPMENT.
   Only equipment a normal club coach has: cones, throwdowns, ball basket,
   targets, hoops, lines, ball machine, resistance band, agility ladder.

## COURT DIAGRAM

The diagram is drawn AND ANIMATED by the app: balls fly along ball and feed
paths, and the player markers themselves run along movement paths, one step
after another, on a loop. Write it so one loop shows one cycle of the drill:
who feeds, who runs where, who hits, where the ball goes, who recovers.
A coach will judge the diagram beside the setup text; if they disagree, the
drill is rejected.

{
  "court": "full" | "half",
  "players":   [ { "id": "P1", "x": 0.22, "y": 0.92, "label": "Hitter" } ],
  "equipment": [ { "type": "cone", "x": 0.15, "y": 0.72 } ],
  "paths": [
    { "from": "F",  "to": "P1",          "style": "feed",     "step": 1 },
    { "from": "P1", "to": [0.82, 0.86],  "style": "movement", "step": 1 },
    { "from": "P1", "to": [0.25, 0.45],  "style": "ball",     "step": 2 },
    { "from": "P1", "to": "P1",          "style": "movement", "step": 3 }
  ]
}

Coordinates are normalised to the DOUBLES court, in full-court space:
- (0,0) is the far-left corner, (1,1) the near-right corner. Net at y = 0.5.
- Baselines y = 0 (far) and y = 1 (near). Service lines y = 0.231 and y = 0.769.
- Doubles sidelines x = 0 and x = 1. Singles sidelines x = 0.125 and x = 0.875.
- Centre line and centre marks at x = 0.5.
- For the near player (y > 0.5) the deuce court is x > 0.5 and the ad court is
  x < 0.5; for the far player it is mirrored.
- 1 metre is about 0.042 in y and 0.091 in x. "Two metres inside the singles
  sideline" is x ≈ 0.31 or 0.69; "a metre behind the baseline" is y ≈ 1.04.
- Typical spots for a near-side player: on the baseline y ≈ 0.95, on the
  service line y ≈ 0.77, at the net y ≈ 0.58, mid-court y ≈ 0.85.
- Positions outside 0-1 are allowed and are how you show people off the
  court: a queue behind the baseline at y ≈ 1.06, or beside it at x ≈ 1.1.
  Never squeeze a queue onto the court.

court:
- "half" when everything that matters is on the near side (y 0.5 to 1.0):
  only the near half is drawn, net at the top. Keep full-court coordinates.
  A ball hit over the net just ends past it, e.g. [0.7, 0.45]; a feeder
  standing across the net goes at y ≈ 0.45.
- "full" for full_court drills, for any drill with a live player on the far
  side, and whenever there are targets or gates on the far side to show.
- off_court: set court_diagram to null.

players: short unique ids (P1, P2, F, C). Label the feeder "Feeder" or the
coach "Coach" - those words switch the marker to the feeder colour. Other
labels are optional and short ("Hitter", "Server", "Queue"). Show the drill at
players_min unless the setup needs more (a queue, a doubles pair); the count
must sit inside players_min..players_max.

equipment types the renderer knows: cone, target (or hoop), throwdown (or
line), ball basket, ball machine, agility ladder (use "rotate": 90 to lay it
along a sideline). Anything else is drawn as a plain square.
Put the basket beside the feeder; a machine feeds with a "feed" path from its
own [x, y]. Cones and targets go where the setup says they go.

paths, in the order the drill happens. Each path is one step; paths that
happen at the same moment share a "step" number (the feed and the hitter's
run are usually both step 1). Three styles only:
- ball: a struck ball. from = the striker (or the [x, y] where it is struck);
  to = the receiving player, or the [x, y] where it lands. On a "half"
  diagram a ball that goes over the net ends just past it, e.g. [0.7, 0.45].
- feed: a hand-fed or tossed ball. from = the feeder; to = the player or the
  [x, y] spot it is fed to.
- movement: a player running. from = the player id (wherever they are at that
  point in the sequence) or the [x, y] they are standing on; to = an [x, y]
  spot, or a player id meaning that player's STARTING spot. Send a player home
  after a run with { "from": "P1", "to": "P1", "style": "movement" }.
Rules: 3 to 8 paths showing ONE cycle, not every repetition. Every id used in
a path must exist in players. No path may start and end on the same spot.
A ball hit by a player who has run somewhere leaves from where they ran to -
just write "from": "P1".

## STYLE ANCHORS

Match the specificity and voice of these existing vetted drills. These are the
standard, not the ceiling.

{{paste 2-3 full vetted drill records here as JSON — drills/anchors.json to start}}

## OUTPUT

Return only a JSON array of drill objects. No markdown fences, no preamble, no
commentary. Set "source": "generated" on every drill.
Do not include is_vetted - it defaults to false.
```

---

## Slot values by batch

Fill these per run. Suggested batch plan:

| Batch | skill_focus | level | count | n_two_player | small_space |
|---|---|---|---|---|---|
| 1 | forehand, backhand | beginner | 8 | 4 | service_boxes |
| 2 | forehand, backhand | improver | 8 | 4 | cross_court_channel |
| 3 | forehand, backhand | intermediate | 8 | 3 | cross_court_channel |
| 4 | forehand, backhand | advanced | 8 | 3 | half_court |
| 5 | serve, return | beginner | 8 | 4 | service_boxes |
| 6 | serve, return | improver | 8 | 4 | baseline_only |
| 7 | serve, return | intermediate | 8 | 3 | half_court |
| 8 | serve, return | advanced | 8 | 3 | half_court |
| 9 | volley, overhead | beginner | 8 | 4 | net_area |
| 10 | volley, overhead | improver | 8 | 4 | service_boxes |
| 11 | volley, overhead | intermediate | 8 | 3 | net_area |
| 12 | movement | beginner | 6 | 4 | half_court |
| 13 | movement | improver | 6 | 4 | baseline_only |
| 14 | movement | intermediate | 6 | 3 | full_court |
| 15 | movement | advanced | 6 | 3 | full_court |
| 16 | tactical | improver | 6 | 4 | full_court |
| 17 | tactical | intermediate | 8 | 4 | full_court |
| 18 | tactical | advanced | 8 | 4 | full_court |
| 19 | warmup | all levels | 8 | 4 | off_court |
| 20 | cooldown | all levels | 4 | 4 | off_court |
| 21 | games | beginner, improver | 8 | 4 | half_court |
| 22 | games | intermediate, advanced | 8 | 4 | full_court |

Running total: ~160 generated, target ~120 surviving review. Stop when coverage
is complete rather than when the table is exhausted.

Every batch's `n_small_space` counts drills whose `court_space` equals the
`small_space` value exactly; the validator checks this with
`--expect-small-space <space>:<n>`. `drills/batch-plan.json` holds these
numbers per batch and `drills/validate_batch.sh <n>` runs the validator with
them, using the anchors and every earlier validated batch as the library.
Batch 20 (cooldowns) is validated with `--no-intensity-spread`.

---

## Duplicate check (pass 2)

After each batch validates cleanly, run this against the accumulated library.
`validate_drills.py --names` prints both lists in the right shape.

```
Here are the names and summaries of drills already in the library:
{{existing_names_and_summaries}}

Here are the new drills from this batch:
{{new_names_and_summaries}}

Identify any new drill that is substantially the same exercise as an existing
one, even if named differently. Judge by the underlying mechanism - what the
player actually does - not by wording.

Return a JSON array: [{ "new_slug": string, "duplicate_of": string,
"reason": string }]. Return an empty array if there are none.
```

Delete the duplicates before you spend review time on them.

---

## Review (pass 3)

Open `diagram-review.html`, load the validated batch, and for each drill judge
whether the animated diagram shows the same drill as the setup and
instructions. `Diagram OK` / `Diagram wrong` write `diagram_ok` onto the
drill; export the annotated file. Only drills with `diagram_ok: true` get
`is_vetted` flipped, by hand, when they are loaded into the table.
