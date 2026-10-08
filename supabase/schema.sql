-- =====================================================================
-- 학교 캐릭터 공모전 투표 사이트 - 데이터베이스 설정 (Supabase)
-- ---------------------------------------------------------------------
-- 사용법
--   Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run.
--   여러 번 실행해도 안전하도록(재실행 안전) 작성했습니다.
--   - 표는 "없을 때만" 만들고, 정책·함수는 지우고 다시 만듭니다.
--   - 이미 들어 있는 데이터(작품, 학생, 하트, 댓글)는 지워지지 않습니다.
--
-- 전체 구조 한눈에 보기
--   settings  : 사이트 설정 1줄 (제목, 안내문, 투표 진행 여부)
--   secrets   : 관리자 가입 코드 같은 비밀 값 (브라우저에서 절대 읽을 수 없음)
--   admins    : 관리자(교사) 이메일 명단
--   students  : 로그인한 학생 프로필 (학교, 학번, 이름, 연결된 기기)
--   artworks  : 출품작 (제목, 출품자, 설명, 이미지 경로, 숨김 여부)
--   likes     : 하트(좋아요) 기록  - 작품 1개당 학생 1명 1번
--   comments  : 댓글 기록          - 작성자 이름은 저장할 때 이미 가려서(강*욱) 저장
--
-- 보안 원칙
--   1) 모든 표에 RLS(행 수준 보안)를 켜서, 정책으로 허락한 것만 읽고 쓸 수 있게 합니다.
--   2) 학생의 "쓰기"는 표에 직접 하지 못하고, 아래 4개 함수로만 할 수 있습니다.
--        claim_student / toggle_like / add_comment / delete_my_comment
--      함수 안에서 투표 기간, 본인 여부, 글자 수를 다시 검사합니다.
--      (브라우저 코드는 누구나 고칠 수 있으므로, 최종 검사는 반드시 DB에서 합니다.)
--   3) 관리자는 is_admin() 함수로 판정합니다.
--        admins 표에 이메일이 있고 + 익명(학생) 계정이 아닐 때만 관리자입니다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 준비: 비밀번호 확인에 쓰는 pgcrypto 확장 (Supabase에는 기본 설치되어 있음)
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. 표(테이블) 만들기
-- =====================================================================

-- 1-1. 사이트 설정: 항상 딱 1줄(id = 1)만 존재합니다.
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),   -- 1줄만 허용
  site_title  text not null default '캐릭터 공모전 투표',
  notice      text not null default '마음에 드는 작품에 하트를 눌러 주세요. 작품마다 1번씩 누를 수 있어요.',
  voting_open boolean not null default false,              -- true = 투표 진행 중
  updated_at  timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- 1-2. 비밀 값 보관함: 관리자 가입 코드 등.
--      RLS를 켜고 정책을 하나도 만들지 않으므로, 브라우저(anon/로그인 사용자)는 읽을 수 없습니다.
--      SECURITY DEFINER 함수 안에서만 읽습니다.
create table if not exists public.secrets (
  key   text primary key,
  value text not null
);
-- 기본 관리자 가입 코드 'sonline' (이미 바꿔 두었다면 덮어쓰지 않음)
insert into public.secrets (key, value) values ('admin_signup_code', 'sonline')
on conflict (key) do nothing;

-- 1-3. 관리자 가입 시도 기록: 가입 코드를 마구 대입해 보는 공격을 막는 데 사용
create table if not exists public.admin_signup_attempts (
  id         bigserial primary key,
  email      text,
  success    boolean not null,
  created_at timestamptz not null default now()
);

