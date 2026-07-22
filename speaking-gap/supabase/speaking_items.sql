create table if not exists public.speaking_items (
  id uuid primary key default gen_random_uuid(),
  situation text not null,
  wanted_ko text default '',
  actual_attempt text default '',
  target_expression text not null,
  concise_expression text default '',
  alternatives jsonb not null default '[]'::jsonb,
  follow_up_question text default '',
  tags jsonb not null default '[]'::jsonb,
  level integer not null default 0,
  due_at timestamptz not null default now(),
  review_count integer not null default 0,
  last_grade text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists speaking_items_due_at_idx on public.speaking_items (due_at);
create index if not exists speaking_items_created_at_idx on public.speaking_items (created_at desc);
