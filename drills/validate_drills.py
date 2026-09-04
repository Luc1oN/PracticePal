#!/usr/bin/env python3
"""
validate_drills.py — gatekeeper for generated PracticePal drills.

    python3 validate_drills.py batch.json [--out batch.validated.json]
        [--expect-count 8] [--expect-two-player 4]
        [--expect-small-space service_boxes:4] [--library library.json ...]
        [--names] [--keep-flags]

Reads a JSON array of drills (or raw model output with fences/preamble around
the array), checks every drill against the schema and the rejection rules in
GENERATION-PROMPT.md, and mirrors the diagram rules that court-diagram.js
applies so a diagram that would render wrong is caught before anyone reviews
it. Drills with ERRORS are dropped from the output file; WARNINGS are kept
and listed. Exit code is 1 when anything was dropped or a batch-level
expectation failed.

--names prints "slug — name: summary" lines for the duplicate-check prompt
(library first, then the new batch). --library may be given several times.
--keep-flags leaves source/is_vetted as written (for anchors), otherwise
source is forced to "generated" and is_vetted is stripped.

Standard library only.
"""
import argparse
import json
import re
import sys
from collections import Counter

SKILL_FOCUS = {'forehand', 'backhand', 'serve', 'return', 'volley', 'overhead',
               'movement', 'tactical', 'conditioning', 'warmup', 'cooldown', 'games'}
LEVELS = {'beginner', 'improver', 'intermediate', 'advanced'}
AGE_GROUPS = {'mini_red', 'mini_orange', 'mini_green', 'junior', 'adult'}
COURT_SPACE = {'full_court', 'half_court', 'service_boxes', 'cross_court_channel',
               'baseline_only', 'net_area', 'off_court'}
INTENSITY = {'low', 'medium', 'high'}
PATH_STYLES = {'ball', 'feed', 'movement'}
KNOWN_EQUIPMENT_TYPES = {'cone', 'target', 'hoop', 'throwdown', 'line', 'ball basket', 'basket', 'machine', 'ladder'}

# Rule 6: the closed set of club equipment, with the spellings people use.
EQUIPMENT_ALIASES = {
    'cone': 'cones', 'cones': 'cones',
    'throwdown': 'throwdowns', 'throwdowns': 'throwdowns', 'throwdown lines': 'throwdowns',
    'throw-down lines': 'throwdowns', 'throw down lines': 'throwdowns', 'flat markers': 'throwdowns',
    'ball basket': 'ball basket', 'basket': 'ball basket', 'basket of balls': 'ball basket',
    'ball hopper': 'ball basket', 'hopper': 'ball basket', 'ball cart': 'ball basket',
    'target': 'targets', 'targets': 'targets', 'target zones': 'targets',
    'hoop': 'hoops', 'hoops': 'hoops',
    'line': 'lines', 'lines': 'lines', 'court lines': 'lines',
    'ball machine': 'ball machine',
    'resistance band': 'resistance band', 'resistance bands': 'resistance band',
    'agility ladder': 'agility ladder', 'ladder': 'agility ladder',
    # always-there basics: allowed, not "equipment" in the rule's sense
    'balls': 'balls', 'tennis balls': 'balls', 'ball': 'balls',
    'red balls': 'balls', 'orange balls': 'balls', 'green balls': 'balls', 'yellow balls': 'balls',
    'rackets': 'rackets', 'racket': 'rackets', 'racquets': 'rackets',
    'net': 'net', 'mini net': 'mini net',
}

BANNED_CUES = [
    r'\bfocus on\b', r'\bstay positive\b', r'\bwatch the ball\b', r'\bgood technique\b',
    r'\bconcentrate\b', r'\bdo your best\b', r'\bkeep going\b', r'\bstay focused\b',
    r'\bhave fun\b', r'\bwell done\b', r'\bbe confident\b', r'\btry hard\b',
]
BANNED_PROGRESSION = [
    r'^\s*make it (harder|easier|more difficult|simpler)\.?\s*$',
    r'^\s*(increase|decrease|reduce) (the )?difficulty\.?\s*$',
    r'^\s*simplify\.?\s*$',
    r'\bmake it (harder|easier)\b\.?$',
    r'^\s*(add|remove) (a )?(challenge|pressure)\.?\s*$',
]
GENERIC_NAME = re.compile(r'\b(drill|exercise)\s*#?\d+\s*$', re.I)
SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
NUMBER_WORDS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8}


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)


