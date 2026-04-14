# PROJECT FLOW — 배포 가이드

## 전체 흐름

```
GitHub (코드 보관)
    ↓ 자동 배포
Vercel (백엔드 + 프론트 호스팅, 무료)
    ↓
Anthropic API  /  Google Sheets  /  Google OAuth
```

---

## STEP 1 — GitHub 리포지토리 생성

1. [github.com](https://github.com) 로그인
2. **New repository** 클릭
3. 이름: `project-flow` / **Public** / Create
4. 이 폴더 파일들 전체 업로드 (Add file → Upload)

---

## STEP 2 — Google Cloud 설정 (30분)

### 2-1. 프로젝트 생성
1. [console.cloud.google.com](https://console.cloud.google.com) 접속
2. 상단 프로젝트 선택 → **새 프로젝트** → 이름: `project-flow`

### 2-2. API 활성화
**API 및 서비스 → 라이브러리**에서 아래 2개 검색 후 활성화:
- ✅ `Google Sheets API`
- ✅ `Google Identity Services`

### 2-3. OAuth 2.0 클라이언트 ID 생성 (로그인용)
1. **API 및 서비스 → 사용자 인증 정보**
2. **+ 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
3. 유형: **웹 애플리케이션**
4. 승인된 JavaScript 출처 추가:
   ```
   https://your-app.vercel.app
   http://localhost:3000
   ```
5. 승인된 리디렉션 URI 추가:
   ```
   https://your-app.vercel.app/api/auth/callback
   http://localhost:3000/api/auth/callback
   ```
6. **만들기** → **클라이언트 ID**와 **클라이언트 보안 비밀번호** 복사

### 2-4. 서비스 계정 생성 (Sheets 읽기/쓰기용)
1. **API 및 서비스 → 사용자 인증 정보**
2. **+ 사용자 인증 정보 → 서비스 계정**
3. 이름: `project-flow-sheets` → 완료
4. 생성된 서비스 계정 클릭 → **키** 탭 → **키 추가 → JSON**
5. 다운로드된 JSON 파일 저장 (나중에 환경변수에 입력)

### 2-5. Google Sheets 준비
1. [sheets.google.com](https://sheets.google.com) 에서 새 스프레드시트 생성
2. 이름: `PROJECT FLOW 데이터`
3. 시트 3개 생성:
   - `Projects` (프로젝트 목록)
   - `Tasks` (작업 항목)
   - `TaskUpdates` (진행 업데이트 이력)
4. **공유 → 서비스 계정 이메일 추가 → 편집자 권한**
   (서비스 계정 이메일: `project-flow-sheets@your-project.iam.gserviceaccount.com`)
5. URL에서 Sheet ID 복사:
   `https://docs.google.com/spreadsheets/d/[이부분]/edit`

---

## STEP 3 — Vercel 배포

1. [vercel.com](https://vercel.com) → GitHub으로 로그인
2. **Add New → Project**
3. GitHub 리포지토리 선택 → **Import**
4. **Environment Variables** 탭에서 아래 환경변수 모두 입력:

| 변수명 | 값 |
|--------|-----|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` |
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 보안 비밀번호 |
| `GOOGLE_SHEET_ID` | Sheets ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON 파일 내용 전체 (한 줄로) |
| `ADMIN_EMAILS` | `본인이메일@gmail.com` |
| `SESSION_SECRET` | 임의의 랜덤 문자열 |
| `APP_URL` | (배포 후 Vercel이 자동 설정) |

5. **Deploy** 클릭

배포 완료 후 `https://project-flow-xxx.vercel.app` 주소 생성

---

## STEP 4 — Google OAuth에 Vercel URL 추가

배포 후 생성된 URL을 Google Cloud Console OAuth 설정에 추가:
1. Cloud Console → 사용자 인증 정보 → OAuth 클라이언트 편집
2. 승인된 JavaScript 출처에 `https://project-flow-xxx.vercel.app` 추가
3. 승인된 리디렉션 URI에 `https://project-flow-xxx.vercel.app/api/auth/callback` 추가
4. 저장

---

## STEP 5 — 관리자 이메일 설정

`ADMIN_EMAILS` 환경변수에 관리자로 사용할 구글 계정 이메일 등록.
나머지 사람들은 자동으로 **작업자** 권한으로 로그인됩니다.

---

## 작업자에게 공유하는 방법

```
PROJECT FLOW 접속 링크: https://project-flow-xxx.vercel.app
- 구글 계정으로 로그인하면 바로 사용 가능합니다
- 별도 가입이나 설치 없이 구글 계정 하나면 됩니다
```

---

## 계정 전환 (개인 → 회사)

| 항목 | 방법 |
|------|------|
| GitHub | 리포를 회사 Organization으로 Transfer |
| Vercel | 팀 계정으로 프로젝트 이전 |
| Google Cloud | 회사 Workspace 프로젝트로 이전 |
| 환경변수 | `ADMIN_EMAILS`에 회사 이메일 추가 |
| 비용 | Vercel, Sheets 모두 무료 유지, AI 비용만 회사 카드로 교체 |

---

## 로컬 테스트

```bash
npm install -g vercel
vercel dev
# → http://localhost:3000
```

`.env` 파일 생성 후 `.env.example` 내용 채워넣기.
