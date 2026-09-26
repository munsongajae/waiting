-- =========================================================
-- 그리운보리밥 웨이팅 — Supabase 데이터베이스 설정
--
-- 사용법: Supabase 대시보드 → SQL Editor → New query →
--         이 파일 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다. 앱을 업데이트할 때도 다시 실행하면 됩니다.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;

-- 외부(API)에 공개되지 않는 내부용 스키마
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;


-- ---------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------

create or replace function private.kst_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;

-- 로그인 계정별 역할: owner(사장님) / staff(카운터 태블릿) / kiosk(입구 태블릿)
create table if not exists public.members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'staff', 'kiosk')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  store_name       text not null default '그리운보리밥',
  minutes_per_team int  not null default 5,      -- 데이터가 부족할 때 쓰는 팀당 예상 시간
  auto_estimate    boolean not null default true, -- 최근 입장 속도로 예상 시간 자동 계산
  paused           boolean not null default false,
  max_teams        int  not null default 0,      -- 대기 팀이 이 수 이상이면 접수 마감 (0 = 제한 없음)
  close_time       time,                         -- 이 시각부터 접수 마감 (비우면 없음)
  noshow_minutes   int  not null default 5,      -- 호출 후 이 시간이 지나면 노쇼 경고
  sms_enabled      boolean not null default false,
  sms_from         text not null default '',
  site_url         text not null default '',     -- 순서 확인 링크에 쓰는 사이트 주소
  soon_count       int  not null default 0,      -- 앞 대기가 N팀 이하일 때 '곧 차례' 문자 (0 = 안 보냄)
  tpl_register     text not null default E'[{매장}] {번호}번 접수 (앞 {앞팀}팀)\n순서확인 {링크}',
  tpl_soon         text not null default '[{매장}] {번호}번 곧 입장 차례입니다. 매장 앞으로 와주세요.',
  tpl_call         text not null default '[{매장}] {번호}번 입장하실 차례입니다. {제한분}분 내 입구로 와주세요.'
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists private.secrets (
  id            int primary key default 1 check (id = 1),
  solapi_key    text,
  solapi_secret text
);

create table if not exists private.counters (
  day     date primary key,
  last_no int not null
);

-- 전화번호(phone)와 순서 확인 토큰(token)은 다음 날 0시에 지워지고, 나머지는 통계용으로 남습니다.
create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  day         date not null default private.kst_today(),
  no          int  not null,
  sort_key    double precision not null,  -- 대기 순서 ('순서 미루기' 때문에 번호와 다를 수 있음)
  adults      int  not null check (adults between 1 and 30),
  kids        int  not null default 0 check (kids between 0 and 30),
  phone       text,
  token       text unique,
  source      text not null default 'kiosk' check (source in ('kiosk', 'staff')),
  status      text not null default 'waiting'
              check (status in ('waiting', 'called', 'seated', 'canceled', 'noshow', 'expired')),
  canceled_by text check (canceled_by in ('customer', 'staff')),
  created_at  timestamptz not null default now(),
  called_at   timestamptz,
  call_count  int not null default 0,
  done_at     timestamptz,
  postponed   int not null default 0,
  soon_sent   boolean not null default false,
  unique (day, no)
);
create index if not exists entries_day_status on public.entries (day, status);

