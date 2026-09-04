-- DRAFT — not applied. The drills library table the generation prompt writes
-- into. Review, then run in the PracticePal Supabase project's SQL editor
-- (tfnlygofikamyoscdrik). Enum values are enforced with CHECK constraints so
-- the closed sets in GENERATION-PROMPT.md and validate_drills.py are the
-- only values that can land.

create table if not exists public.drills (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  summary         text not null,
  skill_focus     text[] not null,
  levels          text[] not null,
  age_groups      text[] not null,
  court_space     text not null,
  intensity       text not null,
  players_min     smallint not null check (players_min >= 1),
  players_max     smallint not null check (players_max >= players_min),
  duration_min    smallint not null check (duration_min >= 1),
  duration_max    smallint not null check (duration_max >= duration_min),
  equipment       text[] not null default '{}',
  setup           text not null,
  instructions    text[] not null,
  coaching_points text[] not null,
  progressions    text[] not null,
  regressions     text[] not null,
  court_diagram   jsonb,
  source          text not null default 'generated',
  is_vetted       boolean not null default false,
  diagram_ok      boolean,            -- from diagram-review.html
  diagram_note    text,
  created_at      timestamptz not null default now(),
  constraint drills_skill_focus_check check (
    skill_focus <@ array['forehand','backhand','serve','return','volley','overhead','movement','tactical','conditioning','warmup','cooldown','games']::text[]
    and cardinality(skill_focus) > 0),
  constraint drills_levels_check check (
    levels <@ array['beginner','improver','intermediate','advanced']::text[] and cardinality(levels) > 0),
  constraint drills_age_groups_check check (
    age_groups <@ array['mini_red','mini_orange','mini_green','junior','adult']::text[] and cardinality(age_groups) > 0),
  constraint drills_court_space_check check (
    court_space in ('full_court','half_court','service_boxes','cross_court_channel','baseline_only','net_area','off_court')),
  constraint drills_intensity_check check (intensity in ('low','medium','high')),
  constraint drills_diagram_check check (court_space = 'off_court' or court_diagram is not null)
);

create index if not exists drills_skill_focus_idx on public.drills using gin (skill_focus);
create index if not exists drills_levels_idx on public.drills using gin (levels);
create index if not exists drills_vetted_idx on public.drills (is_vetted) where is_vetted;

alter table public.drills enable row level security;
-- The app only ever reads vetted drills; writes happen from the SQL editor /
-- service role (same pattern as practicepal_generations).
create policy "read vetted drills" on public.drills
  for select to anon, authenticated using (is_vetted);
