// =====================================================================
// 관리자 화면 (admin.html) 동작 코드
// ---------------------------------------------------------------------
// 구성
//   0. 준비(연결, 도구)          5. 학생 탭
//   1. 로그인 / 관리자 계정 만들기  6. 댓글 탭
//   2. 탭 전환                   7. 결과 탭 + CSV 3종
//   3. 대시보드 탭               8. 교사 계정 탭
//   4. 작품 탭(업로드·CSV·수정)   9. 시작
//
// 보안 메모
//   - 이 페이지도 공개되어 있으므로 누구나 열 수 있습니다. 하지만 데이터를 읽고 쓰는 권한은
//     DB의 is_admin() 검사(RLS 정책)로 막혀 있어서, 관리자가 아니면 아무것도 볼 수 없습니다.
//   - 관리자 로그인 정보는 학생 화면과 다른 이름(storageKey)으로 저장해 서로 섞이지 않게 합니다.
// =====================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // 0. 준비
  // ---------------------------------------------------------------
  const CONFIG = window.APP_CONFIG || {};
  const BUCKET = CONFIG.STORAGE_BUCKET || 'artworks';

  // 관리자용 연결: 로그인 상태를 'sv-admin-auth' 라는 이름으로 브라우저에 저장
  const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'sv-admin-auth' },
  });

  // 계정 "만들기" 전용 연결: 로그인 상태를 저장하지 않음.
  // → 교사 계정 탭에서 다른 선생님 계정을 만들어도 지금 로그인한 계정이 바뀌지 않습니다.
  const signupDb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'sv-admin-signup', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 화면 상태
  const state = {
    user: null,          // 로그인한 관리자 (Supabase user)
    artworks: [],        // 전체 작품 (숨김 포함)
    students: [],
    comments: [],
    likes: [],
    admins: [],
    pending: [],         // 업로드 대기 중인 이미지 [{ key, file, url, title, author, description, csvIndex, status }]
    csvRows: [],         // 불러온 작품 정보 CSV [{ title, author, description, keyword }]
    loaded: {},          // 탭별로 한 번이라도 불러왔는지
  };

  /** HTML 요소 만들기 도우미 (글자는 textContent 로 넣어 XSS 방지) */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function imageUrl(path) {
    return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // 2026-10-08 14:05 형식
  function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 3000);
  }

  function errorText(error) {
    if (!error) return '알 수 없는 오류';
    if (error.hint) return error.hint;
    const m = error.message || String(error);
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일 인증이 안 된 계정입니다. "관리자 계정 만들기"에서 같은 이메일·비밀번호와 가입 코드를 입력하면 바로 활성화됩니다.';
    if (/rate limit/i.test(m)) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요. (Supabase 이메일 인증을 끄면 해결되는 경우가 많습니다)';
    if (/Password should be/i.test(m)) return '비밀번호가 너무 짧거나 단순합니다. 6자 이상으로 입력해 주세요.';
    if (/Signups not allowed/i.test(m)) return 'Supabase에서 새 계정 만들기(가입)가 꺼져 있습니다. Authentication 설정을 확인해 주세요.';
    if (/row-level security|permission denied/i.test(m)) return '권한이 없습니다. 관리자 계정인지 확인해 주세요.';
    if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결 또는 Supabase 주소(js/config.js)를 확인해 주세요.';
    return m;
  }

  function showMsg(node, text, ok) {
    node.textContent = text;
    node.classList.toggle('ok', !!ok);
    node.hidden = !text;
  }

  /**
   * 1000줄이 넘는 표도 모두 받아오기.
   * Supabase는 한 번에 최대 1000줄까지만 돌려주므로, 1000줄씩 나눠서 끝까지 받습니다.
   * build() 는 매번 새 쿼리를 만들어 돌려주는 함수여야 합니다(정렬 포함).
   */
  async function fetchAll(build) {
    const size = 1000;
    let from = 0;
    let all = [];
    for (;;) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < size) break;
      from += size;
    }
    return all;
  }

  // ---------------- CSV 도구 ----------------
  /**
   * CSV 한 칸 만들기.
   * - 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감쌈
   * - =, +, -, @ 로 시작하는 값은 엑셀이 "수식"으로 실행할 수 있어서 앞에 ' 를 붙여 글자로 만듦
   *   (학생이 댓글에 =HYPERLINK(...) 같은 것을 써도 엑셀에서 실행되지 않도록)
   */
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** CSV 파일 내려받기. 맨 앞에 BOM(﻿)을 넣어 엑셀에서 한글이 깨지지 않게 함 */
  function downloadCsv(filename, header, rows) {
    const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  /** CSV 글자를 표(2차원 배열)로 바꾸기. 따옴표 안의 쉼표·줄바꿈도 처리 */
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  /**
   * 파일을 글자로 읽기. 엑셀에서 "CSV(쉼표로 분리)"로 저장하면 한글이 EUC-KR 로 저장되는 경우가 있어
   * UTF-8 로 읽어 보고 깨진 글자(�)가 보이면 EUC-KR 로 다시 읽습니다.
   */
  async function readTextSmart(file) {
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
  }

  // 비교용 글자 정리: 한글 자모 합치기(맥에서 만든 파일 이름 대비) + 소문자 + 공백 제거
  const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');

  // ---------------------------------------------------------------
  // 1. 로그인 / 관리자 계정 만들기
  // ---------------------------------------------------------------
  // 로그인 ↔ 계정 만들기 전환
  $$('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      $$('[data-auth-panel]').forEach((p) => { p.hidden = p.dataset.authPanel !== btn.dataset.authTab; });
    });
  });

  /**
   * 관리자 계정 만들기 (로그인 화면과 교사 계정 탭에서 함께 사용)
   *   ① 가입 코드 확인(verify_admin_code)        → 틀리면 여기서 멈춤
   *   ② 로그인 계정 만들기(signUp)              → 이미 있는 이메일이면 그대로 진행
   *   ③ 활성화 + 관리자 등록(activate_admin)    → 코드·비밀번호를 DB에서 다시 확인
   */
  async function createAdminAccount(email, password, code) {
    const check = await db.rpc('verify_admin_code', { p_code: code });
    if (check.error) throw check.error;
    if (!check.data.ok) throw new Error(check.data.message);

    const { error: signUpError } = await signupDb.auth.signUp({ email, password });
    if (signUpError && !/already (been )?registered|already exists/i.test(signUpError.message)) {
      throw signUpError;
    }

    const { data, error } = await db.rpc('activate_admin', { p_email: email, p_password: password, p_code: code });
    if (error) throw error;
    if (!data.ok) throw new Error(data.message);
    return data.email;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const msg = $('#loginMsg');
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    showMsg(msg, '');
    try {
      const { error } = await db.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) throw error;
      await enterApp();
    } catch (err) {
      showMsg(msg, errorText(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const msg = $('#signupMsg');
    const email = f.email.value.trim();
    const password = f.password.value;
    if (password.length < 6) { showMsg(msg, '비밀번호는 6자 이상이어야 합니다.'); return; }
    if (password !== f.password2.value) { showMsg(msg, '비밀번호 확인이 일치하지 않습니다.'); return; }

    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    showMsg(msg, '계정을 만드는 중…', true);
    try {
      await createAdminAccount(email, password, f.code.value);
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      f.reset();
      await enterApp();
      toast('관리자 계정이 만들어졌습니다.');
    } catch (err) {
      showMsg(msg, errorText(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await db.auth.signOut();
    location.reload();
  });

  /** 로그인 후: 정말 관리자인지 DB에 물어보고, 맞으면 관리 화면을 보여 줌 */
  async function enterApp() {
    const { data: { session } } = await db.auth.getSession();
    if (!session || session.user.is_anonymous) { showAuth(); return; }

    const { data: ok, error } = await db.rpc('is_admin');
    if (error || !ok) {
      await db.auth.signOut();
      showAuth();
      showMsg($('#loginMsg'), error ? errorText(error)
        : '관리자로 등록되지 않은 계정입니다. "관리자 계정 만들기"에서 가입 코드로 등록해 주세요.');
      return;
    }

    state.user = session.user;
    $('#adminEmail').textContent = session.user.email;
    $('#bootMsg').hidden = true;
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    showTab('dashboard');
  }

  function showAuth() {
    $('#bootMsg').hidden = true;
    $('#appView').hidden = true;
    $('#authView').hidden = false;
  }

  // ---------------------------------------------------------------
  // 2. 탭 전환: 처음 여는 탭은 그때 데이터를 불러옴
  // ---------------------------------------------------------------
  const loaders = {
    dashboard: loadDashboard,
    artworks: loadArtworks,
    students: loadStudents,
    comments: loadComments,
    results: loadResults,
    teachers: loadAdmins,
  };

  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    // 대시보드는 숫자가 자주 바뀌므로 열 때마다, 나머지는 처음 한 번만 자동으로 불러옴
    if (name === 'dashboard' || !state.loaded[name]) runLoader(name);
  }

  async function runLoader(name) {
    try {
      await loaders[name]();
      state.loaded[name] = true;
    } catch (err) {
      console.error(err);
      toast('불러오기 실패: ' + errorText(err));
    }
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $$('[data-refresh]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await runLoader(b.dataset.refresh);
    b.disabled = false;
  }));

  // ---------------------------------------------------------------
  // 3. 대시보드: 투표 스위치, 현황 숫자, 사이트 문구
  // ---------------------------------------------------------------
  async function loadDashboard() {
    const [settingsRes, statsRes] = await Promise.all([
      db.from('settings').select('*').eq('id', 1).single(),
      db.rpc('admin_stats'),
    ]);
    if (settingsRes.error) throw settingsRes.error;
    if (statsRes.error) throw statsRes.error;

    const s = settingsRes.data;
    $('#votingSwitch').checked = s.voting_open;
    renderVotingDesc(s.voting_open);
    const form = $('#settingsForm');
    form.site_title.value = s.site_title;
    form.notice.value = s.notice;

    const st = statsRes.data;
    $('#statArtworks').textContent = st.artworks;
    $('#statStudents').textContent = st.students;
    $('#statLikes').textContent = st.likes;
    $('#statComments').textContent = st.comments;
  }

  function renderVotingDesc(open) {
    $('#votingDesc').textContent = open
      ? '🟢 투표 진행 중 — 학생들이 하트와 댓글을 남길 수 있습니다.'
      : '⚪ 투표 마감 — 학생들은 작품을 보기만 할 수 있습니다.';
  }

  $('#votingSwitch').addEventListener('change', async (e) => {
    const sw = e.currentTarget;
    const open = sw.checked;
    if (!confirm(open ? '투표를 시작할까요? 학생들이 바로 하트와 댓글을 남길 수 있게 됩니다.'
                      : '투표를 마감할까요? 이후에는 하트·댓글을 남기거나 지울 수 없습니다.')) {
      sw.checked = !open;
      return;
    }
    sw.disabled = true;
    const { error } = await db.from('settings').update({ voting_open: open, updated_at: new Date().toISOString() }).eq('id', 1);
    sw.disabled = false;
    if (error) { sw.checked = !open; toast('변경 실패: ' + errorText(error)); return; }
    renderVotingDesc(open);
    toast(open ? '투표를 시작했습니다.' : '투표를 마감했습니다.');
  });

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const { error } = await db.from('settings').update({
      site_title: f.site_title.value.trim() || '캐릭터 공모전 투표',
      notice: f.notice.value,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    toast(error ? '저장 실패: ' + errorText(error) : '저장했습니다.');
  });

  // ---------------------------------------------------------------
  // 4. 작품
  // ---------------------------------------------------------------
  // 4-1. 작품 정보 CSV 불러오기 (열: 제목, 출품자, 설명, 파일명키워드)
  $('#csvInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const table = parseCsv(await readTextSmart(file));
    if (!table.length) { toast('CSV에 내용이 없습니다.'); return; }

    // 첫 줄이 머리글이면 열 이름으로 위치를 찾고, 아니면 순서대로(제목, 출품자, 설명, 키워드) 읽음
    const head = table[0].map(norm);
    const find = (...names) => head.findIndex((h) => names.includes(h));
    let idx = {
      title: find('제목', '작품명', '작품제목', 'title'),
      author: find('출품자', '작가', '이름', 'author'),
      description: find('설명', '작품설명', 'description'),
      keyword: find('파일명키워드', '키워드', '파일명', 'keyword'),
    };
    let body = table.slice(1);
    if (idx.title < 0 && idx.author < 0) {
      idx = { title: 0, author: 1, description: 2, keyword: 3 };
      body = table;
    }
    const get = (r, i) => (i >= 0 && r[i] !== undefined ? r[i].trim() : '');
    state.csvRows = body.map((r) => ({
      title: get(r, idx.title), author: get(r, idx.author),
      description: get(r, idx.description), keyword: get(r, idx.keyword),
    })).filter((r) => r.title || r.author || r.description);

    $('#csvStatus').textContent = `「${file.name}」에서 작품 정보 ${state.csvRows.length}개를 불러왔습니다.`;
    // 이미 올려 둔 이미지 중 아직 비어 있는 것은 자동으로 짝지어 줌
    state.pending.forEach((p) => { if (p.csvIndex < 0 && !p.title) autoMatch(p); });
    renderPending();
  });

  /**
   * 파일 이름 안에 CSV의 '파일명키워드'가 들어 있으면 그 줄의 정보로 채웁니다.
   * 여러 개가 맞으면 가장 긴 키워드(가장 구체적인 것)를 고르고, 이미 다른 이미지에 쓴 줄은 피합니다.
   */
  function autoMatch(item) {
    const name = norm(item.file.name.replace(/\.[^.]+$/, ''));
    const used = new Set(state.pending.filter((p) => p !== item).map((p) => p.csvIndex));
    let best = -1;
    state.csvRows.forEach((row, i) => {
      const k = norm(row.keyword);
      if (!k || !name.includes(k)) return;
      const better = best < 0 ||
        (used.has(best) && !used.has(i)) ||
        (used.has(best) === used.has(i) && k.length > norm(state.csvRows[best].keyword).length);
      if (better) best = i;
    });
    if (best >= 0) applyCsvRow(item, best);
  }

  function applyCsvRow(item, index) {
    item.csvIndex = index;
    if (index < 0) return;
    const row = state.csvRows[index];
    item.title = row.title;
    item.author = row.author;
    item.description = row.description;
  }

  // 4-2. 이미지 고르기 / 끌어다 놓기
  const dropzone = $('#dropzone');
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  // 드롭존 밖에 잘못 떨어뜨려도 브라우저가 이미지를 열어 버리지 않게 막음
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  function addFiles(fileList) {
    let skipped = 0;
    for (const file of Array.from(fileList || [])) {
      if (!ALLOWED.includes(file.type)) { skipped++; continue; }
      const item = {
        key: Math.random().toString(36).slice(2),
        file, url: URL.createObjectURL(file),
        title: '', author: '', description: '', csvIndex: -1, status: '',
      };
      state.pending.push(item);
      if (state.csvRows.length) autoMatch(item);
    }
    if (skipped) toast(`이미지가 아닌 파일 ${skipped}개는 건너뛰었습니다. (PNG/JPG/WEBP/GIF만 가능)`);
    renderPending();
  }

  function renderPending() {
    const list = $('#pendingList');
    list.replaceChildren();
    $('#uploadBar').hidden = state.pending.length === 0;

    for (const item of state.pending) {
      // CSV 줄 선택 드롭다운
      const select = el('select', {
        'aria-label': 'CSV 작품 정보 선택',
        onchange: (e) => {
          applyCsvRow(item, Number(e.target.value));
          renderPending();
        },
      }, el('option', { value: '-1', text: state.csvRows.length ? '— CSV에서 고르기 (또는 직접 입력) —' : '— CSV 없음: 직접 입력 —' }),
      state.csvRows.map((r, i) => el('option', {
        value: String(i), selected: item.csvIndex === i,
        text: `${i + 1}. ${r.title || '(제목 없음)'} / ${r.author || '-'}${r.keyword ? ' [' + r.keyword + ']' : ''}`,
      })));

      const bind = (field) => (e) => { item[field] = e.target.value; };
      const statusBadge = item.status === 'done' ? el('span', { class: 'badge ok', text: '완료' })
        : item.status === 'uploading' ? el('span', { class: 'badge', text: '올리는 중…' })
        : item.status ? el('span', { class: 'badge err', text: '실패: ' + item.status })
        : item.csvIndex >= 0 ? el('span', { class: 'badge ok', text: 'CSV 매칭됨' })
        : state.csvRows.length ? el('span', { class: 'badge warn', text: '매칭 안 됨' }) : null;

      list.append(el('div', { class: 'art-item' },
        el('img', { class: 'art-thumb', src: item.url, alt: '' }),
        el('div', { class: 'art-fields' },
          el('div', { class: 'art-meta' },
            statusBadge,
            el('span', { class: 'file-name', text: `${item.file.name} · ${(item.file.size / 1024 / 1024).toFixed(1)}MB` })
          ),
          state.csvRows.length ? select : null,
          el('div', { class: 'two' },
            el('input', { type: 'text', placeholder: '제목', value: item.title, maxLength: 100, oninput: bind('title') }),
            el('input', { type: 'text', placeholder: '출품자', value: item.author, maxLength: 100, oninput: bind('author') })
          ),
          el('textarea', { rows: 2, placeholder: '작품 설명', value: item.description, maxLength: 3000, oninput: bind('description') }),
          el('div', { class: 'art-actions' },
            el('button', { type: 'button', class: 'btn btn-sm', text: '목록에서 빼기', onclick: () => removePending(item) })
          )
        )
      ));
    }
  }

  function removePending(item) {
    URL.revokeObjectURL(item.url);
    state.pending = state.pending.filter((p) => p !== item);
    renderPending();
  }

  $('#clearPendingBtn').addEventListener('click', () => {
    state.pending.forEach((p) => URL.revokeObjectURL(p.url));
    state.pending = [];
    renderPending();
    $('#uploadStatus').textContent = '';
  });

  /**
   * 큰 사진을 줄이기 (긴 변 2000px).
   * 휴대폰 사진은 10MB가 넘기도 해서 학생 화면이 느려지므로, 브라우저에서 미리 줄여서 올립니다.
   * 투명 배경을 지키기 위해 WEBP로 저장하고, 줄여도 이득이 없으면 원본을 그대로 씁니다.
   */
  async function maybeResize(file) {
    if (!$('#resizeCheck').checked || file.type === 'image/gif') return file;
    const MAX = 2000;
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { return file; }
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bitmap.close?.(); return file; }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.size >= file.size) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type });
  }

  function randomId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // 4-3. 모두 업로드: 이미지 → Storage, 정보 → artworks 표
  $('#uploadAllBtn').addEventListener('click', async () => {
    const todo = state.pending.filter((p) => p.status !== 'done');
    const noTitle = todo.filter((p) => !p.title.trim());
    if (noTitle.length && !confirm(`제목이 비어 있는 작품이 ${noTitle.length}개 있습니다. 그래도 올릴까요?`)) return;

    const btn = $('#uploadAllBtn');
    btn.disabled = true;
    let ok = 0;
    let fail = 0;
    for (const [i, item] of todo.entries()) {
      $('#uploadStatus').textContent = `${i + 1} / ${todo.length} 올리는 중…`;
      item.status = 'uploading';
      renderPending();
      try {
        const file = await maybeResize(item.file);
        // 파일 이름은 한글·띄어쓰기 문제를 피하려고 '날짜/임의ID.확장자'로 새로 만듦
        const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        const path = `${today()}/${randomId()}.${ext}`;
        const up = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) throw up.error;

        const ins = await db.from('artworks').insert({
          title: item.title.trim(), author: item.author.trim(),
          description: item.description.trim(), image_path: path,
        });
        if (ins.error) {
          await db.storage.from(BUCKET).remove([path]);   // 정보 저장 실패 시 올린 이미지도 정리
          throw ins.error;
        }
        item.status = 'done';
        ok++;
      } catch (err) {
        console.error(err);
        item.status = errorText(err);
        fail++;
      }
    }
    // 성공한 것은 목록에서 빼고, 실패한 것만 남겨 다시 시도할 수 있게 함
    state.pending.filter((p) => p.status === 'done').forEach((p) => URL.revokeObjectURL(p.url));
    state.pending = state.pending.filter((p) => p.status !== 'done');
    renderPending();
    btn.disabled = false;
    $('#uploadStatus').textContent = `완료: ${ok}개 성공` + (fail ? `, ${fail}개 실패 (아래에 남아 있음)` : '');
    toast(`${ok}개 작품을 올렸습니다.`);
    await runLoader('artworks');
    state.loaded.results = false;
  });

  // 4-4. 등록된 작품 목록 (인라인 수정·숨김·삭제)
  async function loadArtworks() {
    const { data, error } = await db.from('artworks').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    state.artworks = data || [];
    renderArtworks();
  }

  function renderArtworks() {
    const list = $('#artworkList');
    list.replaceChildren();
    $('#artworkCount').textContent = `${state.artworks.length}개`;
    if (!state.artworks.length) {
      list.append(el('p', { class: 'muted', text: '아직 등록된 작품이 없습니다. 위에서 이미지를 올려 주세요.' }));
      return;
    }

    for (const a of state.artworks) {
      const title = el('input', { type: 'text', value: a.title, placeholder: '제목', maxLength: 100 });
      const author = el('input', { type: 'text', value: a.author, placeholder: '출품자', maxLength: 100 });
      const desc = el('textarea', { rows: 2, value: a.description, placeholder: '작품 설명', maxLength: 3000 });
      const saveBtn = el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: '저장', disabled: true });
      // 내용이 바뀌었을 때만 저장 버튼을 켬
      const markDirty = () => {
        saveBtn.disabled = title.value === a.title && author.value === a.author && desc.value === a.description;
      };
      [title, author, desc].forEach((n) => n.addEventListener('input', markDirty));

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const patch = { title: title.value.trim(), author: author.value.trim(), description: desc.value.trim() };
        const { error } = await db.from('artworks').update(patch).eq('id', a.id);
        if (error) { toast('저장 실패: ' + errorText(error)); markDirty(); return; }
        Object.assign(a, patch);
        title.value = a.title; author.value = a.author; desc.value = a.description;
        toast('저장했습니다.');
      });

      const hideBtn = el('button', {
        type: 'button', class: 'btn btn-sm', text: a.is_hidden ? '보이기' : '숨기기',
        onclick: async () => {
          const { error } = await db.from('artworks').update({ is_hidden: !a.is_hidden }).eq('id', a.id);
          if (error) { toast('변경 실패: ' + errorText(error)); return; }
          a.is_hidden = !a.is_hidden;
          state.loaded.results = false;
          renderArtworks();
          toast(a.is_hidden ? '학생 화면에서 숨겼습니다.' : '학생 화면에 다시 보입니다.');
        },
      });

      const delBtn = el('button', {
        type: 'button', class: 'btn btn-sm btn-danger', text: '삭제',
        onclick: async () => {
          if (!confirm(`「${a.title || '제목 없음'}」을(를) 삭제할까요?\n이 작품의 하트·댓글과 이미지 파일도 함께 지워지며 되돌릴 수 없습니다.`)) return;
          const { error } = await db.from('artworks').delete().eq('id', a.id);
          if (error) { toast('삭제 실패: ' + errorText(error)); return; }
          const rm = await db.storage.from(BUCKET).remove([a.image_path]);
          if (rm.error) console.warn('이미지 파일 삭제 실패', rm.error);
          state.artworks = state.artworks.filter((x) => x.id !== a.id);
          state.loaded.results = false;
          renderArtworks();
          toast('삭제했습니다.');
        },
      });

      list.append(el('div', { class: 'art-item' + (a.is_hidden ? ' is-hidden' : '') },
        el('a', { href: imageUrl(a.image_path), target: '_blank', rel: 'noopener', title: '원본 보기' },
          el('img', { class: 'art-thumb', src: imageUrl(a.image_path), alt: a.title, loading: 'lazy' })),
        el('div', { class: 'art-fields' },
          el('div', { class: 'art-meta' },
            a.is_hidden ? el('span', { class: 'badge warn', text: '숨김' }) : el('span', { class: 'badge ok', text: '공개' }),
            el('span', { class: 'muted', text: '등록 ' + fmt(a.created_at) })
          ),
          el('div', { class: 'two' }, title, author),
          desc,
          el('div', { class: 'art-actions' }, saveBtn, el('span', { class: 'spacer' }), hideBtn, delBtn)
        )
      ));
    }
  }

  // ---------------------------------------------------------------
  // 5. 학생
  // ---------------------------------------------------------------
  async function loadStudents() {
    state.students = await fetchAll(() => db.from('students')
      .select('id, school, student_no, name, user_id, created_at, last_login_at')
      .order('last_login_at', { ascending: false })
      .order('id'));
    renderStudents();
  }

  function filteredStudents() {
    const q = norm($('#studentSearch').value);
    if (!q) return state.students;
    return state.students.filter((s) => norm(`${s.school} ${s.student_no} ${s.name}`).includes(q));
  }

  function renderStudents() {
    const rows = filteredStudents();
    const tbody = $('#studentRows');
    tbody.replaceChildren();
    $('#studentCount').textContent = `${rows.length}명` + (rows.length !== state.students.length ? ` / 전체 ${state.students.length}명` : '');
    if (!rows.length) {
      tbody.append(el('tr', {}, el('td', { colSpan: 6, class: 'empty', text: state.students.length ? '검색 결과가 없습니다.' : '아직 로그인한 학생이 없습니다.' })));
      return;
    }
    for (const s of rows) {
      tbody.append(el('tr', {},
        el('td', { text: s.school }),
        el('td', { class: 'nowrap', text: s.student_no }),
        el('td', { class: 'nowrap', text: s.name }),
        el('td', { class: 'nowrap', text: fmt(s.last_login_at) }),
        el('td', {}, s.user_id ? el('span', { class: 'badge ok', text: '연결됨' }) : el('span', { class: 'badge', text: '해제됨' })),
        el('td', {}, el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn-sm', text: '기기 연결 해제', disabled: !s.user_id, onclick: () => unlinkStudent(s) }),
          el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '삭제', onclick: () => deleteStudent(s) })
        ))
      ));
    }
  }

  $('#studentSearch').addEventListener('input', renderStudents);

  async function unlinkStudent(s) {
    if (!confirm(`${s.name}(${s.student_no}) 학생의 기기 연결을 해제할까요?\n그 기기에서는 더 이상 투표할 수 없고, 학생이 다시 로그인하면 새로 연결됩니다.`)) return;
    const { error } = await db.from('students').update({ user_id: null }).eq('id', s.id);
    if (error) { toast('실패: ' + errorText(error)); return; }
    s.user_id = null;
    renderStudents();
    toast('기기 연결을 해제했습니다.');
  }

  async function deleteStudent(s) {
    if (!confirm(`${s.school} ${s.student_no} ${s.name} 학생의 프로필을 삭제할까요?\n이 학생이 누른 하트와 쓴 댓글도 모두 지워지며 되돌릴 수 없습니다.`)) return;
    const { error } = await db.from('students').delete().eq('id', s.id);
    if (error) { toast('삭제 실패: ' + errorText(error)); return; }
    state.students = state.students.filter((x) => x.id !== s.id);
    state.loaded.comments = false;
    state.loaded.results = false;
    renderStudents();
    toast('삭제했습니다.');
  }

  $('#studentCsvBtn').addEventListener('click', async () => {
    if (!state.loaded.students) await runLoader('students');
    downloadCsv(`학생목록_${today()}.csv`,
      ['학교', '학번', '이름', '처음 로그인', '마지막 로그인', '기기 연결'],
      state.students.map((s) => [s.school, s.student_no, s.name, fmt(s.created_at), fmt(s.last_login_at), s.user_id ? '연결됨' : '해제됨']));
  });

  // ---------------------------------------------------------------
  // 6. 댓글
  // ---------------------------------------------------------------
  async function loadComments() {
    // students(...)·artworks(...) : 외래키로 연결된 학생 실명과 작품 제목을 함께 가져옴 (관리자만 가능)
    state.comments = await fetchAll(() => db.from('comments')
      .select('id, body, author_masked, is_hidden, created_at, artwork_id, students(school, student_no, name), artworks(title, author)')
      .order('created_at', { ascending: false })
      .order('id'));
    renderComments();
  }

  function filteredComments() {
    const mode = $('#commentFilter').value;
    const q = norm($('#commentSearch').value);
    return state.comments.filter((c) => {
      if (mode === 'hidden' && !c.is_hidden) return false;
      if (mode === 'visible' && c.is_hidden) return false;
      if (!q) return true;
      const s = c.students || {};
      return norm(`${c.body} ${s.school} ${s.student_no} ${s.name} ${c.artworks?.title || ''}`).includes(q);
    });
  }

  function renderComments() {
    const rows = filteredComments();
    const tbody = $('#commentRows');
    tbody.replaceChildren();
    const hiddenCount = state.comments.filter((c) => c.is_hidden).length;
    $('#commentCount').textContent = `${rows.length}개 표시 · 전체 ${state.comments.length}개 (숨김 ${hiddenCount}개)`;
    if (!rows.length) {
      tbody.append(el('tr', {}, el('td', { colSpan: 6, class: 'empty', text: '해당하는 댓글이 없습니다.' })));
      return;
    }
    for (const c of rows) {
      const s = c.students || {};
      tbody.append(el('tr', { class: c.is_hidden ? 'row-hidden' : '' },
        el('td', { class: 'nowrap', text: fmt(c.created_at) }),
        el('td', { text: c.artworks?.title || '(삭제된 작품)' }),
        el('td', { class: 'nowrap' }, `${s.school || ''} · ${s.student_no || ''} · ${s.name || ''}`,
          el('br'), el('span', { class: 'muted small', text: '표시: ' + c.author_masked })),
        el('td', { class: 'body', text: c.body }),
        el('td', {}, c.is_hidden ? el('span', { class: 'badge warn', text: '숨김' }) : el('span', { class: 'badge ok', text: '보임' })),
        el('td', {}, el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn-sm', text: c.is_hidden ? '보이기' : '숨기기', onclick: () => toggleCommentHidden(c) }),
          el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '삭제', onclick: () => deleteComment(c) })
        ))
      ));
    }
  }

  $('#commentFilter').addEventListener('change', renderComments);
  $('#commentSearch').addEventListener('input', renderComments);

  async function toggleCommentHidden(c) {
    const { error } = await db.from('comments').update({ is_hidden: !c.is_hidden }).eq('id', c.id);
    if (error) { toast('실패: ' + errorText(error)); return; }
    c.is_hidden = !c.is_hidden;
    state.loaded.results = false;
    renderComments();
    toast(c.is_hidden ? '댓글을 숨겼습니다.' : '댓글을 다시 보이게 했습니다.');
  }

  async function deleteComment(c) {
    if (!confirm('이 댓글을 완전히 삭제할까요? 되돌릴 수 없습니다.\n(남겨 두고 학생에게만 안 보이게 하려면 "숨기기"를 쓰세요)')) return;
    const { error } = await db.from('comments').delete().eq('id', c.id);
    if (error) { toast('삭제 실패: ' + errorText(error)); return; }
    state.comments = state.comments.filter((x) => x.id !== c.id);
    state.loaded.results = false;
    renderComments();
    toast('삭제했습니다.');
  }

  // ---------------------------------------------------------------
  // 7. 결과 (순위표 + CSV 3종)
  // ---------------------------------------------------------------
  async function loadResults() {
    const [artRes, likes] = await Promise.all([
      db.from('artworks').select('*').order('created_at', { ascending: true }),
      fetchAll(() => db.from('likes')
        .select('artwork_id, student_id, created_at, students(school, student_no, name)')
        .order('created_at', { ascending: true })
        .order('student_id')),
      loadComments(),   // 댓글 상세 CSV와 댓글 수 계산에 사용 (댓글 탭도 함께 최신화)
    ]);
    if (artRes.error) throw artRes.error;
    state.artworks = artRes.data || [];
    state.likes = likes;
    state.loaded.comments = true;
    renderResults();
  }

  /** 작품별 하트·댓글 수를 세고 순위를 매김 (하트 같으면 공동 순위: 1, 1, 3 ...) */
  function ranking() {
    const likeCount = new Map();
    for (const l of state.likes) likeCount.set(l.artwork_id, (likeCount.get(l.artwork_id) || 0) + 1);
    const visibleComments = new Map();
    const allComments = new Map();
    for (const c of state.comments) {
      allComments.set(c.artwork_id, (allComments.get(c.artwork_id) || 0) + 1);
      if (!c.is_hidden) visibleComments.set(c.artwork_id, (visibleComments.get(c.artwork_id) || 0) + 1);
    }
    const rows = state.artworks.map((a) => ({
      artwork: a,
      likes: likeCount.get(a.id) || 0,
      comments: visibleComments.get(a.id) || 0,
      commentsAll: allComments.get(a.id) || 0,
    }));
    rows.sort((x, y) => (y.likes - x.likes) || (y.comments - x.comments) || x.artwork.created_at.localeCompare(y.artwork.created_at));
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].likes === r.likes ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  function renderResults() {
    const tbody = $('#resultRows');
    tbody.replaceChildren();
    const rows = ranking();
    if (!rows.length) {
      tbody.append(el('tr', {}, el('td', { colSpan: 6, class: 'empty', text: '등록된 작품이 없습니다.' })));
      return;
    }
    for (const r of rows) {
      const a = r.artwork;
      tbody.append(el('tr', { class: a.is_hidden ? 'row-hidden' : '' },
        el('td', { class: 'rank rank-' + r.rank, text: r.rank + '위' }),
        el('td', {}, el('img', { class: 'mini-thumb', src: imageUrl(a.image_path), alt: '', loading: 'lazy' }), a.title || '(제목 없음)'),
        el('td', { text: a.author }),
        el('td', { class: 'num', text: String(r.likes) }),
        el('td', { class: 'num', text: String(r.comments) }),
        el('td', {}, a.is_hidden ? el('span', { class: 'badge warn', text: '숨김' }) : el('span', { class: 'badge ok', text: '공개' }))
      ));
    }
  }

  async function ensureResults() {
    if (!state.loaded.results) await runLoader('results');
  }

  $('#csvSummaryBtn').addEventListener('click', async () => {
    await ensureResults();
    downloadCsv(`작품별집계_${today()}.csv`,
      ['순위', '제목', '출품자', '하트 수', '댓글 수(보이는 것)', '댓글 수(숨김 포함)', '공개 여부', '등록 시각'],
      ranking().map((r) => [r.rank, r.artwork.title, r.artwork.author, r.likes, r.comments, r.commentsAll,
        r.artwork.is_hidden ? '숨김' : '공개', fmt(r.artwork.created_at)]));
  });

  $('#csvLikesBtn').addEventListener('click', async () => {
    await ensureResults();
    const art = new Map(state.artworks.map((a) => [a.id, a]));
    downloadCsv(`하트상세_${today()}.csv`,
      ['작품 제목', '출품자', '학교', '학번', '이름', '누른 시각'],
      state.likes.map((l) => {
        const a = art.get(l.artwork_id) || {};
        const s = l.students || {};
        return [a.title, a.author, s.school, s.student_no, s.name, fmt(l.created_at)];
      }));
  });

  $('#csvCommentsBtn').addEventListener('click', async () => {
    await ensureResults();
    downloadCsv(`댓글상세_${today()}.csv`,
      ['작품 제목', '출품자', '학교', '학번', '이름', '표시 이름', '내용', '상태', '작성 시각'],
      state.comments.slice().reverse().map((c) => {
        const s = c.students || {};
        return [c.artworks?.title, c.artworks?.author, s.school, s.student_no, s.name, c.author_masked, c.body,
          c.is_hidden ? '숨김' : '보임', fmt(c.created_at)];
      }));
  });

  // ---------------------------------------------------------------
  // 8. 교사 계정
  // ---------------------------------------------------------------
  async function loadAdmins() {
    const { data, error } = await db.from('admins').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    state.admins = data || [];
    const tbody = $('#adminRows');
    tbody.replaceChildren();
    const me = (state.user?.email || '').toLowerCase();
    for (const a of state.admins) {
      const isMe = a.email === me;
      tbody.append(el('tr', {},
        el('td', {}, a.email, isMe ? el('span', { class: 'badge ok', text: '나', style: 'margin-left:6px' }) : null),
        el('td', { class: 'nowrap', text: fmt(a.created_at) }),
        el('td', {}, isMe ? el('span', { class: 'muted small', text: '본인은 해제 불가' })
          : el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '권한 해제', onclick: () => removeAdmin(a.email) }))
      ));
    }
  }

  async function removeAdmin(email) {
    if (!confirm(`${email} 의 관리자 권한을 해제할까요?`)) return;
    const { error } = await db.rpc('remove_admin', { p_email: email });
    if (error) { toast('실패: ' + errorText(error)); return; }
    toast('권한을 해제했습니다.');
    await runLoader('teachers');
  }

  $('#addTeacherForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const msg = $('#addTeacherMsg');
    if (f.password.value.length < 6) { showMsg(msg, '비밀번호는 6자 이상이어야 합니다.'); return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    showMsg(msg, '계정을 만드는 중…', true);
    try {
      const email = await createAdminAccount(f.email.value.trim(), f.password.value, f.code.value);
      f.reset();
      showMsg(msg, `${email} 계정을 관리자로 등록했습니다. 이 이메일과 비밀번호를 해당 선생님께 전달해 주세요.`, true);
      await runLoader('teachers');
    } catch (err) {
      showMsg(msg, errorText(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------
  // 9. 시작: 이미 로그인되어 있으면 바로 관리 화면, 아니면 로그인 화면
  // ---------------------------------------------------------------
  enterApp().catch((err) => {
    console.error(err);
    showAuth();
    showMsg($('#loginMsg'), errorText(err));
  });
})();