-- 1-4. 관리자(교사) 명단: 이메일은 항상 소문자로 저장
create table if not exists public.admins (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- 1-5. 학생 프로필
--      school_norm : 비교용으로 정리한 학교 이름 (띄어쓰기 제거, '고등학교'→'고', '중학교'→'중')
--      user_id     : 지금 이 학생과 연결된 기기(익명 로그인 계정). 다른 기기에서 로그인하면 바뀜.
create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  school        text not null,
  school_norm   text not null,
  student_no    text not null,
  name          text not null,
  user_id       uuid unique references auth.users (id) on delete set null,
  agreed_at     timestamptz not null default now(),       -- 개인정보 수집·이용 동의 시각
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);
-- 같은 (정리한 학교 이름, 학번)은 프로필 1개만! → 한 사람이 여러 번 투표하는 것을 DB가 막음
create unique index if not exists students_school_no_uniq
  on public.students (school_norm, student_no);

-- 1-6. 출품작
create table if not exists public.artworks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  author      text not null default '',                  -- 출품자 (화면에 그대로 보임)
  description text not null default '',
  image_path  text not null,                             -- Storage 'artworks' 버킷 안의 파일 경로
  is_hidden   boolean not null default false,            -- true면 학생 화면에서 안 보임
  created_at  timestamptz not null default now()
);

-- 1-7. 하트(좋아요): (작품, 학생) 쌍이 기본키 → 한 작품에 한 학생은 1번만
create table if not exists public.likes (
  artwork_id uuid not null references public.artworks (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (artwork_id, student_id)
);
create index if not exists likes_student_idx on public.likes (student_id);

-- 1-8. 댓글: author_masked 에는 '강*욱'처럼 이미 가린 이름만 저장합니다.
create table if not exists public.comments (
  id            uuid primary key default gen_random_uuid(),
  artwork_id    uuid not null references public.artworks (id) on delete cascade,
  student_id    uuid not null references public.students (id) on delete cascade,
  author_masked text not null,
  body          text not null check (char_length(body) between 1 and 200),
  is_hidden     boolean not null default false,          -- 관리자가 숨긴 댓글
  created_at    timestamptz not null default now()
);
create index if not exists comments_artwork_idx on public.comments (artwork_id, created_at);
create index if not exists comments_student_idx on public.comments (student_id);


-- =====================================================================
-- 2. 도우미 함수
-- =====================================================================

-- 2-1. 학교 이름 정리: 띄어쓰기를 모두 없애고, 끝의 '등학교' 또는 '학교'를 떼어 냅니다.
--      예) '서울 고등학교' → '서울고',  '서울고' → '서울고',  '한빛중학교' → '한빛중'
--          '새싹초등학교' → '새싹초',  '서울온라인학교' → '서울온라인'
create or replace function public.normalize_school(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
           lower(regexp_replace(coalesce(p, ''), '\s+', '', 'g')),
           '(등학교|학교)$', ''
         );
$$;

-- 2-2. 이름 가리기: 강현욱 → 강*욱, 김민 → 김*, 남궁민수 → 남**수, 한 글자 → *
create or replace function public.mask_name(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  n text := regexp_replace(coalesce(p, ''), '\s+', '', 'g');
  len int := char_length(n);
begin
  if len <= 1 then
    return '*';
  elsif len = 2 then
    return left(n, 1) || '*';
  else
    return left(n, 1) || repeat('*', len - 2) || right(n, 1);
  end if;
end;
$$;

-- 2-3. 관리자인가?
--      로그인 토큰(JWT)의 이메일이 admins 표에 있고, 익명 로그인(학생)이 아니어야 합니다.
--      SECURITY DEFINER: admins 표의 RLS와 상관없이 확인할 수 있게 함수 주인 권한으로 실행.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1 from public.admins a
      where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

-- 2-4. 지금 로그인한 기기에 연결된 학생 프로필 id (없으면 null)
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.students s where s.user_id = auth.uid();
$$;

-- 2-5. 투표가 진행 중인가?
create or replace function public.voting_is_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select voting_open from public.settings where id = 1), false);
$$;


-- =====================================================================
-- 3. RLS(행 수준 보안) 켜기 + 정책
--    정책은 "drop policy if exists → create policy" 순서로 만들어 재실행해도 안전합니다.
-- =====================================================================
alter table public.settings              enable row level security;
alter table public.secrets               enable row level security;
alter table public.admin_signup_attempts enable row level security;
alter table public.admins                enable row level security;
alter table public.students              enable row level security;
alter table public.artworks              enable row level security;
alter table public.likes                 enable row level security;
alter table public.comments              enable row level security;

