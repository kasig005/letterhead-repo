-- 0003_store_google_token_rpc.sql
--
-- The client needs to save its Google refresh token, but google_tokens has no
-- SELECT policy (by design — not even the owner may read the token back), and a
-- direct client-side upsert that sets user_id itself trips the INSERT WITH CHECK.
--
-- This SECURITY DEFINER function lets an authenticated user store *their own*
-- token without widening table access: user_id is taken from auth.uid() on the
-- server, never from the caller, and the function is the only new surface area.

create or replace function public.store_google_token(p_refresh_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_refresh_token is null or length(trim(p_refresh_token)) = 0 then
    raise exception 'refresh token is required';
  end if;

  insert into public.google_tokens (user_id, refresh_token, updated_at)
  values (auth.uid(), p_refresh_token, now())
  on conflict (user_id) do update
    set refresh_token = excluded.refresh_token,
        updated_at    = now();
end;
$$;

revoke all on function public.store_google_token(text) from public, anon;
grant execute on function public.store_google_token(text) to authenticated;
