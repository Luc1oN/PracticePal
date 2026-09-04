/*
 * court-diagram.js — PracticePal court diagram renderer
 *
 * Draws a drill's `court_diagram` JSON (the Supabase JSONB column) as an SVG
 * element so a coach can read the drill at a glance, on screen or on paper,
 * and — on screen — watch it play: balls fly along ball/feed paths and the
 * player markers run along movement paths, step by step, on a loop.
 *
 *   const svg = renderCourtDiagram(drill.court_diagram, { width: 320, printMode: false, animate: true });
 *   if (svg) container.appendChild(svg); else showPlaceholder();
 *
 * Plain script, no dependencies, no build step. It defines exactly one
 * global, `renderCourtDiagram` (also exported via module.exports for tests).
 *
 * Input shape:
 *   {
 *     court: 'full' | 'half',
 *     players:   [{ id: 'P1', x: 0.22, y: 0.92, label: 'Feeder' }],
 *     equipment: [{ type: 'cone', x: 0.15, y: 0.72 }],
 *     paths:     [{ from: 'P1', to: 'P2' | [x, y], style: 'ball' | 'movement' | 'feed', step: 1 }]
 *   }
 *
 * Coordinates are normalised to the doubles court: (0,0) top-left corner,
 * (1,1) bottom-right, net at y = 0.5. Values outside 0-1 are legal (a player
 * standing off the court) and are drawn, never clamped — the viewBox grows
 * just enough to include them.
 *
 * Sequence: paths play in array order, one per step, unless they carry a
 * numeric `step` — paths with the same step play together, and paths
 * without one follow after. A player id in `from` means "wherever that
 * player is at that point in the sequence" (so `P1 → cone` then `P1 → P1`
 * is a run out and back). For movement, a player id in `to` means that
 * player's starting spot; for ball/feed it means where that player is now.
 *
 * Options: `width` (px; height follows the aspect), `printMode` (black on
 * white, no fills, no motion), `animate` (default true; false gives the
 * static arrows only). Viewers who prefer reduced motion get the static
 * diagram automatically.
 *
 * Skipped or suspicious input is never fatal. Anything the renderer had to
 * drop or guess is listed in the returned element's `data-warnings`
 * attribute (a JSON array of strings) so review tools can surface it. An
 * animated diagram also carries `data-animated`, `data-cycle` (seconds per
 * loop) and `data-steps`.
 *
 * Theming: every colour is a CSS custom property with a fallback, so the host
 * page can override e.g. `--cd-surface`, `--cd-line`, `--cd-player`,
 * `--cd-feeder`, `--cd-ball`, `--cd-movement`, `--cd-feed` on any ancestor.
 */