# ── Loading ────────────────────────────────────────────────────────────────
def load_array(path):
    """Accepts a clean JSON array or model output with fences/preamble."""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        stripped = re.sub(r'^\s*```(?:json)?\s*|\s*```\s*$', '', text.strip(), flags=re.I)
        start, end = stripped.find('['), stripped.rfind(']')
        if start < 0 or end < 0:
            sys.exit('%s: no JSON array found' % path)
        try:
            data = json.loads(stripped[start:end + 1])
        except json.JSONDecodeError as e:
            sys.exit('%s: could not parse JSON array (%s)' % (path, e))
    if isinstance(data, dict):
        data = data.get('drills') or data.get('data') or [data]
    if not isinstance(data, list):
        sys.exit('%s: expected a JSON array of drills' % path)
    return data


# ── Field checks ───────────────────────────────────────────────────────────
def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_enum_array(d, key, allowed, rep, min_len=1):
    v = d.get(key)
    if not isinstance(v, list) or len(v) < min_len:
        rep.error('%s must be a non-empty array' % key)
        return
    for item in v:
        if item not in allowed:
            rep.error('%s contains "%s", not one of %s' % (key, item, sorted(allowed)))


def check_enum(d, key, allowed, rep):
    v = d.get(key)
    if v not in allowed:
        rep.error('%s is "%s", not one of %s' % (key, v, sorted(allowed)))


def check_text(d, key, rep, min_words=1):
    v = d.get(key)
    if not isinstance(v, str) or len(v.split()) < min_words:
        rep.error('%s must be text (at least %d word%s)' % (key, min_words, '' if min_words == 1 else 's'))
        return False
    return True


def check_text_array(d, key, rep, lo, hi, label=None):
    v = d.get(key)
    label = label or key
    if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
        rep.error('%s must be an array of non-empty strings' % label)
        return []
    if not (lo <= len(v) <= hi):
        rep.error('%s has %d items, expected %d-%d' % (label, len(v), lo, hi))
    return v


def normalise_equipment(items, rep):
    out = []
    for raw in items:
        key = raw.strip().lower()
        if key != raw:
            rep.warn('equipment "%s" should be lowercase and trimmed' % raw)
        mapped = EQUIPMENT_ALIASES.get(key)
        if not mapped:
            rep.error('equipment "%s" is not on the allowed club list (rule 6)' % raw)
            continue
        out.append(mapped)
    return out


