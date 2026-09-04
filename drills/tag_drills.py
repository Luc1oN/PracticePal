#!/usr/bin/env python3
"""Derive the Phase 2 tags for every drill by rule. The reviewer corrects
them in vet.html; this only gives composition a sensible starting point.

    python3 drills/tag_drills.py drills/library.json > out.json
"""
import json, re, sys
HEAVY = {'ball basket', 'basket', 'ball machine', 'machine', 'agility ladder', 'ladder', 'resistance band', 'band'}
LIGHT = {'cones', 'cone', 'throwdowns', 'throwdown', 'targets', 'target', 'hoops', 'hoop', 'lines', 'line'}
FEED = re.compile(r'\b(feeder|feeds|feeding|fed|ball machine|coach)\b', re.I)
TACTIC = re.compile(r'pattern|doubles|serve\s*\+\s*1|serve plus|decision|call|direction|approach|position|poach|read', re.I)
FUN = re.compile(r'king|ladder|points?\b|game|challenge|race|battle|duel|showdown|score|tiebreak|bonus|roulette|chaos', re.I)
ALL = ['technician', 'tactician', 'grinder', 'entertainer']

def equipment_level(eq):
    e = {x.lower() for x in eq}
    if e & HEAVY: return 'full'
    if e & LIGHT: return 'basic'
    return 'none'

def needs_feeder(d):
    return bool(FEED.search(d['setup'] + ' ' + ' '.join(d['instructions'])))

def styles(d):
    sf = set(d['skill_focus']); s = set()
    text = d['name'] + ' ' + d['summary']
    if sf & {'warmup', 'cooldown'}: return ALL
    if sf & {'forehand', 'backhand', 'serve', 'return', 'volley', 'overhead'} and d['intensity'] != 'high': s.add('technician')
    if 'tactical' in sf or TACTIC.search(text): s.add('tactician')
    if d['intensity'] == 'high' or sf & {'movement', 'conditioning'}: s.add('grinder')
    if 'games' in sf or FUN.search(text): s.add('entertainer')
    if not s: s.add('technician')
    return [x for x in ALL if x in s]

def tag(d):
    d = dict(d)
    d['equipment_level'] = equipment_level(d.get('equipment', []))
    d['needs_feeder'] = needs_feeder(d)
    d['styles'] = styles(d)
    return d

if __name__ == '__main__':
    drills = [tag(d) for d in json.load(open(sys.argv[1]))]
    json.dump(drills, sys.stdout, ensure_ascii=False, indent=1)