(function (global) {
  'use strict';

  // ── Canvas ───────────────────────────────────────────────────────────────
  // Full court: viewBox 0 0 400 760, playing surface x 40-360, y 40-720.
  // Half court: same scale, near half only (net at the top) → viewBox 0 0 400 420.
  const MARGIN = 40;
  const COURT_W = 320;
  const COURT_H = 680;
  const CANVAS_W = 400;
  const PLAYER_R = 14;
  const BALL_R = 5;
  const LINE_W = 2;
  const NET_OVERHANG = 24;   // net posts sit outside the doubles sidelines
  const CURVE_STEP = 16;     // px between paths that share the same two endpoints
  const LABEL_FONT = 11;
  const LABEL_H = 12;

  // Regulation geometry in normalised court space (doubles court = 1 x 1).
  const SINGLES = [0.125, 0.875];
  const SERVICE = [0.231, 0.769];
  const NET_Y = 0.5;
  const CENTRE_X = 0.5;
  const CENTRE_MARK = 14 / COURT_H;

  // Motion: canvas px per second, clamped per style. Steps play one after
  // another with a short gap, then the loop pauses before starting again.
  const SPEED = { ball: 420, feed: 300, movement: 150 };
  const DUR_MIN = { ball: 0.45, feed: 0.5, movement: 0.6 };
  const DUR_MAX = { ball: 1.6, feed: 1.6, movement: 2.4 };
  const LEAD_IN = 0.5;
  const STEP_GAP = 0.3;
  const LOOP_PAUSE = 1.0;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  let instanceCount = 0;

  // ── Public API ───────────────────────────────────────────────────────────
  function renderCourtDiagram(diagram, options) {
    const d = coerceDiagram(diagram);
    if (!d) return null;
    try {
      return render(d, options || {});
    } catch (err) {
      // Contract: never throw. Surface the problem for developers, return
      // null so the caller shows its placeholder.
      if (global.console && console.warn) console.warn('renderCourtDiagram failed', err);
      return null;
    }
  }

  function render(d, opts) {
    const printMode = !!opts.printMode;
    const animate = printMode ? false : (opts.animate === undefined ? true : !!opts.animate);
    const half = isHalf(d.court);
    const warnings = [];
    const warn = (msg) => warnings.push(msg);

    const players = readPlayers(d.players, warn);
    const equipment = readEquipment(d.equipment, warn);
    const paths = readPaths(d.paths, players, warn);

    const proj = makeProjector(half);
    const colours = palette(printMode);
    const id = 'cd-' + (++instanceCount);

    // Canvas-space positions.
    players.forEach((p) => { p.cx = proj.x(p.x); p.cy = proj.y(p.y); });
    equipment.forEach((e) => { e.cx = proj.x(e.x); e.cy = proj.y(e.y); });
    const lines = courtLines(half).map((s) => ({
      x1: Math.round(proj.x(s.x1)), y1: Math.round(proj.y(s.y1)),
      x2: Math.round(proj.x(s.x2)), y2: Math.round(proj.y(s.y2)),
    }));
    const netY = Math.round(proj.y(NET_Y));
    const netLine = { x1: MARGIN - NET_OVERHANG, y1: netY, x2: MARGIN + COURT_W + NET_OVERHANG, y2: netY };

    const plan = buildPathGeometry(paths, players, proj, warn);
    const labels = placeLabels(players, equipment, lines.concat([netLine]), plan.segs, proj);
    const vb = computeViewBox(proj, players, equipment, plan.segs, labels);
    const timeline = animate ? buildTimeline(plan) : null;

    // ── Assemble the SVG ──
    const svg = el('svg', {
      xmlns: SVG_NS,
      id,
      viewBox: vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h,
      role: 'img',
      'aria-labelledby': id + '-title',
      class: 'cd ' + (half ? 'cd--half' : 'cd--full') + (printMode ? ' cd--print' : '') + (timeline ? ' cd--animated' : ''),
    });
    svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
    if (typeof opts.width === 'number' && opts.width > 0) {
      svg.setAttribute('width', String(opts.width));
      svg.setAttribute('height', String(fmt(opts.width * vb.h / vb.w)));
    } else {
      svg.setAttribute('width', '100%');
    }

    const title = el('title', { id: id + '-title' }, svg);
    title.textContent = buildTitle(d, players, equipment, paths, half, timeline);

    const style = el('style', null, svg);
    style.textContent = styleText(id, colours, printMode) + (timeline ? '\n' + animationCss(id, plan.segs, timeline) : '');

    const defs = el('defs', null, svg);
    const marker = el('marker', {
      id: id + '-arrow',
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '5.5',
      markerHeight: '5.5',
      orient: 'auto',
      markerUnits: 'strokeWidth',
    }, defs);
    el('path', { class: 'cd-arrow', d: 'M0 0.5 L10 5 L0 9.5 Z' }, marker);

    drawCourt(svg, proj, vb, lines, netY, netLine);
    drawEquipment(svg, equipment);
    drawPaths(svg, plan.segs, id, timeline);
    drawPlayers(svg, players, labels, printMode, timeline);
    if (timeline) drawBalls(svg, plan.segs);

    if (timeline) {
      svg.setAttribute('data-animated', 'true');
      svg.setAttribute('data-cycle', String(fmt(timeline.total)));
      svg.setAttribute('data-steps', String(timeline.stepCount));
    }
    if (warnings.length) svg.setAttribute('data-warnings', JSON.stringify(warnings));
    return svg;
  }

  // ── Input coercion ───────────────────────────────────────────────────────
  function coerceDiagram(diagram) {
    if (diagram == null) return null;
    if (typeof diagram === 'string') {
      const s = diagram.trim();
      if (!s) return null;
      try {
        const parsed = JSON.parse(s);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (e) {
        return null;
      }
    }
    if (typeof diagram !== 'object' || Array.isArray(diagram)) return null;
    return diagram;
  }

  function isHalf(court) {
    return typeof court === 'string' && /half/i.test(court);
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return null;
  }

  function str(v) {
    return v == null ? '' : String(v).trim();
  }

  function readPlayers(list, warn) {
    const out = [];
    if (list == null) return out;
    if (!Array.isArray(list)) { warn('players is not an array; ignored'); return out; }
    const seen = new Set();
    list.forEach((p, i) => {
      const ref = 'player #' + (i + 1);
      if (!p || typeof p !== 'object') { warn(ref + ' is not an object; skipped'); return; }
      const x = num(p.x), y = num(p.y);
      const rawId = str(p.id);
      if (x === null || y === null) {
        warn((rawId ? 'player ' + rawId : ref) + ' skipped: missing x or y');
        return;
      }
      let id = rawId;
      if (!id) { id = 'P' + (i + 1); warn(ref + ' has no id; drawn as ' + id); }
      if (seen.has(id)) warn('duplicate player id "' + id + '"; paths use the first one');
      seen.add(id);
      const label = str(p.label);
      const feeder = /feed|coach/i.test(label) || /feed|coach/i.test(str(p.role));
      out.push({ id, x, y, label, feeder });
    });
    return out;
  }

  function equipmentKind(type) {
    const t = str(type).toLowerCase().replace(/[\s_-]+/g, '');
    if (!t) return 'unknown';
    if (t.indexOf('cone') !== -1) return 'cone';
    if (t.indexOf('target') !== -1 || t.indexOf('hoop') !== -1 || t.indexOf('ring') !== -1) return 'target';
    if (t.indexOf('throwdown') !== -1 || t.indexOf('line') !== -1) return 'throwdown';
    if (t.indexOf('machine') !== -1) return 'machine';
    if (t.indexOf('ladder') !== -1) return 'ladder';
    if (t.indexOf('basket') !== -1 || t.indexOf('hopper') !== -1 || t.indexOf('cart') !== -1) return 'basket';
    return 'unknown';
  }

  function readEquipment(list, warn) {
    const out = [];
    if (list == null) return out;
    if (!Array.isArray(list)) { warn('equipment is not an array; ignored'); return out; }
    list.forEach((e, i) => {
      const ref = 'equipment #' + (i + 1);
      if (!e || typeof e !== 'object') { warn(ref + ' is not an object; skipped'); return; }
      const x = num(e.x), y = num(e.y);
      const type = str(e.type);
      if (x === null || y === null) { warn(ref + (type ? ' (' + type + ')' : '') + ' skipped: missing x or y'); return; }
      const kind = equipmentKind(type);
      if (kind === 'unknown') warn(ref + ': unknown type "' + type + '"; drawn as a hollow square');
      const rotate = num(e.rotate != null ? e.rotate : e.angle);
      out.push({ type, kind, x, y, label: str(e.label), rotate: rotate === null ? 0 : rotate });
    });
    return out;
  }

  const STYLE_ALIASES = {
    ball: 'ball', shot: 'ball', hit: 'ball', rally: 'ball',
    movement: 'movement', move: 'movement', run: 'movement', rotate: 'movement', rotation: 'movement',
    feed: 'feed', toss: 'feed',
  };

  function readPaths(list, players, warn) {
    const out = [];
    if (list == null) return out;
    if (!Array.isArray(list)) { warn('paths is not an array; ignored'); return out; }
    const byId = new Map();
    const byLower = new Map();
    players.forEach((p) => {
      if (!byId.has(p.id)) byId.set(p.id, p);
      const k = p.id.toLowerCase();
      if (!byLower.has(k)) byLower.set(k, p);
    });

    function resolve(ref) {
      if (Array.isArray(ref)) {
        const x = num(ref[0]), y = num(ref[1]);
        return x === null || y === null ? null : { x, y, player: null };
      }
      if (ref && typeof ref === 'object') {
        const x = num(ref.x), y = num(ref.y);
        return x === null || y === null ? null : { x, y, player: null };
      }
      if (typeof ref === 'string' || typeof ref === 'number') {
        const key = str(ref);
        const p = byId.get(key) || byLower.get(key.toLowerCase());
        return p ? { x: p.x, y: p.y, player: p } : null;
      }
      return null;
    }

    function describe(ref) {
      if (Array.isArray(ref)) return '[' + ref.join(', ') + ']';
      if (ref && typeof ref === 'object') return JSON.stringify(ref);
      return ref == null ? '(missing)' : String(ref);
    }

    list.forEach((p, i) => {
      const ref = 'path #' + (i + 1);
      if (!p || typeof p !== 'object') { warn(ref + ' is not an object; skipped'); return; }
      const from = resolve(p.from);
      const to = resolve(p.to);
      if (!from) { warn(ref + ' skipped: "from" ' + describe(p.from) + ' is not a known player or [x, y]'); return; }
      if (!to) { warn(ref + ' skipped: "to" ' + describe(p.to) + ' is not a known player or [x, y]'); return; }
      const rawStyle = str(p.style).toLowerCase();
      let style = STYLE_ALIASES[rawStyle];
      if (!style) {
        warn(ref + (rawStyle ? ': unknown style "' + rawStyle + '"' : ' has no style') + '; drawn as ball');
        style = 'ball';
      }
      const step = num(p.step != null ? p.step : (p.seq != null ? p.seq : p.order));
      out.push({ index: i, from, to, style, step });
    });
    return out;
  }

  // ── Geometry ─────────────────────────────────────────────────────────────
  function makeProjector(half) {
    const yMin = half ? NET_Y : 0;
    return {
      half,
      vbW: CANVAS_W,
      vbH: MARGIN * 2 + (half ? COURT_H / 2 : COURT_H),
      x: (cx) => MARGIN + cx * COURT_W,
      y: (cy) => MARGIN + (cy - yMin) * COURT_H,
    };
  }

  // Court lines as segments in normalised space, clipped to the visible half.
  function courtLines(half) {
    const yMin = half ? NET_Y : 0;
    const yMax = 1;
    const segs = [];
    function add(x1, y1, x2, y2) {
      if (y1 === y2) { if (y1 < yMin || y1 > yMax) return; }
      else {
        y1 = Math.max(yMin, Math.min(yMax, y1));
        y2 = Math.max(yMin, Math.min(yMax, y2));
        if (y1 === y2) return;
      }
      segs.push({ x1, y1, x2, y2 });
    }
    add(0, 0, 1, 0); add(0, 1, 1, 1);                              // baselines
    add(0, 0, 0, 1); add(1, 0, 1, 1);                              // doubles sidelines
    add(SINGLES[0], 0, SINGLES[0], 1); add(SINGLES[1], 0, SINGLES[1], 1); // singles sidelines
    add(SINGLES[0], SERVICE[0], SINGLES[1], SERVICE[0]);          // service lines
    add(SINGLES[0], SERVICE[1], SINGLES[1], SERVICE[1]);
    add(CENTRE_X, SERVICE[0], CENTRE_X, SERVICE[1]);              // centre service line
    add(CENTRE_X, 0, CENTRE_X, CENTRE_MARK);                      // centre marks
    add(CENTRE_X, 1 - CENTRE_MARK, CENTRE_X, 1);
    return segs;
  }

  function fmt(n) {
    return Math.round(n * 100) / 100;
  }

  function pt(p) {
    return fmt(p.x) + ' ' + fmt(p.y);
  }

  function quadLength(a, c, b) {
    let len = 0, px = a.x, py = a.y;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      const x = u * u * a.x + 2 * u * t * c.x + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * c.y + t * t * b.y;
      len += Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    return len;
  }

  // Play order: explicit `step` values first (equal steps play together),
  // then paths without one in array order. With no steps at all, every path
  // is its own step, in array order.
  function stepGroups(paths) {
    const explicit = paths.some((p) => p.step !== null);
    const keyed = paths.map((p, i) => ({ i, key: p.step !== null ? p.step : (explicit ? 1e9 + i : i) }));
    keyed.sort((a, b) => a.key - b.key || a.i - b.i);
    const groups = [];
    keyed.forEach((k) => {
      const g = groups[groups.length - 1];
      if (g && g.key === k.key) g.items.push(k.i);
      else groups.push({ key: k.key, items: [k.i] });
    });
    return groups;
  }

  // Resolves every path to canvas points in play order, tracking where each
  // player is as the sequence unfolds, then fans apart paths that share the
  // same two endpoints.
  function buildPathGeometry(paths, players, proj, warn) {
    const groups = stepGroups(paths);
    const pos = new Map();
    players.forEach((p) => pos.set(p, { x: p.cx, y: p.cy }));

    const items = [];
    groups.forEach((g, gi) => g.items.forEach((i) => {
      const p = paths[i];
      const isMove = p.style === 'movement';
      const fromPl = p.from.player, toPl = p.to.player;
      const A = fromPl ? pos.get(fromPl) : { x: proj.x(p.from.x), y: proj.y(p.from.y) };
      const B = toPl ? (isMove ? { x: toPl.cx, y: toPl.cy } : pos.get(toPl)) : { x: proj.x(p.to.x), y: proj.y(p.to.y) };
      const a = { x: A.x, y: A.y, r: fromPl ? PLAYER_R + 1 : 0 };
      const b = { x: B.x, y: B.y, r: toPl ? PLAYER_R + 1 : 0 };
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) {
        warn('path #' + (p.index + 1) + ' skipped: starts and ends at the same point');
        return;
      }
      let mover = null;
      if (isMove) {
        mover = fromPl || null;
        if (!mover) {
          players.forEach((q) => {
            const c = pos.get(q);
            if (!mover && Math.hypot(c.x - a.x, c.y - a.y) < 4) mover = q;
          });
        }
        if (mover) pos.set(mover, { x: b.x, y: b.y });
      }
      items.push({ index: p.index, style: p.style, a, b, mover, group: gi });
    }));

    const pairs = new Map();
    items.forEach((it) => {
      const ka = pt(it.a), kb = pt(it.b);
      it.flipped = ka > kb;
      it.pairKey = it.flipped ? kb + '|' + ka : ka + '|' + kb;
      if (!pairs.has(it.pairKey)) pairs.set(it.pairKey, []);
      pairs.get(it.pairKey).push(it.index);
    });

    const segs = [];
    items.forEach((it) => {
      const grp = pairs.get(it.pairKey);
      const n = grp.length;
      const bend = n > 1 ? (grp.indexOf(it.index) - (n - 1) / 2) * CURVE_STEP : 0;
      const geo = pathD(it.a, it.b, bend, it.flipped);
      if (!geo) { warn('path #' + (it.index + 1) + ' skipped: endpoints overlap'); return; }
      segs.push({
        index: it.index, style: it.style, group: it.group, mover: it.mover,
        a: it.a, b: it.b, d: geo.d, len: geo.len, ctrl: geo.ctrl, routeLen: geo.routeLen,
      });
    });
    return { segs, groups };
  }

  function pathD(a, b, bend, flipped) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 6) return null;
    // A short hop between two markers (a player stepping back to their spot)
    // would vanish if both ends were trimmed by a full radius, so shrink the
    // trims to leave at least a few pixels of line.
    if (a.r + b.r > len - 4) {
      const scale = (len - 4) / (a.r + b.r);
      a = { x: a.x, y: a.y, r: a.r * scale };
      b = { x: b.x, y: b.y, r: b.r * scale };
    }
    const ux = dx / len, uy = dy / len;
    if (!bend) {
      const A = { x: a.x + ux * a.r, y: a.y + uy * a.r };
      const B = { x: b.x - ux * b.r, y: b.y - uy * b.r };
      return { d: 'M ' + pt(A) + ' L ' + pt(B), len: len - a.r - b.r, ctrl: null, routeLen: len };
    }
    // Normal taken from the canonical endpoint order so every path in the
    // group bends the same way regardless of its own direction.
    const sgn = flipped ? -1 : 1;
    const nx = -uy * sgn, ny = ux * sgn;
    // A quadratic curve passes through mid + n*bend when the control point is
    // at mid + n*2*bend.
    const ctrl = { x: (a.x + b.x) / 2 + nx * bend * 2, y: (a.y + b.y) / 2 + ny * bend * 2 };
    const A = trimToward(a, ctrl, a.r);
    const B = trimToward(b, ctrl, b.r);
    return {
      d: 'M ' + pt(A) + ' Q ' + pt(ctrl) + ' ' + pt(B),
      len: quadLength(A, ctrl, B),
      ctrl,
      routeLen: quadLength(a, ctrl, b),
    };
  }

  function trimToward(p, c, r) {
    const dx = c.x - p.x, dy = c.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / l * r, y: p.y + dy / l * r };
  }

  // ── Timeline ─────────────────────────────────────────────────────────────
  function segDuration(s) {
    const raw = s.len / SPEED[s.style];
    return Math.max(DUR_MIN[s.style], Math.min(DUR_MAX[s.style], raw));
  }

  // Gives every segment a time window inside one loop, and chains each
  // moving player's movement segments into a single route to animate along.
  function buildTimeline(plan) {
    const segs = plan.segs;
    if (!segs.length) return null;
    const byGroup = new Map();
    segs.forEach((s) => {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(s);
    });
    const order = Array.from(byGroup.keys()).sort((x, y) => x - y);
    let t = LEAD_IN;
    order.forEach((g) => {
      const members = byGroup.get(g);
      let dur = 0;
      members.forEach((s) => { dur = Math.max(dur, segDuration(s)); });
      members.forEach((s) => { s.t0 = t; s.t1 = t + dur; });
      t += dur + STEP_GAP;
    });
    const total = t - STEP_GAP + LOOP_PAUSE;

    const movers = new Map();
    order.forEach((g) => byGroup.get(g).forEach((s) => {
      if (s.style !== 'movement' || !s.mover) return;
      let m = movers.get(s.mover);
      if (!m) {
        m = { player: s.mover, d: 'M ' + pt(s.a), parts: [], len: 0 };
        movers.set(s.mover, m);
      }
      const prevEnd = m.parts.length ? m.parts[m.parts.length - 1].t1 : 0;
      const t0 = Math.max(s.t0, prevEnd);
      const t1 = Math.min(total, Math.max(s.t1, t0 + 0.3));
      m.d += s.ctrl ? ' Q ' + pt(s.ctrl) + ' ' + pt(s.b) : ' L ' + pt(s.b);
      m.parts.push({ t0, t1, len: s.routeLen });
      m.len += s.routeLen;
    }));
    return {
      total,
      stepCount: order.length,
      movers: Array.from(movers.values()).filter((m) => m.len > 0),
    };
  }

  function animationCss(id, segs, tl) {
    const s = '#' + id;
    const T = fmt(tl.total);
    const pct = (t) => fmt(Math.max(0, Math.min(100, t / tl.total * 100)));
    const rules = [];
    segs.forEach((seg) => {
      if (seg.style === 'movement') {
        if (seg.mover) return;
        // Nobody to run this one: let the dashes flow toward the destination.
        const name = id + '-a' + seg.index;
        const cycles = Math.max(1, Math.round(seg.len / 12));
        rules.push('@keyframes ' + name + '{0%,' + pct(seg.t0) + '%{stroke-dashoffset:0}' + pct(seg.t1) + '%,100%{stroke-dashoffset:' + (-12 * cycles) + '}}');
        rules.push(s + ' .cd-a' + seg.index + '{animation:' + name + ' ' + T + 's linear infinite}');
        return;
      }
      const name = id + '-b' + seg.index;
      const eps = Math.min(0.08, (seg.t1 - seg.t0) * 0.15);
      rules.push('@keyframes ' + name + '{0%,' + pct(seg.t0) + '%{offset-distance:0%;opacity:0}' +
        pct(seg.t0 + eps) + '%{opacity:1}' + pct(seg.t1 - eps) + '%{opacity:1}' +
        pct(seg.t1) + '%,100%{offset-distance:100%;opacity:0}}');
      rules.push(s + ' .cd-b' + seg.index + '{animation:' + name + ' ' + T + 's cubic-bezier(.35,.1,.65,.9) infinite}');
    });
    tl.movers.forEach((m, j) => {
      const name = id + '-m' + j;
      const frames = ['0%{offset-distance:0%}'];
      let acc = 0;
      m.parts.forEach((part) => {
        const f0 = acc / m.len * 100;
        acc += part.len;
        const f1 = acc / m.len * 100;
        frames.push(pct(part.t0) + '%{offset-distance:' + fmt(f0) + '%}');
        frames.push(pct(part.t1) + '%{offset-distance:' + fmt(f1) + '%}');
      });
      frames.push('100%{offset-distance:' + fmt(acc / m.len * 100) + '%}');
      rules.push('@keyframes ' + name + '{' + frames.join('') + '}');
      rules.push(s + ' .cd-m' + j + '{animation:' + name + ' ' + T + 's ease-in-out infinite}');
    });
    rules.push('@media (prefers-reduced-motion: reduce){' + s + ' .cd-ball{display:none}' + s + ' .cd-anim{animation:none !important}}');
    return rules.join('\n');
  }

  // ── Label placement ──────────────────────────────────────────────────────
  // Tries eight spots around each marker and keeps the one that collides
  // least with court lines, other markers, path lines and labels already placed.
  function labelWidth(text) {
    return Math.ceil(text.length * LABEL_FONT * 0.6) + 2;
  }

  function candidates(cx, cy, w) {
    const R = PLAYER_R, gap = 4, h = LABEL_H;
    const diag = R * 0.72 + 3;
    return [
      { name: 'right', pref: 0, anchor: 'start', x: cx + R + gap, y: cy - h / 2, w, h },
      { name: 'left', pref: 0.2, anchor: 'end', x: cx - R - gap - w, y: cy - h / 2, w, h },
      { name: 'below', pref: 0.4, anchor: 'middle', x: cx - w / 2, y: cy + R + gap, w, h },
      { name: 'above', pref: 0.6, anchor: 'middle', x: cx - w / 2, y: cy - R - gap - h, w, h },
      { name: 'below-right', pref: 0.8, anchor: 'start', x: cx + diag, y: cy + diag - 3, w, h },
      { name: 'below-left', pref: 0.9, anchor: 'end', x: cx - diag - w, y: cy + diag - 3, w, h },
      { name: 'above-right', pref: 1.0, anchor: 'start', x: cx + diag, y: cy - diag - h + 3, w, h },
      { name: 'above-left', pref: 1.1, anchor: 'end', x: cx - diag - w, y: cy - diag - h + 3, w, h },
    ];
  }

  function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function lineCrossesRect(l, r) {
    const pad = LINE_W / 2 + 0.5;
    const lx1 = Math.min(l.x1, l.x2) - pad, lx2 = Math.max(l.x1, l.x2) + pad;
    const ly1 = Math.min(l.y1, l.y2) - pad, ly2 = Math.max(l.y1, l.y2) + pad;
    return lx1 < r.x + r.w && lx2 > r.x && ly1 < r.y + r.h && ly2 > r.y;
  }

  // Any-angle segment vs rectangle (used for ball/movement/feed lines).
  function segmentCrossesRect(x1, y1, x2, y2, r) {
    const pad = 2;
    const rx1 = r.x - pad, ry1 = r.y - pad, rx2 = r.x + r.w + pad, ry2 = r.y + r.h + pad;
    const inside = (x, y) => x >= rx1 && x <= rx2 && y >= ry1 && y <= ry2;
    if (inside(x1, y1) || inside(x2, y2)) return true;
    // Liang–Barsky clip: does any part of the segment lie inside the box?
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1;
    const checks = [[-dx, x1 - rx1], [dx, rx2 - x1], [-dy, y1 - ry1], [dy, ry2 - y1]];
    for (let i = 0; i < 4; i++) {
      const pq = checks[i][0], q = checks[i][1];
      if (pq === 0) { if (q < 0) return false; continue; }
      const t = q / pq;
      if (pq < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 <= t1;
  }

  // Straight-line approximation of each drawn path (two pieces for curves).
  function pathPieces(segs) {
    const pieces = [];
    segs.forEach((s) => {
      if (s.ctrl) {
        const mx = (s.a.x + 2 * s.ctrl.x + s.b.x) / 4, my = (s.a.y + 2 * s.ctrl.y + s.b.y) / 4;
        pieces.push([s.a.x, s.a.y, mx, my], [mx, my, s.b.x, s.b.y]);
      } else {
        pieces.push([s.a.x, s.a.y, s.b.x, s.b.y]);
      }
    });
    return pieces;
  }

  function placeLabels(P, E, lines, segs, proj) {
    const markers = P.map((p) => ({ x: p.cx - PLAYER_R, y: p.cy - PLAYER_R, w: PLAYER_R * 2, h: PLAYER_R * 2 }))
      .concat(E.map((e) => ({ x: e.cx - 10, y: e.cy - 10, w: 20, h: 20 })));
    const pieces = pathPieces(segs);
    const placed = [];
    const out = [];
    P.forEach((p) => {
      if (!p.label || p.label === p.id) return;
      const w = labelWidth(p.label);
      // A marker already off the canvas grows the viewBox anyway, so its
      // label may sit outside too; on-court labels should stay inside.
      const markerInside = p.cx - PLAYER_R >= 0 && p.cy - PLAYER_R >= 0 && p.cx + PLAYER_R <= proj.vbW && p.cy + PLAYER_R <= proj.vbH;
      let best = null, bestScore = Infinity;
      candidates(p.cx, p.cy, w).forEach((c) => {
        let score = c.pref;
        const area = c.w * c.h;
        markers.forEach((m) => { score += overlapArea(c, m) / area * 10; });
        placed.forEach((m) => { score += overlapArea(c, m) / area * 8; });
        lines.forEach((l) => { if (lineCrossesRect(l, c)) score += 3; });
        pieces.forEach((q) => { if (segmentCrossesRect(q[0], q[1], q[2], q[3], c)) score += 2.5; });
        if (c.x < 0 || c.y < 0 || c.x + c.w > proj.vbW || c.y + c.h > proj.vbH) score += markerInside ? 5 : 0.5;
        if (score < bestScore) { bestScore = score; best = c; }
      });
      placed.push(best);
      const tx = best.anchor === 'start' ? best.x : best.anchor === 'end' ? best.x + best.w : best.x + best.w / 2;
      out.push({ player: p, text: p.label, anchor: best.anchor, x: tx, y: best.y + LABEL_H - 2.5, rect: best });
    });
    return out;
  }

  // The base canvas is fixed; it only grows when something sits outside it.
  function computeViewBox(proj, P, E, segs, labels) {
    let minX = 0, minY = 0, maxX = proj.vbW, maxY = proj.vbH;
    const pad = 6;
    function grow(x, y, r) {
      minX = Math.min(minX, x - r - pad); maxX = Math.max(maxX, x + r + pad);
      minY = Math.min(minY, y - r - pad); maxY = Math.max(maxY, y + r + pad);
    }
    P.forEach((p) => grow(p.cx, p.cy, PLAYER_R + 1));
    E.forEach((e) => grow(e.cx, e.cy, 12));
    segs.forEach((s) => {
      grow(s.a.x, s.a.y, 3);
      grow(s.b.x, s.b.y, s.style === 'movement' && s.mover ? PLAYER_R + 1 : 8);
      if (s.ctrl) grow((s.a.x + 2 * s.ctrl.x + s.b.x) / 4, (s.a.y + 2 * s.ctrl.y + s.b.y) / 4, 3);
    });
    labels.forEach((l) => {
      minX = Math.min(minX, l.rect.x - pad); maxX = Math.max(maxX, l.rect.x + l.rect.w + pad);
      minY = Math.min(minY, l.rect.y - pad); maxY = Math.max(maxY, l.rect.y + l.rect.h + pad);
    });
    const x = Math.floor(minX), y = Math.floor(minY);
    return { x, y, w: Math.ceil(maxX) - x, h: Math.ceil(maxY) - y };
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (const k in attrs) if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function drawCourt(svg, proj, vb, lines, netY, netLine) {
    const g = el('g', { class: 'cd-court' }, svg);
    el('rect', { class: 'cd-runoff', x: vb.x, y: vb.y, width: vb.w, height: vb.h }, g);
    el('rect', {
      class: 'cd-surface', x: MARGIN, y: MARGIN, width: COURT_W, height: proj.half ? COURT_H / 2 : COURT_H,
    }, g);
    const lg = el('g', { class: 'cd-lines' }, g);
    lines.forEach((l) => el('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 }, lg));

    // Net: a textured band between two thin edge lines, plus posts.
    const ng = el('g', { class: 'cd-net' }, g);
    el('line', { class: 'cd-net-mesh', x1: netLine.x1, y1: netY, x2: netLine.x2, y2: netY }, ng);
    el('line', { class: 'cd-net-edge', x1: netLine.x1, y1: netY - 3.5, x2: netLine.x2, y2: netY - 3.5 }, ng);
    el('line', { class: 'cd-net-edge', x1: netLine.x1, y1: netY + 3.5, x2: netLine.x2, y2: netY + 3.5 }, ng);
    el('circle', { class: 'cd-net-post', cx: netLine.x1, cy: netY, r: 3.5 }, ng);
    el('circle', { class: 'cd-net-post', cx: netLine.x2, cy: netY, r: 3.5 }, ng);
  }

  function drawEquipment(svg, E) {
    if (!E.length) return;
    const g = el('g', { class: 'cd-equipment' }, svg);
    E.forEach((e) => {
      let transform = 'translate(' + fmt(e.cx) + ' ' + fmt(e.cy) + ')';
      if (e.rotate) transform += ' rotate(' + fmt(e.rotate) + ')';
      const t = el('g', { class: 'cd-eq cd-eq--' + e.kind, transform, 'data-type': e.type || null }, g);
      switch (e.kind) {
        case 'cone':
          el('path', { d: 'M0 -8 L7.5 6 L-7.5 6 Z' }, t);
          break;
        case 'target':
          el('circle', { r: 11 }, t);
          break;
        case 'throwdown':
          el('rect', { x: -11, y: -2.5, width: 22, height: 5, rx: 2 }, t);
          break;
        case 'basket':
          el('rect', { x: -9, y: -5, width: 18, height: 12, rx: 2 }, t);
          el('path', { class: 'cd-basket-handle', d: 'M-6 -5 A6 5 0 0 1 6 -5' }, t);
          break;
        case 'machine':
          el('rect', { x: -11, y: -8, width: 22, height: 16, rx: 3 }, t);
          el('circle', { class: 'cd-machine-wheel', cy: -1, r: 4 }, t);
          break;
        case 'ladder':
          el('rect', { x: -32, y: -6, width: 64, height: 12 }, t);
          [-16, 0, 16].forEach((x) => el('line', { x1: x, y1: -6, x2: x, y2: 6 }, t));
          break;
        default:
          el('rect', { x: -6, y: -6, width: 12, height: 12 }, t);
      }
      if (e.label) {
        const txt = el('text', { class: 'cd-label cd-label--eq', 'text-anchor': 'middle', y: 22 }, t);
        txt.textContent = e.label;
      }
    });
  }

  function drawPaths(svg, segs, id, timeline) {
    if (!segs.length) return;
    const g = el('g', { class: 'cd-paths' }, svg);
    segs.forEach((s) => {
      let cls = 'cd-path cd-path--' + s.style;
      if (timeline && s.style === 'movement' && !s.mover) cls += ' cd-anim cd-a' + s.index;
      el('path', { class: cls, d: s.d, 'marker-end': 'url(#' + id + '-arrow)', 'data-step': s.group + 1 }, g);
    });
  }

  function drawPlayers(svg, P, labels, printMode, timeline) {
    if (!P.length) return;
    const labelOf = new Map();
    labels.forEach((l) => labelOf.set(l.player, l));
    const moverOf = new Map();
    if (timeline) timeline.movers.forEach((m, j) => moverOf.set(m.player, { m, j }));
    const g = el('g', { class: 'cd-players' }, svg);
    P.forEach((p) => {
      const mv = moverOf.get(p);
      const attrs = {
        class: 'cd-player' + (p.feeder ? ' cd-player--feeder' : '') + (mv ? ' cd-player--moving cd-anim cd-m' + mv.j : ''),
        'data-id': p.id,
      };
      // A moving player is positioned by its route (offset-path) instead of a
      // fixed translate; at rest it sits at the route's start, its home spot.
      if (mv) attrs.style = "offset-path:path('" + mv.m.d + "')";
      else attrs.transform = 'translate(' + fmt(p.cx) + ' ' + fmt(p.cy) + ')';
      const t = el('g', attrs, g);
      el('circle', { r: PLAYER_R }, t);
      // In print there is no fill to tell the feeder apart, so add a second ring.
      if (p.feeder && printMode) el('circle', { class: 'cd-player-ring', r: PLAYER_R + 3.5 }, t);
      const txt = el('text', { class: 'cd-id', 'text-anchor': 'middle', dy: '0.36em' }, t);
      if (p.id.length > 3) txt.setAttribute('font-size', p.id.length > 4 ? '7.5' : '9');
      txt.textContent = p.id;
      // The label lives inside the group so it rides along with a moving player.
      const l = labelOf.get(p);
      if (l) {
        const lt = el('text', { class: 'cd-label', x: fmt(l.x - p.cx), y: fmt(l.y - p.cy), 'text-anchor': l.anchor }, t);
        lt.textContent = l.text;
      }
    });
  }

  function drawBalls(svg, segs) {
    const flying = segs.filter((s) => s.style === 'ball' || s.style === 'feed');
    if (!flying.length) return;
    const g = el('g', { class: 'cd-balls' }, svg);
    flying.forEach((s) => {
      el('circle', {
        class: 'cd-ball cd-anim cd-b' + s.index,
        r: BALL_R,
        style: "offset-path:path('" + s.d + "')",
      }, g);
    });
  }

  // ── Text ─────────────────────────────────────────────────────────────────
  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function countBy(list, key, nameFor) {
    const counts = new Map();
    list.forEach((item) => counts.set(item[key], (counts.get(item[key]) || 0) + 1));
    const parts = [];
    counts.forEach((n, k) => parts.push(plural(n, nameFor(k))));
    return parts.join(', ');
  }

  function buildTitle(d, players, equipment, paths, half, timeline) {
    const name = typeof d.title === 'string' ? d.title.trim() : (typeof d.name === 'string' ? d.name.trim() : '');
    const bits = [(name ? name + ' — ' : '') + (half ? 'Half-court' : 'Full-court') + ' drill diagram'];
    if (players.length) {
      bits.push(plural(players.length, 'player') + ': ' + players.map((p) => p.label ? p.id + ' (' + p.label + ')' : p.id).join(', '));
    } else {
      bits.push('no players');
    }
    if (equipment.length) bits.push(countBy(equipment, 'kind', (k) => k === 'unknown' ? 'other item' : k));
    if (paths.length) bits.push(countBy(paths, 'style', (k) => k + ' path'));
    if (timeline) bits.push('Animated in ' + plural(timeline.stepCount, 'step') + ', looping');
    return bits.join('. ') + '.';
  }

  // ── Palette + styles ─────────────────────────────────────────────────────
  function palette(printMode) {
    if (printMode) {
      return {
        runoff: '#ffffff', surface: '#ffffff', line: '#000000', net: '#000000',
        player: '#ffffff', playerStroke: '#000000', playerText: '#000000',
        feeder: '#ffffff', feederStroke: '#000000', feederText: '#000000',
        label: '#000000', halo: '#ffffff',
        ball: '#000000', ballStroke: '#000000', movement: '#000000', feed: '#000000',
        cone: '#ffffff', coneStroke: '#000000', target: '#000000',
        throwdown: '#000000', basket: '#ffffff', basketStroke: '#000000', unknown: '#000000',
      };
    }
    return {
      runoff: 'var(--cd-runoff, #244a3a)',
      surface: 'var(--cd-surface, #3a7a5b)',
      line: 'var(--cd-line, #f7f3e8)',
      net: 'var(--cd-net, #ece7d8)',
      player: 'var(--cd-player, #57268b)',
      playerStroke: 'var(--cd-player-stroke, #f7f3e8)',
      playerText: 'var(--cd-player-text, #ffffff)',
      feeder: 'var(--cd-feeder, #e8cf86)',
      feederStroke: 'var(--cd-feeder-stroke, #3d2d05)',
      feederText: 'var(--cd-feeder-text, #1d1a12)',
      label: 'var(--cd-label, #f7f3e8)',
      halo: 'var(--cd-halo, #1e3d30)',
      ball: 'var(--cd-ball, #dff25e)',
      ballStroke: 'var(--cd-ball-stroke, #1d1a12)',
      movement: 'var(--cd-movement, #f7f3e8)',
      feed: 'var(--cd-feed, #dff25e)',
      cone: 'var(--cd-cone, #f28c28)',
      coneStroke: 'var(--cd-cone-stroke, #1d1a12)',
      target: 'var(--cd-target, #f7f3e8)',
      throwdown: 'var(--cd-throwdown, #f7f3e8)',
      basket: 'var(--cd-basket, #9fb3bf)',
      basketStroke: 'var(--cd-basket-stroke, #1d1a12)',
      unknown: 'var(--cd-unknown, #f7f3e8)',
    };
  }

  function styleText(id, c, printMode) {
    const s = '#' + id;
    const font = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    return [
      s + '{font-family:' + font + ';display:block;max-width:100%;height:auto}',
      s + ' .cd-runoff{fill:' + c.runoff + '}',
      s + ' .cd-surface{fill:' + c.surface + (printMode ? ';stroke:none' : '') + '}',
      s + ' .cd-lines line{stroke:' + c.line + ';stroke-width:' + LINE_W + ';fill:none;shape-rendering:crispEdges}',
      s + ' .cd-net line{fill:none;stroke:' + c.net + '}',
      s + ' .cd-net-mesh{stroke-width:7;stroke-dasharray:2 2;opacity:' + (printMode ? '.6' : '.75') + '}',
      s + ' .cd-net-edge{stroke-width:1.5}',
      s + ' .cd-net-post{fill:' + c.net + '}',
      s + ' .cd-path{fill:none;stroke-width:' + LINE_W + ';stroke-linecap:round;stroke-linejoin:round}',
      s + ' .cd-path--ball{stroke:' + c.ball + '}',
      s + ' .cd-path--movement{stroke:' + c.movement + ';stroke-dasharray:7 5}',
      s + ' .cd-path--feed{stroke:' + c.feed + ';stroke-dasharray:0.5 5}',
      // Arrowheads borrow the colour of whichever line they sit on. The first
      // declaration is the fallback for engines without context-stroke.
      s + ' .cd-arrow{stroke:none;fill:' + c.ball + ';fill:context-stroke}',
      s + ' .cd-player circle{fill:' + c.player + ';stroke:' + c.playerStroke + ';stroke-width:2}',
      s + ' .cd-player--feeder circle{fill:' + c.feeder + ';stroke:' + c.feederStroke + '}',
      s + ' .cd-player--moving{offset-rotate:0deg}',
      s + ' .cd-player-ring{fill:none !important;stroke-dasharray:3 2.5;stroke-width:1.5 !important}',
      s + ' .cd-id{font-size:11px;font-weight:700;fill:' + c.playerText + ';pointer-events:none}',
      s + ' .cd-player--feeder .cd-id{fill:' + c.feederText + '}',
      s + ' .cd-label{font-size:' + LABEL_FONT + 'px;font-weight:600;fill:' + c.label + ';paint-order:stroke;stroke:' + c.halo + ';stroke-width:3px;stroke-linejoin:round}',
      s + ' .cd-label--eq{font-size:9px}',
      s + ' .cd-ball{fill:' + c.ball + ';stroke:' + c.ballStroke + ';stroke-width:1;offset-rotate:0deg;opacity:0;pointer-events:none}',
      s + ' .cd-eq--cone path{fill:' + c.cone + ';stroke:' + c.coneStroke + ';stroke-width:1.2;stroke-linejoin:round}',
      s + ' .cd-eq--target circle{fill:none;stroke:' + c.target + ';stroke-width:2.5}',
      s + ' .cd-eq--throwdown rect{fill:' + c.throwdown + '}',
      s + ' .cd-eq--basket rect{fill:' + c.basket + ';stroke:' + c.basketStroke + ';stroke-width:1.2}',
      s + ' .cd-basket-handle{fill:none;stroke:' + c.basketStroke + ';stroke-width:1.5}',
      s + ' .cd-eq--machine rect{fill:' + c.basket + ';stroke:' + c.basketStroke + ';stroke-width:1.2}',
      s + ' .cd-machine-wheel{fill:none;stroke:' + c.basketStroke + ';stroke-width:1.5}',
      s + ' .cd-eq--ladder rect,' + s + ' .cd-eq--ladder line{fill:none;stroke:' + c.throwdown + ';stroke-width:1.5}',
      s + ' .cd-eq--unknown rect{fill:none;stroke:' + c.unknown + ';stroke-width:2}',
    ].join('\n');
  }

  // ── Export ───────────────────────────────────────────────────────────────
  global.renderCourtDiagram = renderCourtDiagram;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { renderCourtDiagram };
  }
})(typeof window !== 'undefined' ? window : globalThis);