# ── Drill-level checks ─────────────────────────────────────────────────────
def check_drill(d, rep):
    for key in ('slug', 'name', 'summary', 'setup'):
        check_text(d, key, rep, min_words=1)
    slug = d.get('slug')
    if isinstance(slug, str) and not SLUG_RE.match(slug):
        rep.error('slug "%s" is not kebab-case' % slug)
    name = d.get('name')
    if isinstance(name, str) and GENERIC_NAME.search(name):
        rep.error('name "%s" is generic (rule: no "Forehand Drill 3")' % name)
    summary = d.get('summary')
    if isinstance(summary, str) and len(re.findall(r'[.!?](\s|$)', summary.strip())) > 1:
        rep.warn('summary should be one sentence')
    setup = d.get('setup')
    if isinstance(setup, str) and len(setup.split()) < 15:
        rep.error('setup is too thin to replicate the court (rule 5): give distances and positions')

    check_enum_array(d, 'skill_focus', SKILL_FOCUS, rep)
    check_enum_array(d, 'levels', LEVELS, rep)
    check_enum_array(d, 'age_groups', AGE_GROUPS, rep)
    check_enum(d, 'court_space', COURT_SPACE, rep)
    check_enum(d, 'intensity', INTENSITY, rep)

    pmin, pmax = d.get('players_min'), d.get('players_max')
    if not is_int(pmin) or pmin < 1:
        rep.error('players_min must be an integer >= 1')
    if not is_int(pmax) or (is_int(pmin) and pmax < pmin):
        rep.error('players_max must be an integer >= players_min')
    dmin, dmax = d.get('duration_min'), d.get('duration_max')
    if not is_int(dmin) or dmin < 1:
        rep.error('duration_min must be an integer >= 1 (minutes)')
    if not is_int(dmax) or (is_int(dmin) and dmax < dmin):
        rep.error('duration_max must be an integer >= duration_min')
    if is_int(dmin) and is_int(dmax) and dmax > dmin * 3:
        rep.warn('duration range %d-%d looks padded (rule 4)' % (dmin, dmax))

    eq = d.get('equipment')
    if not isinstance(eq, list) or not all(isinstance(x, str) for x in eq):
        rep.error('equipment must be an array of strings')
    else:
        d['equipment'] = normalise_equipment(eq, rep)

    steps = check_text_array(d, 'instructions', rep, 2, 12)
    cues = check_text_array(d, 'coaching_points', rep, 3, 5)
    prog = check_text_array(d, 'progressions', rep, 2, 4)
    reg = check_text_array(d, 'regressions', rep, 2, 4)

    for cue in cues:
        low = cue.lower()
        if any(re.search(p, low) for p in BANNED_CUES):
            rep.error('coaching point is encouragement, not a cue (rule 1): "%s"' % cue)
        elif len(cue.split()) < 4:
            rep.warn('coaching point is very short for a cue: "%s"' % cue)
    for label, items in (('progression', prog), ('regression', reg)):
        for item in items:
            low = item.lower()
            if any(re.search(p, low) for p in BANNED_PROGRESSION):
                rep.error('%s is not a specific mechanism (rule 2): "%s"' % (label, item))
            elif len(item.split()) < 4:
                rep.warn('%s is very short to be a mechanism: "%s"' % (label, item))

    # Rule 3 heuristics: what the text implies about the player count.
    text = ' '.join([str(setup or '')] + [str(s) for s in steps]).lower()
    text = re.sub(r'\b(hip|trunk|thoracic|shoulder|external|internal|core|wrist) rotations?\b', '', text)
    if is_int(pmin):
        if re.search(r'\bfeeder\b|\bcoach feeds\b|\bfed by\b', text) and pmin < 2:
            rep.error('text describes a feeder but players_min is %d (rule 3)' % pmin)
        for word, n in NUMBER_WORDS.items():
            if re.search(r'\b%s (players|hitters|workers)\b' % word, text) and is_int(pmax) and n > pmax:
                rep.error('text mentions %s players but players_max is %d (rule 3)' % (word, pmax))
        if re.search(r'\bqueue\b|\brotate\b|\brotation\b|\bnext player\b', text) and is_int(pmax) and pmax < 3:
            rep.warn('text mentions a queue/rotation but players_max is %d' % pmax)
    # Rule 4 heuristics
    if is_int(dmin):
        focus = d.get('skill_focus') or []
        if re.search(r'\brotate\b|\brotation\b', text) and dmin < 8 and 'warmup' not in focus:
            rep.warn('drill rotates players but duration_min is %d (rule 4 says 8+)' % dmin)
        if 'warmup' in focus and is_int(dmax) and dmax > 12:
            rep.warn('warm-up duration_max %d is long (rule 4)' % dmax)

    check_diagram(d, rep)


