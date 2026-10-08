-- =====================================================================
-- 첫 관리자(교사) 계정을 SQL로 미리 만들어 두기
-- ---------------------------------------------------------------------
-- 사용법
--   1) 먼저 schema.sql 을 실행해 둡니다.
--   2) 이 파일을 SQL Editor에 붙여넣고, 아래 두 줄의 '여기에_...' 부분만 실제 값으로 바꿉니다.
--   3) Run. → 이메일 인증 없이 바로 admin.html 에서 로그인할 수 있습니다.
--
-- ⚠️ 실제 비밀번호를 넣은 뒤에는 이 파일을 GitHub에 올리지 마세요! (저장소는 공개됩니다)
--    SQL Editor에서만 바꿔서 실행하고, 저장소의 파일은 '여기에_...' 상태로 두세요.
--
-- 이미 같은 이메일 계정이 있으면: 비밀번호를 새 값으로 바꾸고, 이메일 인증 처리 + 관리자 등록만 합니다.
--
-- (SQL 없이 하는 방법) admin.html → "관리자 계정 만들기"에서 이메일·비밀번호·가입 코드(기본 sonline)를
-- 입력해도 똑같이 만들어집니다.
-- =====================================================================
do $$
declare
  v_email    text := lower(btrim('여기에_이메일'));        -- 예: 'teacher@school.kr'
  v_password text := '여기에_비밀번호';                    -- 6자 이상
  v_id       uuid;
begin
  if v_email like '%여기에%' or v_password like '%여기에%' then
    raise exception '이메일과 비밀번호를 실제 값으로 바꾼 뒤 실행해 주세요.';
  end if;
  if char_length(v_password) < 6 then
    raise exception '비밀번호는 6자 이상이어야 합니다.';
  end if;

  select id into v_id
  from auth.users
  where lower(email) = v_email and coalesce(is_anonymous, false) = false
  limit 1;

  if v_id is null then
    -- (1) 로그인 계정 만들기: Supabase Auth 가 쓰는 표(auth.users)에 직접 추가
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', ''
    );
    -- (2) 이메일 로그인 방식(identity) 연결
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now()
    );
    raise notice '새 계정을 만들었습니다: %', v_email;
  else
    -- 이미 있는 계정: 비밀번호 재설정 + 이메일 인증 처리
    update auth.users
    set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
    where id = v_id;
    raise notice '기존 계정의 비밀번호를 바꾸고 활성화했습니다: %', v_email;
  end if;

  -- (3) 관리자 명단에 등록
  insert into public.admins (email) values (v_email) on conflict (email) do nothing;
  raise notice '관리자로 등록했습니다: %', v_email;
end $$;

-- 확인: 관리자 명단
select * from public.admins;
