// PracticePal — tennis session generator (Supabase Edge Function).
// Holds the Anthropic API key server-side and returns a STRUCTURED JSON plan
// (title, kit, timeline blocks, rotation, finisher) that the frontend renders
// as designed components rather than a wall of text.
//
// v11 (Sept 2026): player-first framing — there is no coach on court, the
// persona is the practice STYLE the players chose; "no kit" is the default
// (racquets and balls only) unless the request lists a basket and/or cones;
// every plan carries a `kit` list the app shows as "You'll need".
//
// This file is the source of truth — deploy it with the Supabase MCP
// deploy_edge_function tool (or `supabase functions deploy practicepal`).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const MODEL = 'claude-sonnet-5'

const GH_PAGES_ORIGIN = 'https://luc1on.github.io'

// Generous but real caps: a busy club sharing wifi shouldn't get blocked by
// one person's device, so the per-client cap is much tighter than per-IP.
const RATE_LIMITS = { ip: 40, client: 12 }

// The only equipment the app lets players declare. Anything else is "none".
const EQUIPMENT = ['basket', 'cones']

function corsHeaders(origin: string | null): Record<string, string> {
  const isLocal = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  const allow = isLocal ? origin! : GH_PAGES_ORIGIN
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// Practice STYLES, not coaches. A player picks one for their own session.
const PERSONAS: Record<string, { name: string; brief: string }> = {
  technician: {
    name: 'The Technician',
    brief:
      'A patient, detail-obsessed practice style. Take ONE skill (the focus, or a sensible pick for the level) and drill it deep with a clear progression — every stage built on hitting balls: cooperative starts, then the same shot with movement, then live-ball pressure, then applying it in points. Cues are specific and physical (contact point, swing path, footwork).',
  },
  tactician: {
    name: 'The Tactician',
    brief:
      'A cerebral, pattern-led practice style. Build the session around patterns of play, court positioning, shot selection and decision-making — all trained through live hitting and point play. Every drill has a tactical intention (cross-court to open the line, serve+1 patterns, doubles formations). Cues are about thinking: where to stand, where to hit, why.',
  },
  grinder: {
    name: 'The Grinder',
    brief:
      'A high-energy, high-ball-count practice style. Everything is done at intensity — but the intensity comes from hitting: long rally drills, ball-count targets, corner-to-corner hitting, short recovery windows between live-ball reps. No gym work, no running without a racquet and ball. Cues are about legs, split-steps, recovery position and effort.',
  },
  entertainer: {
    name: 'The Entertainer',
    brief:
      'A fun-first, competitive practice style. The session is built from games, team formats, chaos rules and bragging rights: king of the court, tiebreak ladders, target games, handicap scoring. Keep everyone involved and laughing, minimal queueing. Cues are about energy and competition.',
  },
}

const LEVELS = ['Beginner', 'Improver', 'Intermediate', 'Advanced']

const DIAGRAM_PATTERNS = [
  'cross_court_rally',
  'down_the_line_rally',
  'fed_drill',
  'target_zone',
  'rotation_queue',
  'king_of_court',
  'doubles_formation',
  'none',
]

// Shared between the full-session prompt and the single-block reroll prompt.
const SCENE_SPEC = `The court diagram uses a fixed anchor grid. The ONLY valid positions are:
- {left|right}_{net|mid|back}_{top|center|bottom} — side of net, depth (net/midcourt/baseline), lane. Examples: left_back_center, right_net_top.
- queue_1, queue_2, queue_3 — off-court waiting spots for players cycling in.

"scene" structure (keep it COMPACT — omit move_to/feeder/zone keys entirely when not used):
{"players":[{"n":1,"team":"a","at":"left_back_center","move_to":"left_net_center","feeder":true}],"balls":[{"from":"left_back_center","to":"right_back_top","kind":"rally"}],"zone":"right_mid_bottom","note":"max 8 words"}
Scene rules:
- Depict ONE representative moment of the drill — the most informative snapshot, one court even if the session uses several.
- players: at most 6 shown (mention any others in note). n = player number as displayed. team "a" = the featured/active players, "b" = opponents or waiting players (drawn dimmed). feeder true = this person starts the ball for this rep (drawn as a square F; use team "a"). Without a basket, a "feeder" is just the partner who drop-hits the first ball and then plays.
- move_to: ONLY for a player who genuinely moves during the drill (poach, approach the net, recover to centre, cycle in from the queue) — the anchor they run to.
- balls: 1 or 2. kind "rally" = struck back and forth; "feed" = a started ball; "shot" = a one-way shot (at a target/winner). Use 2 balls when two pairs genuinely hit simultaneously. Every scene needs at least 1 ball.
- zone: only for target-hitting drills.
- Opposing players belong on opposite left/right halves. Rally balls travel across the net (left↔right).
- Use scene null if you can't describe the drill faithfully — a wrong picture is worse than a generic one.`

// What the players actually have with them. "No kit" is the default and the
// commonest real case: two to four people, one court, one can of balls.
function kitRule(equipment: string[]): string {
  const basket = equipment.includes('basket')
  const cones = equipment.includes('cones')
  const lines: string[] = []
  if (basket) {
    lines.push('A basket of balls IS available. Fed drills are fine — but rotate whoever feeds every few reps so nobody spends a block only feeding; the person feeding is not practising.')
  } else {
    lines.push('NO basket or hopper of balls. The players have racquets and a handful of balls. Every drill starts from a self-drop, a serve, or a cooperative rally ball. Where a "feed" is genuinely needed it is a drop-hit by a partner who then plays the point out — nobody stands at the net feeding from a hopper, and nobody is a designated feeder for a whole block. Say "starts the ball" or "drop-hits", never "feeder". Design for maximum hitting per player with the balls they have (collect and go again is part of the rhythm).')
  }
  if (cones) {
    lines.push('Cones / throwdowns ARE available — use them for targets and markers where a target sharpens the drill.')
  } else {
    lines.push('NO cones, throwdowns or markers. Use what is already painted on the court as targets: the service boxes, the T, the doubles alleys, the baseline corners, "deeper than the service line". Never mention cones.')
  }
  lines.push('No ball machine, no wall, no other equipment unless the focus text names it.')
  return `KIT RULE (hard requirement — the players only have what is listed here):\n- ${lines.join('\n- ')}`
}

// Best-effort analytics log — every generation, across all users and guests,
// for future data analysis. Scheduled via EdgeRuntime.waitUntil so it runs
// AFTER the response is already sent — it can never add latency or cause a
// generation to fail, no matter how slow or broken the logging path is.
async function logGeneration(authHeader: string | null, body: Record<string, unknown>, plan: unknown) {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return
    let userId: string | null = null
    if (authHeader) {
      const callerClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: userData } = await callerClient.auth.getUser()
      userId = userData?.user?.id ?? null
    }
    const serviceClient = createClient(supabaseUrl, serviceKey)
    await serviceClient.from('practicepal_generations').insert({
      user_id: userId,
      persona_id: body.persona ?? 'technician',
      players: body.players, courts: body.courts, duration: body.duration, level: body.level,
      focus: body.focus || null,
      variation: body.variation || null,
      equipment: Array.isArray(body.equipment) ? body.equipment : [],
      plan,
    })
  } catch (logErr) {
    console.error('Analytics log failed (non-fatal)', logErr)
  }
}