-- 3-1. settings: 누구나 읽기(로그인 전에도 제목·안내문을 보여야 함), 수정은 관리자만
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings
  for select to anon, authenticated using (true);

drop policy if exists settings_admin_update on public.settings;
create policy settings_admin_update on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 3-2. secrets, admin_signup_attempts: 정책 없음 = 브라우저에서 접근 불가 (함수만 사용)

-- 3-3. admins: 관리자만 명단을 볼 수 있음. 추가/삭제는 함수로만.
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins
  for select to authenticated using (public.is_admin());

-- 3-4. students: 학생은 "내 프로필"만 볼 수 있고, 관리자는 전체 조회·수정·삭제.
--      학생이 직접 추가/수정하는 정책은 없음 → claim_student 함수로만 생성·연결.
drop policy if exists students_read_own on public.students;
create policy students_read_own on public.students
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists students_admin_update on public.students;
create policy students_admin_update on public.students
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists students_admin_delete on public.students;
create policy students_admin_delete on public.students
  for delete to authenticated using (public.is_admin());

-- 3-5. artworks: 숨기지 않은 작품은 누구나 보기, 관리자는 전부 보기·추가·수정·삭제
drop policy if exists artworks_read on public.artworks;
create policy artworks_read on public.artworks
  for select to anon, authenticated using (is_hidden = false or public.is_admin());

drop policy if exists artworks_admin_insert on public.artworks;
create policy artworks_admin_insert on public.artworks
  for insert to authenticated with check (public.is_admin());

drop policy if exists artworks_admin_update on public.artworks;
create policy artworks_admin_update on public.artworks
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists artworks_admin_delete on public.artworks;
create policy artworks_admin_delete on public.artworks
  for delete to authenticated using (public.is_admin());

-- 3-6. likes: 학생은 "내 하트"만 볼 수 있음(전체 개수는 get_artwork_stats 함수로만).
--      관리자는 전체 조회·삭제. 쓰기는 toggle_like 함수로만.
drop policy if exists likes_read on public.likes;
create policy likes_read on public.likes
  for select to authenticated
  using (student_id = public.current_student_id() or public.is_admin());

drop policy if exists likes_admin_delete on public.likes;
create policy likes_admin_delete on public.likes
  for delete to authenticated using (public.is_admin());

-- 3-7. comments: 표를 직접 읽는 것은 관리자만.
--      학생 화면은 list_comments 함수로 "가린 이름·내용·내 댓글 여부"만 받습니다.
--      (student_id 같은 내부 값이 다른 학생에게 전달되지 않도록)
drop policy if exists comments_admin_read on public.comments;
create policy comments_admin_read on public.comments
  for select to authenticated using (public.is_admin());

drop policy if exists comments_admin_update on public.comments;
create policy comments_admin_update on public.comments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists comments_admin_delete on public.comments;
create policy comments_admin_delete on public.comments
  for delete to authenticated using (public.is_admin());

-- 3-8. 표 권한(GRANT): RLS 정책과 함께 "어떤 역할이 어떤 동작을 시도할 수 있는지" 정합니다.
--      실제로 어떤 줄에 허용되는지는 위의 RLS 정책이 결정합니다.
revoke all on public.secrets, public.admin_signup_attempts from anon, authenticated;
grant select on public.settings, public.artworks to anon;
grant select, update on public.settings to authenticated;
grant select on public.admins to authenticated;
grant select, update, delete on public.students to authenticated;
grant select, insert, update, delete on public.artworks to authenticated;
grant select, delete on public.likes to authenticated;
grant select, update, delete on public.comments to authenticated;
revoke insert on public.students, public.likes, public.comments from anon, authenticated;


-- =====================================================================
-- 4. 학생용 함수 (SECURITY DEFINER = 함수 주인 권한으로 실행, 안에서 직접 검사)
-- =====================================================================