# ── Diagram checks (mirror of court-diagram.js) ────────────────────────────
def check_diagram(d, rep):
    diag = d.get('court_diagram')
    space = d.get('court_space')
    if space == 'off_court':
        if diag not in (None, {}):
            rep.warn('off_court drill carries a court_diagram; the prompt asks for null')
        return
    if isinstance(diag, str):
        try:
            diag = json.loads(diag)
            d['court_diagram'] = diag
            rep.warn('court_diagram was a JSON string; parsed it')
        except json.JSONDecodeError:
            rep.error('court_diagram is a string that is not valid JSON')
            return
    if diag is None:
        rep.error('court_diagram is missing (only off_court drills may omit it)')
        return
    if not isinstance(diag, dict):
        rep.error('court_diagram must be an object')
        return

    court = diag.get('court')
    if court not in ('full', 'half'):
        rep.error('court_diagram.court is "%s", expected "full" or "half"' % court)

    players = diag.get('players')
    if not isinstance(players, list) or not players:
        rep.error('court_diagram.players must be a non-empty array')
        players = []
    ids = set()
    positions = {}
    labels_text = ''
    for i, p in enumerate(players):
        if not isinstance(p, dict):
            rep.error('diagram player #%d is not an object' % (i + 1))
            continue
        pid = str(p.get('id', '')).strip()
        if not pid:
            rep.error('diagram player #%d has no id' % (i + 1))
        elif pid in ids:
            rep.error('diagram player id "%s" is duplicated' % pid)
        ids.add(pid)
        x, y = p.get('x'), p.get('y')
        if not (is_num(x) and is_num(y)):
            rep.error('diagram player %s is missing a numeric x or y' % (pid or '#%d' % (i + 1)))
            continue
        positions[pid] = (float(x), float(y))
        labels_text += ' ' + str(p.get('label', '')).lower()
        if court == 'half' and y < 0.4:
            rep.warn('diagram player %s is at y=%.2f on a half-court diagram (only y >= 0.5 is drawn; a feeder across the net belongs at ~0.45)' % (pid, y))
        if x < -0.35 or x > 1.35 or y < -0.25 or y > 1.25:
            rep.warn('diagram player %s at (%.2f, %.2f) is a long way off the court' % (pid, x, y))

    pmin, pmax = d.get('players_min'), d.get('players_max')
    if is_int(pmin) and is_int(pmax) and players and not (pmin <= len(players) <= pmax):
        rep.error('diagram shows %d players but players_min..players_max is %d..%d' % (len(players), pmin, pmax))

    body = (' '.join([str(d.get('setup', ''))] + [str(s) for s in (d.get('instructions') or [])])).lower()
    if re.search(r'\bfeeder\b|\bcoach\b', body) and not re.search(r'feed|coach', labels_text):
        rep.warn('text mentions a feeder/coach but no diagram player is labelled Feeder/Coach')

    equipment = diag.get('equipment')
    if equipment is None:
        equipment = []
    if not isinstance(equipment, list):
        rep.error('court_diagram.equipment must be an array')
        equipment = []
    for i, e in enumerate(equipment):
        if not isinstance(e, dict):
            rep.error('diagram equipment #%d is not an object' % (i + 1))
            continue
        etype = str(e.get('type', '')).strip().lower()
        if not (is_num(e.get('x')) and is_num(e.get('y'))):
            rep.error('diagram equipment #%d (%s) is missing a numeric x or y' % (i + 1, etype or 'no type'))
        if not any(k in etype.replace('_', ' ').replace('-', ' ') for k in KNOWN_EQUIPMENT_TYPES):
            rep.warn('diagram equipment type "%s" is not one the renderer knows (drawn as a plain square)' % etype)
    def endpoint_far(ref):
        if isinstance(ref, list) and len(ref) >= 2 and is_num(ref[1]):
            return ref[1] < 0.5
        return False
    far_side = any(y < 0.5 for (_, y) in positions.values()) or \
        any(isinstance(e, dict) and is_num(e.get('y')) and e['y'] < 0.5 for e in equipment) or \
        any(isinstance(p, dict) and (endpoint_far(p.get('from')) or endpoint_far(p.get('to'))) for p in (diag.get('paths') or []) if isinstance(diag.get('paths'), list))
    if space == 'full_court' and court == 'half':
        rep.warn('court_space is full_court but the diagram is "half"')
    elif space in ('half_court', 'service_boxes', 'baseline_only', 'net_area', 'cross_court_channel') \
            and court == 'full' and not far_side:
        rep.warn('diagram is "full" but nothing is placed on the far side; "half" would draw it larger')

    listed = ' '.join(d.get('equipment') or [])
    if any('cone' in str(e.get('type', '')).lower() for e in equipment if isinstance(e, dict)) and 'cones' not in listed:
        rep.warn('diagram places cones but the equipment list has none')
    if 'cones' in listed and not any('cone' in str(e.get('type', '')).lower() for e in equipment if isinstance(e, dict)):
        rep.warn('equipment lists cones but the diagram places none')

    paths = diag.get('paths')
    if paths is None:
        paths = []
    if not isinstance(paths, list):
        rep.error('court_diagram.paths must be an array')
        return
    if not paths:
        rep.warn('diagram has no paths, so nothing will animate')
    if len(paths) > 10:
        rep.warn('diagram has %d paths; the prompt asks for 3-8 (one cycle)' % len(paths))

    # Replay the sequence the way the renderer does, to catch paths that would
    # collapse to a point once players have moved.
    home = dict(positions)
    current = dict(positions)
    explicit = any(isinstance(p, dict) and is_num(p.get('step')) for p in paths)
    order = []
    for i, p in enumerate(paths):
        key = p.get('step') if isinstance(p, dict) and is_num(p.get('step')) else (10 ** 9 + i if explicit else i)
        order.append((key, i))
    order.sort()

    def resolve(ref, mode):
        if isinstance(ref, list) and len(ref) >= 2 and is_num(ref[0]) and is_num(ref[1]):
            return (float(ref[0]), float(ref[1])), None
        if isinstance(ref, dict) and is_num(ref.get('x')) and is_num(ref.get('y')):
            return (float(ref['x']), float(ref['y'])), None
        if isinstance(ref, (str, int)):
            pid = str(ref).strip()
            if pid in positions:
                return (home[pid] if mode == 'home' else current[pid]), pid
            return None, pid
        return None, None

    for _, i in order:
        p = paths[i]
        label = 'diagram path #%d' % (i + 1)
        if not isinstance(p, dict):
            rep.error('%s is not an object' % label)
            continue
        style = str(p.get('style', '')).strip().lower()
        if style not in PATH_STYLES:
            rep.error('%s has style "%s", expected ball | movement | feed' % (label, p.get('style')))
        a, a_id = resolve(p.get('from'), 'current')
        b, b_id = resolve(p.get('to'), 'home' if style == 'movement' else 'current')
        if a is None:
            rep.error('%s "from" is %s, not a known player id or [x, y]' % (label, json.dumps(p.get('from'))))
            continue
        if b is None:
            rep.error('%s "to" is %s, not a known player id or [x, y]' % (label, json.dumps(p.get('to'))))
            continue
        if abs(a[0] - b[0]) < 0.002 and abs(a[1] - b[1]) < 0.002:
            rep.error('%s starts and ends on the same spot (%s → %s) and would be skipped' % (label, p.get('from'), p.get('to')))
            continue
        if 'step' in p and not is_num(p.get('step')):
            rep.warn('%s has a non-numeric step' % label)
        if style == 'movement':
            mover = a_id
            if mover is None:
                for pid, pos in current.items():
                    if abs(pos[0] - a[0]) < 0.0125 and abs(pos[1] - a[1]) < 0.006:
                        mover = pid
                        break
            if mover is None:
                rep.warn('%s is a movement nobody is standing at the start of; it will animate as a dashed line only' % label)
            else:
                current[mover] = b