// Rate limiting: an atomic Postgres RPC (increment_rate_limit) upserts a
// per-day counter and tells us if it's still under cap. Checked for BOTH
// per-IP and per-client (a random id the browser persists in localStorage,
// unrelated to accounts) so a single abusive device can't hide behind a
// shared club wifi IP, and a shared IP doesn't get blocked wholesale for one
// bad actor either. Fails OPEN on any infra hiccup — a broken rate-limit
// check should never be the reason real players can't get a session.
async function checkRateLimits(req: Request, clientId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return { ok: true }
    const serviceClient = createClient(supabaseUrl, serviceKey)
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
      || req.headers.get('cf-connecting-ip') || 'unknown-ip'
    const client = (clientId || 'unknown-client').slice(0, 64)

    const [{ data: ipOk, error: ipErr }, { data: clientOk, error: clientErr }] = await Promise.all([
      serviceClient.rpc('increment_rate_limit', { p_key: `ip:${ip}`, p_cap: RATE_LIMITS.ip }),
      serviceClient.rpc('increment_rate_limit', { p_key: `client:${client}`, p_cap: RATE_LIMITS.client }),
    ])
    if (ipErr || clientErr) {
      console.error('Rate limit RPC error (failing open)', ipErr, clientErr)
      return { ok: true }
    }
    if (ipOk === false || clientOk === false) {
      return { ok: false, message: "That's tonight's sessions used up on this device or network — try again tomorrow." }
    }
    return { ok: true }
  } catch (err) {
    console.error('Rate limit check failed (failing open)', err)
    return { ok: true }
  }
}