-- 4-1. claim_student: 학교·학번·이름으로 학생 프로필을 만들거나, 기존 프로필을 이 기기에 연결
--      - 같은 (정리한 학교, 학번)이 없으면 새로 만듦
--      - 있으면 이름이 같은지 확인 → 다르면 거부(학번 도용 방지)
--      - 이름이 같으면 이 기기로 연결을 옮김 → 이전 기기는 더 이상 투표 불가
drop function if exists public.claim_student(text, text, text, boolean);
create function public.claim_student(
  p_school     text,
  p_student_no text,
  p_name       text,
  p_agree      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_school text := btrim(regexp_replace(coalesce(p_school, ''), '\s+', ' ', 'g'));
  v_norm   text := public.normalize_school(p_school);
  v_no     text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');
  v_name   text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');
  v_row    public.students;
begin
  -- (1) 로그인(익명 로그인 포함) 상태인지
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using hint = '먼저 로그인이 필요합니다.';
  end if;

  -- (2) 개인정보 수집·이용 동의 여부
  if coalesce(p_agree, false) = false then
    raise exception 'AGREE_REQUIRED' using hint = '개인정보 수집·이용에 동의해야 참여할 수 있습니다.';
  end if;

  -- (3) 입력값 검사 (빈 칸, 너무 긴 값)
  if v_norm = '' or char_length(v_school) > 40 then
    raise exception 'BAD_SCHOOL' using hint = '학교 이름을 확인해 주세요.';
  end if;
  if v_no = '' or char_length(v_no) > 20 then
    raise exception 'BAD_STUDENT_NO' using hint = '학번을 확인해 주세요.';
  end if;
  if v_name = '' or char_length(v_name) > 20 then
    raise exception 'BAD_NAME' using hint = '이름을 확인해 주세요.';
  end if;

  -- (4) 없으면 새로 만들기. 동시에 두 기기에서 눌러도 unique 인덱스 덕분에 1개만 생김.
  insert into public.students (school, school_norm, student_no, name)
  values (v_school, v_norm, v_no, v_name)
  on conflict (school_norm, student_no) do nothing;

  -- (5) 해당 프로필을 잠그고(동시 수정 방지) 가져오기
  select * into v_row
  from public.students
  where school_norm = v_norm and student_no = v_no
  for update;

  -- (6) 이름이 다르면 거부 (띄어쓰기는 무시하고 비교)
  if v_row.name <> v_name then
    raise exception 'NAME_MISMATCH'
      using hint = '이미 다른 이름으로 등록된 학번입니다. 학교·학번·이름을 다시 확인해 주세요.';
  end if;

  -- (7) 이 기기가 다른 학생 프로필에 연결되어 있었다면 그 연결을 끊음 (기기 1대 = 학생 1명)
  update public.students set user_id = null
  where user_id = v_uid and id <> v_row.id;

  -- (8) 이 프로필을 지금 기기로 연결 (이전 기기 연결은 자동으로 끊김)
  update public.students
  set user_id = v_uid,
      last_login_at = now(),
      agreed_at = now()
  where id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'id',         v_row.id,
    'school',     v_row.school,
    'student_no', v_row.student_no,
    'name',       v_row.name
  );
end;
$$;

-- 4-2. toggle_like: 하트 누르기/취소. 결과로 지금 상태와 전체 개수를 돌려줌
drop function if exists public.toggle_like(uuid);
create function public.toggle_like(p_artwork_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid   uuid := public.current_student_id();
  v_liked boolean;
  v_count int;
begin
  if v_sid is null then
    raise exception 'NOT_STUDENT' using hint = '로그인 후 하트를 누를 수 있습니다. 다른 기기에서 로그인했다면 다시 로그인해 주세요.';
  end if;
  if not public.voting_is_open() then
    raise exception 'VOTING_CLOSED' using hint = '지금은 투표 기간이 아닙니다.';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and is_hidden = false) then
    raise exception 'NO_ARTWORK' using hint = '작품을 찾을 수 없습니다.';
  end if;

  -- 이미 눌렀으면 지우고(취소), 아니면 추가
  delete from public.likes where artwork_id = p_artwork_id and student_id = v_sid;
  if found then
    v_liked := false;
  else
    insert into public.likes (artwork_id, student_id) values (p_artwork_id, v_sid)
    on conflict do nothing;
    v_liked := true;
  end if;

  select count(*) into v_count from public.likes where artwork_id = p_artwork_id;
  return jsonb_build_object('liked', v_liked, 'like_count', v_count);