# ── Batch-level checks ─────────────────────────────────────────────────────
def norm_text(s):
    return re.sub(r'[^a-z0-9 ]', '', str(s).lower()).strip()


def check_batch(drills, args, library_slugs, out):
    problems = []
    slugs = Counter(d.get('slug') for d in drills)
    for slug, n in slugs.items():
        if n > 1:
            problems.append('slug "%s" appears %d times' % (slug, n))
    for d in drills:
        if d.get('slug') in library_slugs:
            problems.append('slug "%s" already exists in the library' % d.get('slug'))
    setups = {}
    for d in drills:
        key = norm_text(d.get('setup', ''))
        if key in setups:
            problems.append('"%s" has the same setup as "%s" (no two drills may share a setup)' % (d.get('name'), setups[key]))
        else:
            setups[key] = d.get('name')

    if args.expect_count is not None and len(drills) != args.expect_count:
        problems.append('%d drills survived, batch asked for %d' % (len(drills), args.expect_count))
    if args.expect_two_player is not None:
        n2 = sum(1 for d in drills if is_int(d.get('players_min')) and is_int(d.get('players_max')) and d['players_min'] <= 2 <= d['players_max'])
        if n2 < args.expect_two_player:
            problems.append('only %d drills work with exactly 2 players, batch asked for at least %d' % (n2, args.expect_two_player))
    if args.expect_small_space:
        space, _, n = args.expect_small_space.partition(':')
        want = int(n) if n else 1
        have = sum(1 for d in drills if d.get('court_space') == space)
        if have < want:
            problems.append('only %d drills use %s, batch asked for at least %d' % (have, space, want))
    intensities = {d.get('intensity') for d in drills}
    missing = INTENSITY - intensities
    if drills and missing and not args.no_intensity_spread:
        problems.append('no drills with intensity: %s' % ', '.join(sorted(missing)))
    for p in problems:
        out.append('BATCH  %s' % p)
    return problems


