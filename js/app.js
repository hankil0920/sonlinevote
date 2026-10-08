// =====================================================================
// 학생용 화면 (index.html) 동작 코드
// ---------------------------------------------------------------------
// 큰 흐름
//   1) 사이트 설정·작품 목록·하트/댓글 숫자를 불러와 카드 그리드를 그립니다. (로그인 전에도 가능)
//   2) 로그인: Supabase 익명 로그인 → claim_student 함수로 학교·학번·이름 프로필에 이 기기를 연결
//   3) 하트: 누르는 즉시 화면에 반영(낙관적 업데이트)하고, 서버 결과로 숫자를 맞춥니다.
//            서버에서 실패하면 원래대로 되돌립니다.
//   4) 댓글: list_comments 로 읽고, add_comment / delete_my_comment 로 쓰고 지웁니다.
//
// 보안 메모
//   이 파일은 누구나 볼 수 있고 고칠 수도 있습니다. 그래서 투표 기간·본인 여부·글자 수 같은
//   "진짜 검사"는 모두 데이터베이스 함수 안에서 다시 합니다. 여기의 검사는 사용 편의를 위한 것입니다.
// =====================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // 0. Supabase 연결
  // ---------------------------------------------------------------
  const CONFIG = window.APP_CONFIG || {};
  const BUCKET = CONFIG.STORAGE_BUCKET || 'artworks';
  let db = null;
  try {
    db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  } catch (e) {
    // 설정이 비었거나 라이브러리를 못 불러온 경우 → 아래 init 에서 오류 화면을 보여 줌
    console.error('Supabase 연결 준비 실패', e);
  }

  // ---------------------------------------------------------------
  // 1. 화면 상태(state): 화면에 그릴 데이터를 한곳에 모아 둡니다.
  // ---------------------------------------------------------------
  const state = {
    settings: { site_title: '캐릭터 공모전 투표', notice: '', voting_open: false },
    artworks: [],          // [{ id, title, author, description, image_path, created_at }]
    stats: new Map(),      // 작품 id → { like_count, comment_count, liked_by_me }
    me: null,              // 로그인한 학생 { id, school, student_no, name } 또는 null
    sort: 'random',        // 'random' | 'popular' | 'latest'
    openId: null,          // 상세 모달에 열려 있는 작품 id
    comments: [],          // 열려 있는 작품의 댓글 목록
    pendingLike: new Set() // 서버 응답을 기다리는 작품 id (연타 방지)
  };

  // ---------------------------------------------------------------
  // 2. 자주 쓰는 작은 도구들
  // ---------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  /**
   * HTML 요소를 만드는 도우미.
   * 글자는 항상 textContent 로 넣기 때문에, 학생이 댓글에 <script> 같은 것을 써도
   * 코드로 실행되지 않고 글자 그대로 보입니다. (XSS 공격 방지)
   */
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

  // 하트 아이콘 (SVG). 색은 CSS 에서 칠합니다.
  function heartIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 21s-7.5-4.6-9.6-9.1C.9 8.6 2.9 4.5 6.7 4.5c2.2 0 3.6 1.2 4.3 2.4.7-1.2 2.1-2.4 4.3-2.4 3.8 0 5.8 4.1 4.3 7.4C19.5 16.4 12 21 12 21z');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  // Storage 에 있는 이미지의 공개 주소 만들기
  function imageUrl(path) {
    return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // 날짜를 '10월 8일 14:05' 처럼 짧게
  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // 잠깐 떴다 사라지는 알림
  let toastTimer = null;
  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
  }

  /**
   * 데이터베이스 함수가 보낸 오류를 학생이 이해할 수 있는 문장으로 바꿉니다.
   * schema.sql 의 함수들은 오류마다 hint 에 한국어 설명을 담아 보냅니다.
   */
  const ERROR_TEXT = {
    NOT_SIGNED_IN: '로그인이 필요합니다.',
    NOT_STUDENT: '로그인이 필요합니다. 다른 기기에서 로그인했다면 다시 로그인해 주세요.',
    VOTING_CLOSED: '지금은 투표 기간이 아닙니다.',
    NAME_MISMATCH: '이미 다른 이름으로 등록된 학번입니다. 학교·학번·이름을 다시 확인해 주세요.',
    TOO_LONG: '댓글은 200자까지 쓸 수 있습니다.',
  };
  function errorText(error) {
    if (!error) return '알 수 없는 오류가 발생했습니다.';
    if (error.hint) return error.hint;
    if (ERROR_TEXT[error.message]) return ERROR_TEXT[error.message];
    if (/anonymous sign-ins are disabled/i.test(error.message)) {
      return '익명 로그인이 꺼져 있습니다. 선생님께 알려 주세요. (Supabase 설정 필요)';
    }
    if (/rate limit/i.test(error.message)) {
      return '잠시 후 다시 시도해 주세요. (로그인 요청이 너무 많습니다)';
    }
    if (/Failed to fetch|NetworkError/i.test(error.message)) {
      return '인터넷 연결을 확인해 주세요.';
    }
    return '오류가 발생했습니다: ' + error.message;
  }

  // 모달 열기/닫기 (<dialog> 사용: Esc 키로 닫기, 포커스 가두기를 브라우저가 처리)
  function openModal(dialog) {
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('modal-open');
  }
  function closeModal(dialog) {
    if (dialog.open) dialog.close();
  }
  document.querySelectorAll('dialog.modal').forEach((dialog) => {
    // 닫힐 때: 다른 모달이 열려 있지 않으면 배경 스크롤 다시 허용
    dialog.addEventListener('close', () => {
      if (!document.querySelector('dialog.modal[open]')) document.body.classList.remove('modal-open');
      if (dialog.id === 'detailModal') state.openId = null;
    });
    // ✕ 버튼
    dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(dialog)));
    // 모달 바깥(어두운 배경)을 누르면 닫기
    dialog.addEventListener('click', (e) => { if (e.target === dialog) closeModal(dialog); });
  });

  // ---------------------------------------------------------------
  // 3. 데이터 불러오기
  // ---------------------------------------------------------------
  async function loadSettings() {
    const { data, error } = await db.from('settings').select('site_title, notice, voting_open').eq('id', 1).maybeSingle();
    if (error) throw error;
    if (data) state.settings = data;
  }

  async function loadArtworks() {
    // 숨긴 작품은 RLS 정책 때문에 학생에게 아예 오지 않습니다.
    const { data, error } = await db
      .from('artworks')
      .select('id, title, author, description, image_path, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    state.artworks = data || [];
  }

  async function loadStats() {
    // 하트·댓글 개수는 표를 직접 읽지 않고 함수로만 받습니다. (다른 학생의 하트 기록 보호)
    const { data, error } = await db.rpc('get_artwork_stats');
    if (error) throw error;
    state.stats = new Map((data || []).map((row) => [row.artwork_id, row]));
  }

  function statOf(id) {
    return state.stats.get(id) || { like_count: 0, comment_count: 0, liked_by_me: false };
  }

  /**
   * 이 기기에 연결된 학생 프로필 확인.
   * students 표는 RLS 때문에 "내 프로필"만 읽힙니다.
   * 다른 기기에서 같은 학번으로 로그인했다면 연결이 옮겨져서 여기서 아무것도 안 나옵니다.
   */
  async function loadMe() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { state.me = null; return; }
    const { data, error } = await db
      .from('students')
      .select('id, school, student_no, name')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) { console.warn(error); state.me = null; return; }
    const wasLoggedIn = safeStorage.get('sv_logged_in') === '1';
    state.me = data || null;
    if (!state.me && wasLoggedIn) {
      safeStorage.remove('sv_logged_in');
      toast('다른 기기에서 로그인되어 이 기기의 연결이 해제되었습니다.');
    }
  }

  // 개인 브라우저 저장소(없거나 막혀 있어도 오류가 나지 않게 감싼 버전)
  const safeStorage = {
    get(key, store = localStorage) { try { return store.getItem(key); } catch { return null; } },
    set(key, value, store = localStorage) { try { store.setItem(key, value); } catch { /* 무시 */ } },
    remove(key, store = localStorage) { try { store.removeItem(key); } catch { /* 무시 */ } },
  };

  // ---------------------------------------------------------------
  // 4. 정렬
  // ---------------------------------------------------------------
  /**
   * 랜덤 순서는 "세션 동안 고정"되어야 합니다. (하트를 누를 때마다 순서가 바뀌면 헷갈리므로)
   * 작품마다 임의의 숫자를 하나씩 정해 sessionStorage 에 저장해 두고, 그 숫자로 정렬합니다.
   * 탭(창)을 닫으면 sessionStorage 가 지워져서 다음 방문 때는 새로운 순서가 됩니다.
   */
  function randomKeys() {
    let keys = {};
    try { keys = JSON.parse(safeStorage.get('sv_random', sessionStorage) || '{}'); } catch { keys = {}; }
    let changed = false;
    for (const a of state.artworks) {
      if (typeof keys[a.id] !== 'number') { keys[a.id] = Math.random(); changed = true; }
    }
    if (changed) safeStorage.set('sv_random', JSON.stringify(keys), sessionStorage);
    return keys;
  }

  function sortedArtworks() {
    const list = state.artworks.slice();
    if (state.sort === 'popular') {
      // 하트 많은 순 → 같으면 댓글 많은 순 → 같으면 먼저 올라온 순
      list.sort((a, b) => {
        const sa = statOf(a.id), sb = statOf(b.id);
        return (sb.like_count - sa.like_count) || (sb.comment_count - sa.comment_count) ||
               a.created_at.localeCompare(b.created_at);
      });
    } else if (state.sort === 'latest') {
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else {
      const keys = randomKeys();
      list.sort((a, b) => keys[a.id] - keys[b.id]);
    }
    return list;
  }

  // ---------------------------------------------------------------
  // 5. 화면 그리기
  // ---------------------------------------------------------------
  function renderHeader() {
    const s = state.settings;
    $('#siteTitle').textContent = s.site_title || '캐릭터 공모전 투표';
    document.title = s.site_title || '캐릭터 공모전 투표';
    $('#notice').textContent = s.notice || '';

    const pill = $('#votingPill');
    pill.hidden = false;
    pill.classList.toggle('open', !!s.voting_open);
    pill.textContent = s.voting_open ? '투표 진행 중' : '투표 마감 · 보기만 가능';

    // 로그인 영역
    const area = $('#meArea');
    area.replaceChildren();
    if (state.me) {
      area.append(
        el('span', { class: 'me-name', text: state.me.name + ' 님' }),
        el('button', { type: 'button', class: 'btn btn-sm', text: '로그아웃', onclick: logout })
      );
    } else {
      area.append(el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '로그인', onclick: () => openLogin() }));
    }
  }

  // 불러오는 동안 보여 줄 회색 카드(스켈레톤)
  function renderSkeleton() {
    const grid = $('#grid');
    grid.replaceChildren();
    for (let i = 0; i < 8; i++) {
      grid.append(el('div', { class: 'card skeleton', 'aria-hidden': 'true' },
        el('div', { class: 'card-thumb' }),
        el('div', { class: 'sk-line' }),
        el('div', { class: 'sk-line short' })
      ));
    }
    $('#stateBox').hidden = true;
  }

  /**
   * 하트 버튼(또는 마감 시 숫자만) 만들기.
   * big = true 이면 상세 모달용 큰 버튼.
   */
  function likeControl(artworkId, big) {
    const st = statOf(artworkId);
    if (!state.settings.voting_open) {
      // 투표 마감: 누를 수 없는 숫자 표시만
      return el('span', { class: 'like-count-static', title: '투표가 마감되었습니다' },
        heartIcon(), el('span', { text: String(st.like_count) }));
    }
    const btn = el('button', {
      type: 'button',
      class: 'like-btn' + (big ? ' big' : '') + (st.liked_by_me ? ' liked' : ''),
      'aria-pressed': st.liked_by_me ? 'true' : 'false',
      'aria-label': st.liked_by_me ? '하트 취소' : '하트 누르기',
      'data-like': artworkId,
      onclick: (e) => { e.stopPropagation(); toggleLike(artworkId); },
    }, heartIcon(), el('span', { class: 'like-num', text: String(st.like_count) }));
    return btn;
  }

  function renderGrid() {
    const grid = $('#grid');
    const box = $('#stateBox');
    grid.replaceChildren();

    if (state.artworks.length === 0) {
      box.hidden = false;
      box.replaceChildren(
        el('span', { class: 'state-emoji', text: '🖼️' }),
        el('p', { text: '아직 등록된 작품이 없어요. 조금만 기다려 주세요!' })
      );
      return;
    }
    box.hidden = true;

    for (const a of sortedArtworks()) {
      const st = statOf(a.id);
      const card = el('article', { class: 'card', 'data-id': a.id },
        el('button', { type: 'button', class: 'card-open', 'aria-label': (a.title || '작품') + ' 크게 보기', onclick: () => openDetail(a.id) },
          el('div', { class: 'card-thumb' },
            el('img', { src: imageUrl(a.image_path), alt: a.title || '출품작', loading: 'lazy', decoding: 'async' })
          ),
          el('div', { class: 'card-text' },
            el('p', { class: 'card-title', text: a.title || '제목 없음' }),
            a.author ? el('p', { class: 'card-author', text: a.author }) : null
          )
        ),
        el('div', { class: 'card-actions' },
          likeControl(a.id, false),
          el('span', { class: 'card-comments', 'aria-label': '댓글 ' + st.comment_count + '개' }, '💬 ', String(st.comment_count))
        )
      );
      grid.append(card);
    }
  }

  function renderError(error) {
    $('#grid').replaceChildren();
    const box = $('#stateBox');
    box.hidden = false;
    const configMissing = !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !db;
    box.replaceChildren(
      el('span', { class: 'state-emoji', text: '⚠️' }),
      el('p', { text: configMissing
        ? '사이트 설정(js/config.js)이 비어 있거나 Supabase 라이브러리를 불러오지 못했습니다.'
        : '작품을 불러오지 못했어요. ' + errorText(error) }),
      el('button', { type: 'button', class: 'btn', text: '다시 시도', onclick: init })
    );
  }

  // 하트 숫자·모양만 빠르게 다시 그리기 (카드 전체를 다시 그리면 이미지가 깜빡이므로)
  function refreshLikeUI(artworkId, animate) {
    const st = statOf(artworkId);
    document.querySelectorAll(`[data-like="${artworkId}"]`).forEach((btn) => {
      btn.classList.toggle('liked', st.liked_by_me);
      btn.setAttribute('aria-pressed', st.liked_by_me ? 'true' : 'false');
      btn.setAttribute('aria-label', st.liked_by_me ? '하트 취소' : '하트 누르기');
      btn.querySelector('.like-num').textContent = String(st.like_count);
      if (animate) {
        btn.classList.remove('pop');
        void btn.offsetWidth;          // 애니메이션을 처음부터 다시 재생하기 위한 요령
        btn.classList.add('pop');
      }
    });
  }

  // ---------------------------------------------------------------
  // 6. 하트 누르기 (낙관적 업데이트)
  // ---------------------------------------------------------------
  async function toggleLike(artworkId) {
    if (!state.me) { openLogin('하트를 누르려면 먼저 로그인해 주세요.'); return; }
    if (!state.settings.voting_open) { toast('투표가 마감되었습니다.'); return; }
    if (state.pendingLike.has(artworkId)) return;   // 이전 요청 처리 중이면 무시(연타 방지)

    // (1) 먼저 화면부터 바꿉니다.
    const before = { ...statOf(artworkId) };
    const after = {
      ...before,
      liked_by_me: !before.liked_by_me,
      like_count: Math.max(0, before.like_count + (before.liked_by_me ? -1 : 1)),
    };
    state.stats.set(artworkId, after);
    refreshLikeUI(artworkId, after.liked_by_me);

    // (2) 서버에 요청
    state.pendingLike.add(artworkId);
    const { data, error } = await db.rpc('toggle_like', { p_artwork_id: artworkId });
    state.pendingLike.delete(artworkId);

    if (error) {
      // (3-a) 실패 → 원래대로 되돌리기
      state.stats.set(artworkId, before);
      refreshLikeUI(artworkId, false);
      await handleActionError(error);
      return;
    }
    // (3-b) 성공 → 서버가 알려 준 정확한 값으로 맞추기 (그 사이 다른 학생이 누른 것도 반영)
    state.stats.set(artworkId, { ...statOf(artworkId), liked_by_me: data.liked, like_count: data.like_count });
    refreshLikeUI(artworkId, false);
  }

  // 하트·댓글 요청이 실패했을 때 공통 처리
  async function handleActionError(error) {
    toast(errorText(error));
    if (error.message === 'NOT_STUDENT') {
      // 다른 기기에서 로그인해 연결이 끊긴 경우 → 로그아웃 상태로 바꾸고 로그인 창 열기
      state.me = null;
      safeStorage.remove('sv_logged_in');
      renderHeader();
      openLogin('다른 기기에서 로그인되어 연결이 해제되었습니다. 다시 로그인해 주세요.');
    } else if (error.message === 'VOTING_CLOSED') {
      // 그 사이 선생님이 투표를 마감한 경우 → 최신 상태로 다시 그리기
      await refreshAll();
    }
  }

  // ---------------------------------------------------------------
  // 7. 상세 모달 (이미지 + 하트 + 설명 + 댓글)
  // ---------------------------------------------------------------
  function openDetail(artworkId) {
    const a = state.artworks.find((x) => x.id === artworkId);
    if (!a) return;
    state.openId = artworkId;

    const img = $('#detailImage');
    img.src = imageUrl(a.image_path);
    img.alt = a.title || '출품작';
    $('#detailTitle').textContent = a.title || '제목 없음';
    $('#detailAuthor').textContent = a.author ? '출품자 · ' + a.author : '';
    $('#detailDesc').textContent = a.description || '';
    renderDetailLike();
    renderCommentForm();
    state.comments = [];
    renderComments(true);

    openModal($('#detailModal'));
    $('#detailModal').querySelector('.detail-info').scrollTop = 0;
    loadComments(artworkId);
  }

  function renderDetailLike() {
    const box = $('#detailLike');
    box.replaceChildren();
    if (!state.openId) return;
    box.append(likeControl(state.openId, true));
    if (!state.settings.voting_open) {
      box.append(el('p', { class: 'closed-note', text: '투표가 마감되어 하트를 누를 수 없어요.' }));
    } else if (!state.me) {
      box.append(el('button', { type: 'button', class: 'btn-text', text: '로그인하고 투표하기', onclick: () => openLogin() }));
    }
  }

  function renderCommentForm() {
    const area = $('#commentFormArea');
    area.replaceChildren();

    if (!state.settings.voting_open) {
      area.append(el('p', { class: 'closed-note', text: '투표가 마감되어 댓글은 보기만 가능해요.' }));
      return;
    }
    if (!state.me) {
      area.append(el('p', { class: 'closed-note' },
        '댓글을 쓰려면 ',
        el('button', { type: 'button', class: 'btn-text', text: '로그인', onclick: () => openLogin() }),
        '해 주세요.'
      ));
      return;
    }

    const textarea = el('textarea', { name: 'body', maxLength: 200, placeholder: '작품에 대한 응원의 말을 남겨 주세요 (200자까지)', required: true });
    const counter = el('span', { class: 'char-count', text: '0 / 200' });
    const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: '등록' });
    textarea.addEventListener('input', () => {
      const n = textarea.value.length;
      counter.textContent = n + ' / 200';
      counter.classList.toggle('over', n > 200);
    });
    const form = el('form', { class: 'comment-form', onsubmit: (e) => { e.preventDefault(); submitComment(textarea, submit, counter); } },
      textarea,
      el('div', { class: 'comment-form-row' }, counter, submit)
    );
    area.append(form);
  }

  async function loadComments(artworkId) {
    const { data, error } = await db.rpc('list_comments', { p_artwork_id: artworkId });
    if (state.openId !== artworkId) return;   // 그 사이 다른 작품을 열었다면 무시
    if (error) {
      $('#commentList').replaceChildren(el('li', { class: 'comment-empty', text: '댓글을 불러오지 못했어요. ' + errorText(error) }));
      return;
    }
    state.comments = data || [];
    // 카드의 댓글 수도 최신 값으로 맞추기
    const st = statOf(artworkId);
    if (st.comment_count !== state.comments.length && state.comments.length < 300) {
      state.stats.set(artworkId, { ...st, comment_count: state.comments.length });
      renderGrid();
    }
    renderComments(false);
  }

  function renderComments(loading) {
    const list = $('#commentList');
    list.replaceChildren();
    $('#commentCount').textContent = loading ? '' : String(state.comments.length);
    if (loading) {
      list.append(el('li', { class: 'comment-empty', text: '댓글을 불러오는 중…' }));
      return;
    }
    if (state.comments.length === 0) {
      list.append(el('li', { class: 'comment-empty', text: '아직 댓글이 없어요. 첫 댓글을 남겨 보세요!' }));
      return;
    }
    for (const c of state.comments) {
      const canDelete = c.is_mine && state.me && state.settings.voting_open;
      list.append(el('li', { class: 'comment' },
        el('div', { class: 'comment-head' },
          el('span', { class: 'comment-author', text: c.author_masked }),
          c.is_mine ? el('span', { class: 'comment-mine', text: '내 댓글' }) : null,
          el('time', { class: 'comment-time', dateTime: c.created_at, text: formatTime(c.created_at) }),
          canDelete ? el('button', { type: 'button', class: 'btn-text', text: '삭제', onclick: () => deleteComment(c.id) }) : null
        ),
        el('p', { class: 'comment-body', text: c.body })
      ));
    }
  }

  async function submitComment(textarea, submit, counter) {
    const body = textarea.value.trim();
    if (!body) { toast('댓글 내용을 입력해 주세요.'); return; }
    if (body.length > 200) { toast('댓글은 200자까지 쓸 수 있어요.'); return; }
    const artworkId = state.openId;

    submit.disabled = true;
    const { data, error } = await db.rpc('add_comment', { p_artwork_id: artworkId, p_body: body });
    submit.disabled = false;

    if (error) { await handleActionError(error); return; }

    textarea.value = '';
    counter.textContent = '0 / 200';
    if (state.openId === artworkId) {
      state.comments.unshift(data);   // 새 댓글을 맨 위에
      renderComments(false);
    }
    const st = statOf(artworkId);
    state.stats.set(artworkId, { ...st, comment_count: st.comment_count + 1 });
    renderGrid();
    toast('댓글을 남겼어요.');
  }

  async function deleteComment(commentId) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const artworkId = state.openId;
    const { error } = await db.rpc('delete_my_comment', { p_comment_id: commentId });
    if (error) { await handleActionError(error); return; }
    state.comments = state.comments.filter((c) => c.id !== commentId);
    renderComments(false);
    const st = statOf(artworkId);
    state.stats.set(artworkId, { ...st, comment_count: Math.max(0, st.comment_count - 1) });
    renderGrid();
    toast('댓글을 삭제했어요.');
  }

  // ---------------------------------------------------------------
  // 8. 로그인 / 로그아웃
  // ---------------------------------------------------------------
  function openLogin(message) {
    const err = $('#loginError');
    err.hidden = !message;
    err.textContent = message || '';
    openModal($('#loginModal'));
    setTimeout(() => $('#loginForm').school.focus(), 50);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const school = form.school.value.trim();
    const studentNo = form.studentNo.value.trim();
    const name = form.name.value.trim();
    const agree = form.agree.checked;
    const err = $('#loginError');

    // 빈 칸·동의 확인 (진짜 검사는 서버의 claim_student 함수가 다시 함)
    let problem = '';
    if (!school) problem = '학교 이름을 입력해 주세요.';
    else if (!studentNo) problem = '학번을 입력해 주세요.';
    else if (!name) problem = '이름을 입력해 주세요.';
    else if (!agree) problem = '개인정보 수집·이용에 동의해야 참여할 수 있어요.';
    if (problem) { err.textContent = problem; err.hidden = false; return; }

    const btn = $('#loginSubmit');
    btn.disabled = true;
    btn.textContent = '확인 중…';
    err.hidden = true;

    try {
      // (1) 이 기기에 익명 로그인 세션이 없으면 새로 만들기
      let { data: { session } } = await db.auth.getSession();
      if (session && !session.user.is_anonymous) {
        // 같은 브라우저에서 관리자로 로그인해 둔 경우: 학생 로그인과 섞이지 않게 먼저 로그아웃
        await db.auth.signOut();
        session = null;
      }
      if (!session) {
        const { error } = await db.auth.signInAnonymously();
        if (error) throw error;
      }
      // (2) 학교·학번·이름으로 학생 프로필 만들기/연결하기
      const { data, error } = await db.rpc('claim_student', {
        p_school: school, p_student_no: studentNo, p_name: name, p_agree: agree,
      });
      if (error) throw error;

      state.me = data;
      safeStorage.set('sv_logged_in', '1');
      form.reset();
      closeModal($('#loginModal'));
      toast(data.name + ' 님, 환영해요!');
      // 이 기기로 처음 로그인했거나 다른 기기에서 넘어왔으면 "내가 누른 하트" 표시를 새로 받아야 함
      await refreshAll();
    } catch (error) {
      err.textContent = errorText(error);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  });

  async function logout() {
    if (!confirm('로그아웃할까요?')) return;
    await db.auth.signOut();
    state.me = null;
    safeStorage.remove('sv_logged_in');
    await refreshAll();
    toast('로그아웃했어요.');
  }

  // ---------------------------------------------------------------
  // 9. 정렬 탭
  // ---------------------------------------------------------------
  document.querySelectorAll('.sort-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.sort = tab.dataset.sort;
      safeStorage.set('sv_sort', state.sort, sessionStorage);
      document.querySelectorAll('.sort-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      renderGrid();
    });
  });
  function restoreSortTab() {
    const saved = safeStorage.get('sv_sort', sessionStorage);
    if (saved && ['random', 'popular', 'latest'].includes(saved)) state.sort = saved;
    document.querySelectorAll('.sort-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.sort === state.sort)));
  }

  // ---------------------------------------------------------------
  // 10. 시작 & 새로고침
  // ---------------------------------------------------------------
  // 설정·숫자만 다시 받아 화면을 맞춤 (로그인/로그아웃 직후, 다른 탭에서 돌아왔을 때)
  async function refreshAll() {
    try {
      await Promise.all([loadSettings(), loadArtworks()]);
      await loadStats();
      renderHeader();
      renderGrid();
      if (state.openId) {
        if (state.artworks.some((a) => a.id === state.openId)) {
          renderDetailLike();
          renderCommentForm();
          loadComments(state.openId);
        } else {
          closeModal($('#detailModal'));   // 그 사이 숨겨진 작품
        }
      }
    } catch (error) {
      console.error(error);
      toast('최신 정보를 불러오지 못했어요.');
    }
  }

  async function init() {
    renderSkeleton();
    restoreSortTab();
    if (!db) { renderError(); return; }
    try {
      await loadMe();                                  // 로그인 상태 먼저 (liked_by_me 계산에 필요)
      await Promise.all([loadSettings(), loadArtworks(), loadStats()]);
      renderHeader();
      renderGrid();
    } catch (error) {
      console.error(error);
      renderHeader();
      renderError(error);
    }
  }

  // 다른 앱/탭에 갔다가 돌아오면 숫자와 투표 상태를 새로 받아 옴 (최소 30초 간격)
  let lastRefresh = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && db && Date.now() - lastRefresh > 30000) {
      lastRefresh = Date.now();
      refreshAll();
    }
  });

  init();
})();
