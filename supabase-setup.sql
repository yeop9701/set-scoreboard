-- ════════════════════════════════════════════════════════════
-- 세트 스코어보드 — Supabase 준비 스크립트
--
-- Supabase 대시보드 → 왼쪽 메뉴 SQL Editor → New query 에
-- 이 파일 전체를 붙여넣고 Run 을 누르면 끝난다. 한 번만 하면 된다.
--
-- 보안 설계
--   앱은 공개된 정적 사이트라 anon 키가 소스에 그대로 노출된다.
--   그래서 키만으로는 아무것도 못 하게 만든다.
--     1. entries 테이블은 RLS를 켜고 정책을 하나도 만들지 않는다.
--        → anon/authenticated 의 직접 접근은 전부 거부된다.
--     2. 유일한 통로는 아래 security definer 함수 세 개이고,
--        모두 방 코드(p_room)를 인자로 요구한다.
--     3. 방 코드는 128비트 난수이며 소스에 들어가지 않는다.
--        앱이 만들어 초대 링크(#r=…)로만 전달한다.
--   즉 초대 링크를 받지 않은 사람은 키를 알아도 읽지 못한다.
-- ════════════════════════════════════════════════════════════

create table if not exists public.entries (
  room       text        not null check (length(room) >= 32),
  path       text        not null check (length(path) between 1 and 200),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (room, path)
);

-- 직접 접근 전면 차단
alter table public.entries enable row level security;
revoke all on public.entries from anon, authenticated;

-- ── 통로 1: 방의 모든 문서 읽기 ──────────────────────────────
create or replace function public.sb_list(p_room text)
returns table (path text, data jsonb)
language sql
security definer
set search_path = public
as $$
  select e.path, e.data
  from public.entries e
  where length(p_room) >= 32 and e.room = p_room;
$$;

-- ── 통로 2: 문서 하나 저장(있으면 덮어쓰기) ──────────────────
create or replace function public.sb_put(p_room text, p_path text, p_data jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.entries (room, path, data, updated_at)
  select p_room, p_path, p_data, now()
  where length(p_room) >= 32
  on conflict (room, path)
  do update set data = excluded.data, updated_at = now();
$$;

-- ── 통로 3: 문서 하나 삭제 ───────────────────────────────────
create or replace function public.sb_del(p_room text, p_path text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.entries
  where length(p_room) >= 32 and room = p_room and path = p_path;
$$;

grant execute on function public.sb_list(text)              to anon, authenticated;
grant execute on function public.sb_put(text, text, jsonb)  to anon, authenticated;
grant execute on function public.sb_del(text, text)         to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- 실행 후 확인
--   아래를 실행했을 때 빈 결과가 나오면 정상이다(에러가 아니어야 한다).
--     select * from public.sb_list(repeat('0', 32));
--
-- 그 다음 Project Settings → API 에서 두 값을 workout.html 의
-- SUPABASE_URL / SUPABASE_ANON_KEY 에 넣고 node build.js 를 돌린다.
--   · Project URL       → SUPABASE_URL
--   · anon public 키    → SUPABASE_ANON_KEY
-- service_role 키는 절대 쓰지 말 것. 그건 모든 권한을 가진 비밀키다.
-- ════════════════════════════════════════════════════════════