end;
$$;

-- 4-3. add_comment: 댓글 쓰기 (1~200자). 작성자 이름은 여기서 가려서 저장.
drop function if exists public.add_comment(uuid, text);
create function public.add_comment(p_artwork_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid  uuid := public.current_student_id();
  v_body text := btrim(coalesce(p_body, ''));
  v_name text;
  v_row  public.comments;
begin
  if v_sid is null then
    raise exception 'NOT_STUDENT' using hint = '로그인 후 댓글을 쓸 수 있습니다. 다른 기기에서 로그인했다면 다시 로그인해 주세요.';
  end if;
  if not public.voting_is_open() then
    raise exception 'VOTING_CLOSED' using hint = '지금은 투표 기간이 아닙니다.';
  end if;
  if char_length(v_body) < 1 then
    raise exception 'EMPTY_COMMENT' using hint = '댓글 내용을 입력해 주세요.';
  end if;
  if char_length(v_body) > 200 then
    raise exception 'TOO_LONG' using hint = '댓글은 200자까지 쓸 수 있습니다.';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and is_hidden = false) then
    raise exception 'NO_ARTWORK' using hint = '작품을 찾을 수 없습니다.';
  end if;

  select name into v_name from public.students where id = v_sid;

  insert into public.comments (artwork_id, student_id, author_masked, body)
  values (p_artwork_id, v_sid, public.mask_name(v_name), v_body)
  returning * into v_row;

  return jsonb_build_object(
    'id',            v_row.id,
    'author_masked', v_row.author_masked,
    'body',          v_row.body,
    'created_at',    v_row.created_at,
    'is_mine',       true
  );
end;
$$;