async function callClaude(apiKey: string, prompt: string, maxTokens: number) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    console.error('Anthropic error', resp.status, detail)
    return { error: true as const }
  }
  const data = await resp.json()
  const raw = (data.content ?? [])
    .filter((b: { type?: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('')
  return { error: false as const, raw, stop: data.stop_reason, usage: data.usage }
}

function extractJson(raw: string, stop: unknown): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    console.error('No JSON found. stop_reason=', stop, 'raw_len=', raw.length, 'raw_tail=', raw.slice(-200))
    throw new Error('No JSON found in model output')
  }
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch (parseErr) {
    console.error('JSON parse failed. stop_reason=', stop, 'raw_len=', raw.length, 'raw_tail=', raw.slice(-300))
    throw parseErr
  }
}

const sanitizeDiagram = (d: unknown) => (typeof d === 'string' && DIAGRAM_PATTERNS.includes(d) ? d : 'none')

// The model occasionally returns a timeline that stops short of (or runs
// past) the requested duration, or leaves a gap between blocks. Fix that
// deterministically instead of paying for a retry: order the blocks, close
// the gaps, then scale every block so the last one ends exactly on the
// duration, in whole minutes.
function normaliseTimeline(timeline: Record<string, any>[], duration: number): Record<string, any>[] {
  const blocks = timeline
    .filter((b) => b && typeof b === 'object' && Number.isFinite(Number(b.start)) && Number.isFinite(Number(b.end)))
    .sort((a, b) => Number(a.start) - Number(b.start))
  if (!blocks.length) return timeline
  let durs = blocks.map((b) => Math.max(1, Number(b.end) - Number(b.start)))
  const total = durs.reduce((a, d) => a + d, 0)
  if (total !== duration) durs = durs.map((d) => (d * duration) / total)
  let cursor = 0
  blocks.forEach((b, i) => {
    b.start = Math.round(cursor)
    cursor += durs[i]
    b.end = i === blocks.length - 1 ? duration : Math.round(cursor)
    if (b.end <= b.start) b.end = Math.min(duration, b.start + 1)
  })
  return blocks
}