create table if not exists public.sms_log (
  id         bigint generated always as identity primary key,
  entry_id   uuid references public.entries (id) on delete cascade,
  kind       text not null,                    -- register | soon | call | test
  request_id bigint,
  status     text not null default 'queued',   -- queued | ok | fail
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists sms_log_entry on public.sms_log (entry_id);
create index if not exists sms_log_queued on public.sms_log (status) where status = 'queued';


-- ---------------------------------------------------------
-- 권한 (Row Level Security)
-- 데이터 변경은 모두 아래 함수(RPC)를 거치고, 테이블 직접 수정은 사장님 설정만 허용합니다.
-- ---------------------------------------------------------

create or replace function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m where m.user_id = auth.uid() and m.active
$$;

alter table public.members  enable row level security;
alter table public.settings enable row level security;
alter table public.entries  enable row level security;
alter table public.sms_log  enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using (user_id = auth.uid() or public.my_role() = 'owner');

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated
  using (public.my_role() is not null);

drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for update to authenticated
  using (public.my_role() = 'owner') with check (public.my_role() = 'owner');

drop policy if exists entries_read on public.entries;
create policy entries_read on public.entries for select to authenticated
  using (public.my_role() in ('owner', 'staff'));

drop policy if exists sms_log_read on public.sms_log;
create policy sms_log_read on public.sms_log for select to authenticated
  using (public.my_role() in ('owner', 'staff'));

-- 관리자 태블릿이 새 접수를 바로 받을 수 있도록 실시간 전송 대상에 추가
do $$
begin
  alter publication supabase_realtime add table public.entries;
exception when duplicate_object or undefined_object then null;
end $$;


-- ---------------------------------------------------------
-- 내부 함수
-- ---------------------------------------------------------

create or replace function private.require_role(variadic p_roles text[]) returns text
language plpgsql stable set search_path = '' as $$
declare
  r text := public.my_role();
begin
  if r is null or not (r = any (p_roles)) then
    raise exception '권한이 없습니다' using errcode = '42501';
  end if;
  return r;
end $$;

-- 지난 날짜의 전화번호·링크 삭제, 남은 대기는 만료 처리
create or replace function private.purge_old() returns void
language plpgsql set search_path = '' as $$
begin
  update public.entries
     set phone = null,
         token = null,
         status = case when status in ('waiting', 'called') then 'expired' else status end
   where day < private.kst_today()
     and (phone is not null or token is not null or status in ('waiting', 'called'));
  delete from public.sms_log where created_at < now() - interval '3 days';
  delete from private.counters where day < private.kst_today() - 1;
end $$;

create or replace function private.try_jsonb(t text) returns jsonb
language plpgsql immutable as $$
begin
  return t::jsonb;
exception when others then
  return null;
end $$;

-- 내 앞에 있는 대기 팀 수
create or replace function private.ahead(p_day date, p_sort double precision) returns int
language sql stable set search_path = '' as $$
  select count(*)::int from public.entries
   where day = p_day and status in ('waiting', 'called') and sort_key < p_sort
$$;

-- 팀당 예상 대기 시간(분): 최근 90분 동안 실제 입장 간격, 데이터가 부족하면 설정값
create or replace function private.minutes_per_team() returns int
language plpgsql stable set search_path = '' as $$
declare
  s public.settings;
  n int;
  span_min numeric;
begin
  select * into s from public.settings where id = 1;
  if s.auto_estimate then
    select count(*), extract(epoch from max(done_at) - min(done_at)) / 60
      into n, span_min
      from public.entries
     where day = private.kst_today() and status = 'seated' and done_at > now() - interval '90 minutes';
    if n >= 4 then
      return least(60, greatest(1, round(span_min / (n - 1))))::int;
    end if;
  end if;
  return s.minutes_per_team;
end $$;

-- 접수를 받을 수 없는 이유 (받을 수 있으면 null)
create or replace function private.closed_reason() returns text
language plpgsql stable set search_path = '' as $$
declare
  s public.settings;
  n int;
begin
  select * into s from public.settings where id = 1;
  if s.paused then
    return '지금은 웨이팅 접수를 잠시 받지 않습니다';
  end if;
  if s.close_time is not null and (now() at time zone 'Asia/Seoul')::time >= s.close_time then
    return '오늘 웨이팅 접수가 마감되었습니다';
  end if;
  if s.max_teams > 0 then
    select count(*) into n from public.entries
     where day = private.kst_today() and status in ('waiting', 'called');
    if n >= s.max_teams then
      return '대기 팀이 많아 접수를 잠시 마감했습니다';
    end if;
  end if;
  return null;
end $$;

create or replace function private.render(p_tpl text, e public.entries) returns text
language plpgsql stable set search_path = '' as $$
declare
  s public.settings;
  link text := '';
begin
  select * into s from public.settings where id = 1;
  if e.token is not null and s.site_url <> '' then
    link := rtrim(s.site_url, '/') || '/s/' || e.token;
  end if;
  return replace(replace(replace(replace(replace(replace(p_tpl,
    '{매장}', s.store_name),
    '{번호}', e.no::text),
    '{인원}', (e.adults + e.kids)::text),
    '{앞팀}', private.ahead(e.day, e.sort_key)::text),
    '{제한분}', s.noshow_minutes::text),
    '{링크}', link);
end $$;

-- 솔라피 문자 발송 요청. 실제 전송은 트랜잭션이 끝난 뒤 pg_net이 처리하고, 결과는 sync_sms()로 확인합니다.
create or replace function private.solapi_post(p_to text, p_text text) returns bigint
language plpgsql set search_path = '' as $$
declare
  s public.settings;
  k private.secrets;
  d text;
  salt text;
  sig text;
begin
  select * into s from public.settings where id = 1;
  select * into k from private.secrets where id = 1;
  if coalesce(k.solapi_key, '') = '' or coalesce(k.solapi_secret, '') = '' then
    raise exception '솔라피 API 키가 저장되어 있지 않습니다';
  end if;
  if s.sms_from = '' then
    raise exception '발신번호가 비어 있습니다. 문자 알림의 발신번호를 입력하고 설정 저장을 눌러 주세요';
  end if;
  d := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  salt := encode(extensions.gen_random_bytes(16), 'hex');
  sig := encode(extensions.hmac(d || salt, k.solapi_secret, 'sha256'), 'hex');
  return net.http_post(
    url := 'https://api.solapi.com/messages/v4/send',
    body := jsonb_build_object('message', jsonb_build_object('to', p_to, 'from', s.sms_from, 'text', p_text)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', format('HMAC-SHA256 apiKey=%s, date=%s, salt=%s, signature=%s', k.solapi_key, d, salt, sig)),
    timeout_milliseconds := 10000
  );
end $$;

-- p_kind: register | soon | call
create or replace function private.send_entry_sms(p_id uuid, p_kind text) returns void
language plpgsql set search_path = '' as $$
declare
  s public.settings;
  e public.entries;
  sent int;
begin
  select * into s from public.settings where id = 1;
  if not s.sms_enabled then return; end if;
  select * into e from public.entries where id = p_id;
  if e.phone is null then return; end if;

  -- 같은 번호로 하루 15건까지만 (오작동·악용으로 문자 요금이 쌓이는 것 방지)
  select count(*) into sent
    from public.sms_log l join public.entries x on x.id = l.entry_id
   where x.phone = e.phone and x.day = e.day;
  if sent >= 15 then
    insert into public.sms_log (entry_id, kind, status, error)
    values (p_id, p_kind, 'fail', '이 번호의 하루 문자 한도를 넘었습니다');
    return;
  end if;

  begin
    insert into public.sms_log (entry_id, kind, request_id)
    values (p_id, p_kind, private.solapi_post(e.phone, private.render(
      case p_kind when 'register' then s.tpl_register when 'soon' then s.tpl_soon else s.tpl_call end, e)));
  exception when others then
    insert into public.sms_log (entry_id, kind, status, error) values (p_id, p_kind, 'fail', sqlerrm);
  end;
end $$;

-- 앞 대기가 N팀 이하로 줄어든 손님에게 '곧 차례' 문자
create or replace function private.check_soon(p_day date) returns void
language plpgsql set search_path = '' as $$
declare
  s public.settings;
  r record;
begin
  select * into s from public.settings where id = 1;
  if s.soon_count <= 0 or not s.sms_enabled then return; end if;
  for r in
    select id, sort_key from public.entries
     where day = p_day and status = 'waiting' and not soon_sent and phone is not null
     order by sort_key
  loop
    exit when private.ahead(p_day, r.sort_key) > s.soon_count;
    update public.entries set soon_sent = true where id = r.id;
    perform private.send_entry_sms(r.id, 'soon');
  end loop;
end $$;

-- SQL Editor에서 계정에 역할을 줄 때 사용: select private.assign_role('이메일', 'owner');
create or replace function private.assign_role(p_email text, p_role text) returns text
language plpgsql set search_path = '' as $$
begin
  insert into public.members (user_id, role)
  select id, p_role from auth.users where lower(email) = lower(p_email)
  on conflict (user_id) do update set role = excluded.role, active = true;
  if not found then
    raise exception '% 계정이 없습니다. Authentication → Users 에서 먼저 만들어 주세요', p_email;
  end if;
  return p_email || ' → ' || p_role;
end $$;


-- ---------------------------------------------------------
-- 입구·관리자 태블릿용 함수
-- ---------------------------------------------------------

create or replace function public.queue_summary() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.settings;
  n int;
  calling jsonb;
begin
  perform private.require_role('owner', 'staff', 'kiosk');
  perform private.purge_old();
  select * into s from public.settings where id = 1;
  select count(*) into n from public.entries
   where day = private.kst_today() and status in ('waiting', 'called');
  select coalesce(jsonb_agg(c.no order by c.called_at desc), '[]'::jsonb) into calling
    from (select no, called_at from public.entries
           where day = private.kst_today() and status = 'called'
           order by called_at desc limit 4) c;
  return jsonb_build_object(
    'store_name', s.store_name,
    'waiting', n,
    'est_minutes', n * private.minutes_per_team(),
    'calling', calling,
    'closed', private.closed_reason(),
    'sms_enabled', s.sms_enabled
  );
end $$;

-- 웨이팅 접수. 입구 태블릿은 전화번호 필수, 관리자는 번호 없이도 등록 가능
create or replace function public.register_entry(p_adults int, p_kids int, p_phone text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r text;
  d date := private.kst_today();
  reason text;
  dup int;
  v_no int;
  e public.entries;
  s public.settings;
  n_ahead int;
begin
  r := private.require_role('owner', 'staff', 'kiosk');
  p_phone := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');

  if p_phone is not null and p_phone !~ '^01[016789][0-9]{7,8}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone');
  end if;
  if p_phone is null and r = 'kiosk' then
    return jsonb_build_object('ok', false, 'error', 'phone_required');
  end if;
  if p_adults is null or p_adults < 1 or p_adults > 30 or coalesce(p_kids, 0) < 0 or p_kids > 30 then
    return jsonb_build_object('ok', false, 'error', 'invalid_party');
  end if;
  if r = 'kiosk' then
    reason := private.closed_reason();
    if reason is not null then
      return jsonb_build_object('ok', false, 'error', 'closed', 'message', reason);
    end if;
  end if;
  if p_phone is not null then
    select no into dup from public.entries
     where day = d and phone = p_phone and status in ('waiting', 'called') limit 1;
    if found then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'no', dup);
    end if;
  end if;

  insert into private.counters as c (day, last_no) values (d, 1)
  on conflict (day) do update set last_no = c.last_no + 1
  returning last_no into v_no;

  insert into public.entries (day, no, sort_key, adults, kids, phone, token, source)
  values (d, v_no, v_no, p_adults, coalesce(p_kids, 0), p_phone,
          case when p_phone is not null
               then translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/', 'kq') end,
          case when r = 'kiosk' then 'kiosk' else 'staff' end)
  returning * into e;

  select * into s from public.settings where id = 1;
  n_ahead := private.ahead(d, e.sort_key);
  -- 접수 문자에 앞 팀 수가 이미 들어가므로, 처음부터 조건을 만족하면 '곧 차례' 문자는 생략
  if s.soon_count > 0 and n_ahead <= s.soon_count then
    update public.entries set soon_sent = true where id = e.id;
  end if;
  perform private.send_entry_sms(e.id, 'register');

  return jsonb_build_object(
    'ok', true, 'id', e.id, 'no', e.no, 'ahead', n_ahead,
    'est_minutes', n_ahead * private.minutes_per_team(),
    'sms', s.sms_enabled and p_phone is not null
  );
end $$;

-- p_action: call | seat | cancel | noshow | restore
create or replace function public.entry_action(p_id uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.entries;
begin
  perform private.require_role('owner', 'staff');
  select * into e from public.entries where id = p_id for update;
  if not found then
    raise exception '대기 정보를 찾을 수 없습니다';
  end if;

  if p_action in ('call', 'seat', 'cancel', 'noshow') and e.status not in ('waiting', 'called') then
    raise exception '이미 처리된 손님입니다';
  end if;

  if p_action = 'call' then
    update public.entries
       set status = 'called', call_count = call_count + 1, called_at = now(), soon_sent = true
     where id = p_id;
    perform private.send_entry_sms(p_id, 'call');
  elsif p_action in ('seat', 'cancel', 'noshow') then
    update public.entries
       set status = case p_action when 'seat' then 'seated' when 'cancel' then 'canceled' else 'noshow' end,
           canceled_by = case when p_action = 'cancel' then 'staff' end,
           done_at = now()
     where id = p_id;
    perform private.check_soon(e.day);
  elsif p_action = 'restore' then
    if e.day <> private.kst_today() or e.status = 'expired' then
      raise exception '지난 기록은 되돌릴 수 없습니다';
    end if;
    update public.entries
       set status = case when call_count > 0 then 'called' else 'waiting' end,
           done_at = null, canceled_by = null
     where id = p_id;
  else
    raise exception '알 수 없는 동작입니다: %', p_action;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_paused(p_paused boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('owner', 'staff');
  update public.settings set paused = p_paused where id = 1;
end $$;

-- 대기 중인 문자 발송 결과를 확인해 sms_log에 반영
create or replace function public.sync_sms() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('owner', 'staff');
  with res as (
    select l.id, r.status_code, r.timed_out, r.error_msg, private.try_jsonb(r.content) as j
      from public.sms_log l
      join net._http_response r on r.id = l.request_id
     where l.status = 'queued'
  ), judged as (
    select res.*, (status_code between 200 and 299 and coalesce(j->>'statusCode', '2000') like '2%') as success
      from res
  )
  update public.sms_log l
     set status = case when judged.success then 'ok' else 'fail' end,
         error = case when judged.success then null
                      else coalesce(judged.j->>'errorMessage', judged.j->>'statusMessage', judged.error_msg,
                                    case when judged.timed_out then '응답 시간 초과' end,
                                    'HTTP ' || judged.status_code) end
    from judged
   where l.id = judged.id;

  update public.sms_log
     set status = 'fail', error = '발송 결과를 확인하지 못했습니다'
   where status = 'queued' and created_at < now() - interval '3 minutes';
end $$;


-- ---------------------------------------------------------
-- 사장님 전용 함수
-- ---------------------------------------------------------

create or replace function public.set_sms_keys(p_key text, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('owner');
  insert into private.secrets (id, solapi_key, solapi_secret)
  values (1, nullif(trim(p_key), ''), nullif(trim(p_secret), ''))
  on conflict (id) do update set solapi_key = excluded.solapi_key, solapi_secret = excluded.solapi_secret;
end $$;

-- 저장된 키는 다시 보여주지 않고, 앞 4자리만 확인용으로 반환
create or replace function public.sms_key_info() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k private.secrets;
begin
  perform private.require_role('owner');
  select * into k from private.secrets where id = 1;
  return jsonb_build_object(
    'configured', coalesce(k.solapi_key, '') <> '' and coalesce(k.solapi_secret, '') <> '',
    'key_hint', case when coalesce(k.solapi_key, '') <> '' then left(k.solapi_key, 4) || '••••' end
  );
end $$;

create or replace function public.send_test_sms(p_phone text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  s public.settings;
  v_id bigint;
begin
  perform private.require_role('owner');
  p_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if p_phone !~ '^01[016789][0-9]{7,8}$' then
    raise exception '휴대폰 번호를 정확히 입력해 주세요';
  end if;
  select * into s from public.settings where id = 1;
  insert into public.sms_log (kind, request_id)
  values ('test', private.solapi_post(p_phone, '[' || s.store_name || '] 웨이팅 문자 테스트입니다.'))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.list_accounts()
returns table (user_id uuid, email text, role text, active boolean, last_sign_in_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('owner');
  return query
    select u.id, u.email::text, m.role, coalesce(m.active, false), u.last_sign_in_at
      from auth.users u left join public.members m on m.user_id = u.id
     order by u.created_at;
end $$;

-- p_role이 null이면 권한 삭제
create or replace function public.set_account(p_user uuid, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role('owner');
  if p_user = auth.uid() and (p_role is distinct from 'owner' or not p_active) then
    raise exception '지금 로그인한 사장님 계정의 권한은 끌 수 없습니다';
  end if;
  if p_role is null then
    delete from public.members where user_id = p_user;
  else
    insert into public.members (user_id, role, active) values (p_user, p_role, p_active)
    on conflict (user_id) do update set role = excluded.role, active = excluded.active;
  end if;
end $$;

create or replace function public.stats(p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  res jsonb;
begin
  perform private.require_role('owner');
  with base as (
    select e.*,
           extract(epoch from e.done_at - e.created_at) / 60 as wait_min,
           extract(epoch from e.done_at - e.called_at) / 60 as arrive_min,
           extract(isodow from e.created_at at time zone 'Asia/Seoul')::int as dow,
           extract(hour from e.created_at at time zone 'Asia/Seoul')::int as hr
      from public.entries e
     where e.day between p_from and p_to
  )
  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'teams', count(*),
        'people', coalesce(sum(adults + kids), 0),
        'seated', count(*) filter (where status = 'seated'),
        'noshow', count(*) filter (where status = 'noshow'),
        'canceled', count(*) filter (where status = 'canceled'),
        'avg_wait', round(avg(wait_min) filter (where status = 'seated')),
        'max_wait', round(max(wait_min) filter (where status = 'seated')),
        'avg_arrive', round((avg(arrive_min) filter (where status = 'seated' and called_at is not null))::numeric, 1)
      ) from base),
    'daily', (
      select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
        select day, count(*) as teams,
               count(*) filter (where status = 'seated') as seated,
               count(*) filter (where status = 'noshow') as noshow,
               round(avg(wait_min) filter (where status = 'seated')) as avg_wait
          from base group by day) x),
    'hourly', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select dow, hr, count(*) as teams,
               round(avg(wait_min) filter (where status = 'seated')) as avg_wait
          from base group by dow, hr) x),
    'party', (
      select coalesce(jsonb_agg(x order by x.size), '[]'::jsonb) from (
        select least(adults + kids, 5) as size, count(*) as teams,
               count(*) filter (where status = 'noshow') as noshow,
               round(avg(wait_min) filter (where status = 'seated')) as avg_wait
          from base group by 1) x)
  ) into res;
  return res;
end $$;


-- ---------------------------------------------------------
-- 손님 휴대폰(순서 확인 링크)용 함수 — 로그인 없이 링크 토큰으로만 접근
-- ---------------------------------------------------------

create or replace function public.entry_status(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.entries;
  s public.settings;
  n_ahead int;
  active bool;
begin
  if coalesce(length(p_token), 0) < 8 then return null; end if;
  select * into e from public.entries where token = p_token and day = private.kst_today();
  if not found then return null; end if;
  select * into s from public.settings where id = 1;
  active := e.status in ('waiting', 'called');
  n_ahead := case when active then private.ahead(e.day, e.sort_key) end;
  return jsonb_build_object(
    'store_name', s.store_name,
    'no', e.no,
    'status', e.status,
    'party', e.adults + e.kids,
    'ahead', n_ahead,
    'est_minutes', case when active then n_ahead * private.minutes_per_team() end,
    'noshow_minutes', s.noshow_minutes,
    'can_postpone', e.status = 'waiting' and e.postponed < 2 and exists (
      select 1 from public.entries x
       where x.day = e.day and x.status = 'waiting' and x.sort_key > e.sort_key)
  );
end $$;

create or replace function public.customer_cancel(p_token text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_day date;
begin
  if coalesce(length(p_token), 0) < 8 then return false; end if;
  update public.entries
     set status = 'canceled', canceled_by = 'customer', done_at = now()
   where token = p_token and day = private.kst_today() and status in ('waiting', 'called')
  returning day into v_day;
  if v_day is null then return false; end if;
  perform private.check_soon(v_day);
  return true;
end $$;

-- 바로 뒤 대기 팀과 순서를 바꿈 (최대 2번)
create or replace function public.customer_postpone(p_token text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  e public.entries;
  k1 double precision;
  k2 double precision;
begin
  if coalesce(length(p_token), 0) < 8 then return false; end if;
  select * into e from public.entries
   where token = p_token and day = private.kst_today() for update;
  if not found or e.status <> 'waiting' or e.postponed >= 2 then return false; end if;

  select sort_key into k1 from public.entries
   where day = e.day and status = 'waiting' and sort_key > e.sort_key
   order by sort_key limit 1;
  if k1 is null then return false; end if;
  select sort_key into k2 from public.entries
   where day = e.day and status in ('waiting', 'called') and sort_key > k1
   order by sort_key limit 1;

  -- 새 순서값은 항상 다음 정수보다 작게 유지 (앞으로 접수될 번호와 겹치지 않도록)
  update public.entries
     set sort_key = case when k2 is null then (k1 + floor(k1) + 1) / 2 else (k1 + k2) / 2 end,
         postponed = postponed + 1
   where id = e.id;
  perform private.check_soon(e.day);
  return true;
end $$;


-- ---------------------------------------------------------
-- 함수 실행 권한
-- ---------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.my_role(),
  public.queue_summary(),
  public.register_entry(int, int, text),
  public.entry_action(uuid, text),
  public.set_paused(boolean),
  public.sync_sms(),
  public.set_sms_keys(text, text),
  public.sms_key_info(),
  public.send_test_sms(text),
  public.list_accounts(),
  public.set_account(uuid, text, boolean),
  public.stats(date, date)
to authenticated;

grant execute on function
  public.entry_status(text),
  public.customer_cancel(text),
  public.customer_postpone(text)
to anon, authenticated;


-- ---------------------------------------------------------
-- 매일 0시 5분(한국 시간)에 전화번호 삭제 — pg_cron을 쓸 수 없으면 건너뜀
-- (쓸 수 없어도 다음 날 태블릿이 처음 켜질 때 자동으로 삭제됩니다)
-- ---------------------------------------------------------

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('waiting-nightly-purge', '5 15 * * *', 'select private.purge_old()');
exception when others then
  raise notice 'pg_cron 예약을 건너뜁니다: %', sqlerrm;
end $$;