-- 4-4. delete_my_comment: 내 댓글만 지울 수 있음
drop function if exists public.delete_my_comment(uuid);
create function public.delete_my_comment(p_comment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid uuid := public.current_student_id();
begin
  if v_sid is null then
    raise exception 'NOT_STUDENT' using hint = '로그인이 필요합니다.';
  end if;
  if not public.voting_is_open() then
    raise exception 'VOTING_CLOSED' using hint = '투표가 마감되어 댓글을 지울 수 없습니다.';
  end if;

  delete from public.comments where id = p_comment_id and student_id = v_sid;
  if not found then
    raise exception 'NOT_YOUR_COMMENT' using hint = '내가 쓴 댓글만 지울 수 있습니다.';
  end if;
  return true;
end;
$$;

-- 4-5. get_artwork_stats: 작품별 하트 수·댓글 수·내가 눌렀는지 (로그인 전에도 사용)
drop function if exists public.get_artwork_stats();
create function public.get_artwork_stats()
returns table (artwork_id uuid, like_count int, comment_count int, liked_by_me boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    (select count(*)::int from public.likes l where l.artwork_id = a.id),
    (select count(*)::int from public.comments c where c.artwork_id = a.id and c.is_hidden = false),
    exists (
      select 1 from public.likes l
      where l.artwork_id = a.id and l.student_id = public.current_student_id()
    )
  from public.artworks a
  where a.is_hidden = false;
$$;

-- 4-6. list_comments: 한 작품의 댓글 목록 (가린 이름·내용·시각·내 댓글 여부만 전달)
drop function if exists public.list_comments(uuid);
create function public.list_comments(p_artwork_id uuid)
returns table (id uuid, author_masked text, body text, created_at timestamptz, is_mine boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.author_masked, c.body, c.created_at,
         (c.student_id = public.current_student_id()) as is_mine
  from public.comments c
  join public.artworks a on a.id = c.artwork_id and a.is_hidden = false
  where c.artwork_id = p_artwork_id and c.is_hidden = false
  order by c.created_at desc
  limit 300;
$$;


-- =====================================================================
-- 5. 관리자용 함수
-- =====================================================================

-- 5-1. activate_admin: 관리자 계정 "활성화 + 관리자 등록"을 한 번에 처리
--      브라우저 흐름: ① supabase.auth.signUp(이메일, 비번)  ② 이 함수 호출  ③ 이메일·비번으로 로그인
--      - 가입 코드가 맞는지 secrets 표와 비교 (브라우저는 코드를 볼 수 없음)
--      - 비밀번호가 실제 계정 비밀번호와 맞는지 확인 (남의 계정을 관리자로 만들 수 없게)
--      - 이메일 인증 없이 바로 쓸 수 있도록 email_confirmed_at 을 채움
--      - 10분 동안 실패가 20번을 넘으면 잠시 막음 (코드 마구 대입 방지)
--      ※ 실패할 때 오류(raise)를 내면 실패 기록까지 취소되므로, 결과를 jsonb로 돌려줍니다.
drop function if exists public.activate_admin(text, text, text);
create function public.activate_admin(p_email text, p_password text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  auth.users;
  v_fails int;
begin
  select count(*) into v_fails
  from public.admin_signup_attempts
  where success = false and created_at > now() - interval '10 minutes';
  if v_fails >= 20 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS',
      'message', '시도가 너무 많습니다. 10분 뒤에 다시 해 주세요.');
  end if;

  -- 가입 코드 확인
  if coalesce(p_code, '') <> coalesce((select value from public.secrets where key = 'admin_signup_code'), '')
     or coalesce(p_code, '') = '' then
    insert into public.admin_signup_attempts (email, success) values (v_email, false);
    return jsonb_build_object('ok', false, 'error', 'BAD_CODE', 'message', '관리자 가입 코드가 올바르지 않습니다.');
  end if;

  -- 계정 확인 (익명 계정 제외) + 비밀번호 확인
  select * into v_user
  from auth.users u
  where lower(u.email) = v_email and coalesce(u.is_anonymous, false) = false
  limit 1;

  if v_user.id is null
     or v_user.encrypted_password is null
     or v_user.encrypted_password <> extensions.crypt(coalesce(p_password, ''), v_user.encrypted_password) then
    insert into public.admin_signup_attempts (email, success) values (v_email, false);
    return jsonb_build_object('ok', false, 'error', 'BAD_ACCOUNT',
      'message', '계정을 찾을 수 없거나 비밀번호가 다릅니다. 이미 있는 계정이면 기존 비밀번호를 입력해 주세요.');
  end if;

  -- 활성화(이메일 인증 처리) + 관리자 등록
  update auth.users
  set email_confirmed_at = coalesce(email_confirmed_at, now())
  where id = v_user.id;

  insert into public.admins (email) values (v_email) on conflict (email) do nothing;
  insert into public.admin_signup_attempts (email, success) values (v_email, true);

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

-- 5-1b. verify_admin_code: 계정을 만들기 "전에" 가입 코드만 먼저 확인
--       (코드가 틀렸는데 로그인 계정만 생겨 버리는 일을 막기 위함. 실패 횟수 제한은 activate_admin과 공유)
drop function if exists public.verify_admin_code(text);
create function public.verify_admin_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fails int;
begin
  select count(*) into v_fails
  from public.admin_signup_attempts
  where success = false and created_at > now() - interval '10 minutes';
  if v_fails >= 20 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS',
      'message', '시도가 너무 많습니다. 10분 뒤에 다시 해 주세요.');
  end if;

  if coalesce(p_code, '') = ''
     or p_code <> coalesce((select value from public.secrets where key = 'admin_signup_code'), '') then
    insert into public.admin_signup_attempts (email, success) values (null, false);
    return jsonb_build_object('ok', false, 'error', 'BAD_CODE', 'message', '관리자 가입 코드가 올바르지 않습니다.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 5-2. remove_admin: 관리자 권한 해제 (본인은 해제 불가). 로그인 계정 자체는 남겨 둡니다.
drop function if exists public.remove_admin(text);
create function public.remove_admin(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using hint = '관리자만 할 수 있습니다.';
  end if;
  if v_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'CANNOT_REMOVE_SELF' using hint = '본인의 관리자 권한은 해제할 수 없습니다.';
  end if;
  delete from public.admins where email = v_email;
  return found;
end;
$$;

-- 5-3. admin_stats: 대시보드 현황 숫자
drop function if exists public.admin_stats();
create function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using hint = '관리자만 볼 수 있습니다.';
  end if;
  return jsonb_build_object(
    'artworks', (select count(*) from public.artworks),
    'students', (select count(*) from public.students),
    'likes',    (select count(*) from public.likes),
    'comments', (select count(*) from public.comments)
  );
end;
$$;


-- =====================================================================
-- 6. 함수 실행 권한
--    기본적으로 PostgreSQL은 모든 사람(public)에게 함수 실행을 허락하므로, 먼저 모두 막고
--    필요한 역할에만 다시 열어 줍니다.
-- =====================================================================
revoke execute on function
  public.normalize_school(text),
  public.mask_name(text),
  public.is_admin(),
  public.current_student_id(),
  public.voting_is_open(),
  public.claim_student(text, text, text, boolean),
  public.toggle_like(uuid),
  public.add_comment(uuid, text),
  public.delete_my_comment(uuid),
  public.get_artwork_stats(),
  public.list_comments(uuid),
  public.activate_admin(text, text, text),
  public.verify_admin_code(text),
  public.remove_admin(text),
  public.admin_stats()
from public, anon, authenticated;

-- 로그인 전(anon)에도 필요한 것: 갤러리 숫자, 댓글 보기, 관리자 가입 코드 확인·활성화
grant execute on function
  public.is_admin(),
  public.current_student_id(),
  public.voting_is_open(),
  public.get_artwork_stats(),
  public.list_comments(uuid),
  public.activate_admin(text, text, text),
  public.verify_admin_code(text)
to anon, authenticated;

-- 로그인 후(학생은 익명 로그인도 authenticated 역할)
grant execute on function
  public.normalize_school(text),
  public.mask_name(text),
  public.claim_student(text, text, text, boolean),
  public.toggle_like(uuid),
  public.add_comment(uuid, text),
  public.delete_my_comment(uuid),
  public.remove_admin(text),
  public.admin_stats()
to authenticated;


-- =====================================================================
-- 7. Storage: 작품 이미지 버킷 'artworks'
--    - 공개(public) 버킷: 이미지 주소만 알면 누구나 볼 수 있음 (갤러리용)
--    - 올리기·바꾸기·지우기는 관리자만
--    - 파일 1개 최대 10MB, 이미지 형식만 허용
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artworks', 'artworks', true, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists artworks_storage_admin_insert on storage.objects;
create policy artworks_storage_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'artworks' and public.is_admin());

drop policy if exists artworks_storage_admin_update on storage.objects;
create policy artworks_storage_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'artworks' and public.is_admin())
  with check (bucket_id = 'artworks' and public.is_admin());

drop policy if exists artworks_storage_admin_delete on storage.objects;
create policy artworks_storage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'artworks' and public.is_admin());

-- 관리자가 파일 목록을 조회할 수 있도록 (공개 이미지 보기는 이 정책 없이도 가능)
drop policy if exists artworks_storage_admin_select on storage.objects;
create policy artworks_storage_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'artworks' and public.is_admin());


-- =====================================================================
-- 8. (참고) 운영 중 자주 쓰는 SQL — 필요할 때 해당 줄만 복사해서 실행하세요.
-- ---------------------------------------------------------------------
-- 관리자 가입 코드 바꾸기:
--   update public.secrets set value = '새코드' where key = 'admin_signup_code';
-- 관리자 명단 보기:
--   select * from public.admins;
-- =====================================================================