// The "You'll need" list. Always starts with racquets and balls; drops
// anything the kit rule forbids even if the model slipped it in.
function sanitizeKit(k: unknown, equipment: string[]): string[] {
  const items = Array.isArray(k)
    ? k.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 6)
    : []
  const out = ['Racquets and balls']
  for (const item of items) {
    const l = item.toLowerCase()
    if (/racquet|racket|\bballs?\b(?!.*basket)/.test(l) && !/basket|hopper/.test(l)) continue
    if (!equipment.includes('basket') && /basket|hopper|machine/.test(l)) continue
    if (!equipment.includes('cones') && /cone|throwdown|marker/.test(l)) continue
    if (out.length < 5 && !out.includes(item)) out.push(item)
  }
  return out
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'Generator is not configured (missing ANTHROPIC_API_KEY).' }, 503)

  let body: {
    persona?: string
    players?: number
    courts?: number
    duration?: number
    level?: string
    focus?: string
    equipment?: unknown
    variation?: string
    previousTitle?: string
    clientId?: string
    reroll?: { index?: number; plan?: { title?: string; timeline?: unknown[] } }
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Bad request.' }, 400)
  }

  // Every path below calls Claude (a real cost) — check the budget before
  // any of it, for both the full-generation and per-block reroll requests.
  const rl = await checkRateLimits(req, body.clientId ?? '')
  if (!rl.ok) return json({ error: rl.message }, 429)

  const persona = PERSONAS[body.persona ?? ''] ?? PERSONAS.technician
  const players = Math.min(16, Math.max(1, Math.round(Number(body.players) || 4)))
  const courts = Math.min(6, Math.max(1, Math.round(Number(body.courts) || 1)))
  const duration = Math.min(180, Math.max(30, Math.round(Number(body.duration) || 75)))
  const level = LEVELS.includes(body.level ?? '') ? body.level : 'Intermediate'
  const focus = (body.focus ?? '').toString().slice(0, 120).trim()
  const variation = (body.variation ?? '').toString().slice(0, 40).trim()
  const previousTitle = (body.previousTitle ?? '').toString().slice(0, 80).trim()
  const equipment = (Array.isArray(body.equipment) ? body.equipment : [])
    .filter((e): e is string => typeof e === 'string' && EQUIPMENT.includes(e))

  const wantsOffBall = /shadow|no.?ball|without ball|technique only|visuali[sz]|footwork only|fitness/i.test(focus)

  const ballRule = wantsOffBall
    ? `The players' focus explicitly asks for off-ball/shadow work, so you may include it where it serves the focus — but keep the rest of the session live-ball.`
    : `BALL-STRIKING RULE (hard requirement): every single block, including the warm-up, must have players hitting live balls with their racquets. Banned unless the players ask: shadow swings, swing rehearsal without a ball, visualization, footwork-only ladders/cone work, running or fitness without hitting, and long talking/demo blocks. Get racquets on balls within the first two minutes. Players waiting their turn should be feeding, playing, or keeping score — never shadow-swinging on the side. Maximum ball contacts per player per minute is the quality bar for every drill you design.`

  const kit = kitRule(equipment)

  const framing = `You are designing tonight's practice session for a group of tennis players who have turned up to practise together with intent. There is no coach on court: write for the players themselves — instructions they can run for each other, in plain language, no coaching jargon. The practice style they picked: ${persona.name}. ${persona.brief}`

  // ── Per-block reroll: regenerate ONE block inside an existing plan ──────
  if (body.reroll && body.reroll.plan && Number.isInteger(body.reroll.index)) {
    const idx = body.reroll.index as number
    const tl = Array.isArray(body.reroll.plan.timeline) ? (body.reroll.plan.timeline as Record<string, unknown>[]) : []
    const target = tl[idx]
    if (!target) return json({ error: 'Bad reroll request.' }, 400)
    const outline = tl.map((b, i) => ({ i, start: b.start, end: b.end, title: b.title, aim: b.aim, drill: b.drill }))

    const rerollPrompt = `${framing}

Session parameters: ${players} players on ${courts} court${courts > 1 ? 's' : ''}, ${duration} minutes, ${level}${focus ? `, focus: ${focus}` : ''}.

${ballRule}

${kit}

Here is tonight's session outline (block index, minutes, title, aim, drill):
${JSON.stringify(outline)}

The players want a DIFFERENT drill for block ${idx} ("${String(target.title ?? '')}", minutes ${target.start}–${target.end}). Design a replacement that trains a similar aim with a clearly different drill mechanic, fits exactly the same minutes, suits the same group and the KIT RULE, and flows sensibly between its neighbouring blocks. Do not repeat any drill already in the outline.

The block needs the same four crisp facets (aim: 4-8 words; drill: one clipped telegraphic sentence; cycle: short phrase or null; target: short numeric phrase or null), one cue in the style's voice (or null), a diagram tag from: ${DIAGRAM_PATTERNS.join(', ')} — and a scene.

${SCENE_SPEC}

Return ONLY the minified JSON object for the replacement block — no wrapper, no preamble, no fences — exactly these fields:
{"start":${target.start},"end":${target.end},"title":"...","aim":"...","drill":"...","cycle":null,"target":null,"cue":null,"diagram":"...","scene":{"players":[],"balls":[],"note":""}}`

    try {
      const r = await callClaude(apiKey, rerollPrompt, 2500)
      if (r.error) return json({ error: 'The generator could not be reached right now. Try again in a moment.' }, 502)
      const block = extractJson(r.raw, r.stop) as Record<string, unknown>
      if (!block.title || !block.drill) throw new Error('Reroll block missing fields')
      block.start = target.start
      block.end = target.end
      block.diagram = sanitizeDiagram(block.diagram)
      const bg = logGeneration(req.headers.get('Authorization'), { ...body, players, courts, duration, level, focus, equipment, variation: 'block_reroll' }, block)
      // @ts-ignore - EdgeRuntime is available in the Supabase Deno runtime
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(bg)
      return json({ block })
    } catch (err) {
      console.error('Reroll failed', err)
      return json({ error: 'That swap came back scrambled. Try again.' }, 502)
    }
  }

  const VARIATIONS: Record<string, string> = {
    easier: 'Make this a gentler, lower-intensity version: simpler drills, more cooperative starts, less pressure.',
    harder: 'Make this a tougher version: faster progressions, more live-ball pressure, higher standards.',
    competitive: 'Make it more competitive: more scoring, more head-to-head games, keep score everywhere.',
    fitness: 'Raise the physical load — but keep it all ball-striking: higher ball counts, corner-to-corner hitting patterns, shorter rests between live reps.',
  }

  const remixLine =
    variation && VARIATIONS[variation]
      ? `\nThis is a REMIX of a previous session${previousTitle ? ` called "${previousTitle}"` : ''}. ${VARIATIONS[variation]} Give it a fresh, different name.`
      : ''

  const prompt = `${framing}

Session parameters:
- Players: ${players}
- Courts: ${courts}
- Duration: ${duration} minutes
- Level: ${level}
- Focus: ${focus || '(none given — choose something appropriate for the level and style)'}${remixLine}

${ballRule}

${kit}

Design the full session as a timeline of 4–7 blocks covering exactly 0 to ${duration} minutes with no gaps or overlaps. Always start with a short warm-up block (a hitting warm-up: mini-tennis, service-box rallies, cooperative hitting — not jogging and stretching) and ALWAYS end with a competitive finisher game as the last block (the dessert — fun, scored, memorable).

Be realistic about ${players} player${players === 1 ? '' : 's'} on ${courts} court${courts > 1 ? 's' : ''}: nobody should be standing around. If players don't divide evenly, the rotation must handle it. ${players === 1 ? 'One player alone: serves, self-fed targets, and rally-with-yourself patterns — never invent a partner.' : ''}${players === 2 ? 'Two players: every drill is the two of them hitting with each other — cooperative rallies with constraints, then live points. Neither of them is a feeder.' : ''}

Name the session: a punchy, memorable 2–4 word title the group would be proud to send to the group chat (e.g. "Doubles Net Sharpener", "Second Serve Surgery"). Never call it "Session" or anything generic, and never put the practice style's name (Technician, Tactician, Grinder, Entertainer) in the title.

For EVERY timeline block, break what you'd normally write as a paragraph into four crisp facets instead — this is read at a glance courtside, not as prose, so keep every facet short:
- aim: 4-8 words, the ONE skill or outcome this block trains — the why, not the how
- drill: one clipped, telegraphic sentence — the concrete mechanic/action. Use → for steps if it helps. No filler words.
- cycle: short phrase — who swaps roles and how often, or null if everyone does the same thing the whole block (e.g. a synchronised warm-up)
- target: short phrase with a concrete number/count/score to hit, or null if there's no numeric target for this block

For EVERY timeline block and for the finisher, also tag which court diagram pattern best matches it, from this exact list — pick the closest fit, or "none" if nothing fits well:
- cross_court_rally: two players/pairs rallying diagonally, corner to corner
- down_the_line_rally: two players rallying straight down one sideline
- fed_drill: one player starts each ball for another who hits
- target_zone: the aim is landing shots into a marked zone/target area
- rotation_queue: players cycling through roles, positions or courts in a queue
- king_of_court: singles winner-stays-on queue or elimination format
- doubles_formation: doubles positioning drill (up-back, two-back, poaching)
- none: doesn't clearly match any of the above
The finisher's diagram tag must match its timeline block (they describe the same game).

ADDITIONALLY, for every timeline block and the finisher, include a "scene" object that draws THIS drill precisely on a court diagram — or null if you can't describe it faithfully.

${SCENE_SPEC}

Also list the kit: 1-4 short items the group must bring, in this order: always "Racquets and balls" first, then ONLY items this plan actually uses and the KIT RULE allows (e.g. "A basket of balls", "4 cones"). Nothing else — never list something the KIT RULE forbids.

Return ONLY valid JSON, no preamble, no markdown fences. OUTPUT MINIFIED JSON — single line, no indentation or spaces between tokens (this response is machine-parsed; pretty-printing wastes the token budget). Exactly this structure:
{"title":"2-4 word session name","kit":["Racquets and balls"],"timeline":[{"start":0,"end":10,"title":"short block name","aim":"4-8 words, the why","drill":"one clipped sentence, the concrete mechanic","cycle":"short phrase, or null","target":"short phrase with a number, or null","cue":"one cue in the style's voice, or null","diagram":"one of: ${DIAGRAM_PATTERNS.join(', ')}","scene":{"players":[],"balls":[],"note":""}}],"rotation":{"summary":"1-3 sentences: how players rotate through courts/roles for this session, handling the exact player count","needs_diagram":${players > 4 ? 'true' : 'false'}},"finisher":{"title":"name of the final competitive game","description":"2-3 sentences: rules, scoring, what the winners get (bragging rights count)","diagram":"one of: ${DIAGRAM_PATTERNS.join(', ')}","scene":{"players":[],"balls":[],"note":""}}}

The finisher object must describe the SAME game as the last timeline block. Note the finisher keeps a normal prose "description" — only timeline blocks use the aim/drill/cycle/target facets.`

  try {
    const r = await callClaude(apiKey, prompt, 12000)
    if (r.error) return json({ error: 'The generator could not be reached right now. Try again in a moment.' }, 502)
    const plan = extractJson(r.raw, r.stop) as Record<string, any>

    if (!plan.title || !Array.isArray(plan.timeline) || plan.timeline.length === 0) {
      console.error('Plan missing required fields. stop_reason=', r.stop, 'keys=', Object.keys(plan))
      throw new Error('Plan missing required fields')
    }

    // Defensively normalise any diagram tag the model invents into a known
    // pattern (or 'none'), so the frontend never has to guard against junk.
    // Scenes are validated client-side (sanitizeScene) — passed through here.
    for (const block of plan.timeline) block.diagram = sanitizeDiagram(block.diagram)
    if (plan.finisher) plan.finisher.diagram = sanitizeDiagram(plan.finisher.diagram)
    plan.timeline = normaliseTimeline(plan.timeline, duration)
    plan.kit = sanitizeKit(plan.kit, equipment)

    // Schedule the analytics write for AFTER the response is sent, so it can
    // never add latency to (or cause a failure of) the user-facing request.
    const bg = logGeneration(req.headers.get('Authorization'), { ...body, players, courts, duration, level, focus, equipment, variation }, plan)
    // @ts-ignore - EdgeRuntime is available in the Supabase Deno runtime
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(bg)

    return json({ plan })
  } catch (err) {
    console.error('Generation failed', err)
    return json({ error: 'The plan came back scrambled. Hit generate again.' }, 502)
  }
})
