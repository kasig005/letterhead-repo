-- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- companies (each user's outreach list)
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text not null default '',
  contact_name text not null default '',
  contact_email text not null default '',
  role text not null default '',
  status text not null default 'pending' check (status in ('pending','creating','drafted','error')),
  error text,
  draft_id text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index companies_user_id_idx on public.companies(user_id);

-- one message template per user
create table public.templates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subject text not null default '',
  body text not null default '',
  your_name text not null default '',
  updated_at timestamptz not null default now()
);

-- CV file metadata (bytes live in storage)
create table public.cv_files (
  user_id uuid primary key references auth.users(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size bigint not null,
  storage_path text not null,
  uploaded_at timestamptz not null default now()
);

-- Google OAuth refresh tokens - written by the user's own session, never read by it.
-- Only the service role (used inside the Edge Function) can select from this table.
create table public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.templates enable row level security;
alter table public.cv_files enable row level security;
alter table public.google_tokens enable row level security;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "companies_all_own" on public.companies for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "templates_all_own" on public.templates for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cv_files_all_own" on public.cv_files for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- google_tokens: insert/update only, no select policy at all for client roles
create policy "google_tokens_insert_own" on public.google_tokens for insert with check (auth.uid() = user_id);
create policy "google_tokens_update_own" on public.google_tokens for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- auto-provision a profile + starter template when someone signs up
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));

  insert into public.templates (user_id, subject, body, your_name)
  values (
    new.id,
    'Interested in {{role}} at {{company}}',
    E'Hi {{contactFirstName}},\n\nI''m reaching out about the {{role}} role at {{company}}. I''ve attached my CV, and I''d welcome the chance to talk about how I could contribute to your team.\n\nThanks for your time,\n{{yourName}}',
    ''
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
