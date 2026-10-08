// =====================================================================
// Supabase 연결 설정
// ---------------------------------------------------------------------
// - SUPABASE_URL      : Supabase 대시보드 → Project Settings → API(또는 Data API)의 Project URL
//                       ※ 끝에 /rest/v1/ 은 붙이지 않습니다.
// - SUPABASE_ANON_KEY : 같은 화면의 anon(public) 또는 publishable 키
//
// 이 두 값은 "공개되어도 되는" 값입니다. GitHub Pages에 올리면 누구나 볼 수 있지만,
// 실제로 무엇을 읽고 쓸 수 있는지는 데이터베이스의 RLS 정책과 함수가 막아 줍니다.
//
// ⚠️ 절대 넣으면 안 되는 값: service_role 키, secret 키 (모든 보안을 무시하는 관리자 열쇠)
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://ljrdiibfskstlcggoyyg.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqcmRpaWJmc2tzdGxjZ2dveXlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MzExNzAsImV4cCI6MjEwNzAwNzE3MH0.ZIe9drySU5Co11AvjNbjflzPZgbBoaZgOMDFirGd6EU',

  // 작품 이미지를 저장하는 Storage 버킷 이름 (schema.sql 에서 만든 이름과 같아야 함)
  STORAGE_BUCKET: 'artworks',
};