# ── Main ───────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('--out', help='where to write the surviving drills (default: <input>.validated.json)')
    ap.add_argument('--expect-count', type=int)
    ap.add_argument('--expect-two-player', type=int)
    ap.add_argument('--expect-small-space', help='e.g. service_boxes:4')
    ap.add_argument('--library', action='append', default=[], help='existing library JSON (repeatable)')
    ap.add_argument('--names', action='store_true', help='print name/summary lists for the duplicate check')
    ap.add_argument('--keep-flags', action='store_true', help='do not force source=generated / strip is_vetted')
    ap.add_argument('--no-intensity-spread', action='store_true', help='skip the low/medium/high spread check (cooldown batches)')
    args = ap.parse_args()

    drills = load_array(args.input)
    library = []
    for path in args.library:
        library.extend(load_array(path))
    library_slugs = {d.get('slug') for d in library if isinstance(d, dict)}

    kept, lines = [], []
    dropped = 0
    for i, d in enumerate(drills):
        rep = Report()
        if not isinstance(d, dict):
            lines.append('DROP   #%d: not an object' % (i + 1))
            dropped += 1
            continue
        if not args.keep_flags:
            if d.get('source') != 'generated':
                rep.warn('source was %r; set to "generated"' % d.get('source'))
            d['source'] = 'generated'
            if 'is_vetted' in d:
                rep.warn('is_vetted was present; stripped (it defaults to false)')
                del d['is_vetted']
        check_drill(d, rep)
        title = '#%d %s' % (i + 1, d.get('slug') or d.get('name') or '(no slug)')
        if rep.errors:
            dropped += 1
            lines.append('DROP   %s' % title)
            lines.extend('       ✗ %s' % e for e in rep.errors)
            lines.extend('       · %s' % w for w in rep.warnings)
        else:
            kept.append(d)
            lines.append('OK     %s%s' % (title, '' if not rep.warnings else '  (%d warning%s)' % (len(rep.warnings), '' if len(rep.warnings) == 1 else 's')))
            lines.extend('       · %s' % w for w in rep.warnings)

    batch_problems = check_batch(kept, args, library_slugs, lines)

    out_path = args.out or re.sub(r'\.json$', '', args.input) + '.validated.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(kept, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print('\n'.join(lines))
    print()
    print('%d drills read, %d kept, %d dropped → %s' % (len(drills), len(kept), dropped, out_path))
    if batch_problems:
        print('%d batch-level problem%s' % (len(batch_problems), '' if len(batch_problems) == 1 else 's'))

    if args.names:
        print('\n--- existing library (%d) ---' % len(library))
        for d in library:
            print('%s — %s: %s' % (d.get('slug'), d.get('name'), d.get('summary')))
        print('\n--- new drills (%d) ---' % len(kept))
        for d in kept:
            print('%s — %s: %s' % (d.get('slug'), d.get('name'), d.get('summary')))

    sys.exit(1 if dropped or batch_problems else 0)


if __name__ == '__main__':
    main()
