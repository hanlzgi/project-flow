// api/auth.js — Google OAuth2 로그인 콜백 처리
// 흐름: 프론트 → Google 로그인 팝업 → /api/auth/callback → 세션 토큰 발급

export default async function handler(req, res) {
  const { action, code, credential } = req.body || req.query || {};

  // ── 1. Google OAuth URL 생성 ─────────────────────────────
  if (action === 'getUrl') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID 미설정' });

    const redirectUri = `${process.env.APP_URL || ''}/api/auth/callback`;
    const scope = encodeURIComponent(
      'openid email profile'
    );
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&access_type=offline` +
      `&prompt=select_account`;

    return res.status(200).json({ url });
  }

  // ── 2. Google One Tap / ID 토큰 검증 ─────────────────────
  if (action === 'verifyIdToken' && credential) {
    try {
      const userInfo = await verifyGoogleIdToken(credential);
      const role = getRole(userInfo.email);
      const sessionToken = makeSessionToken(userInfo, role);

      return res.status(200).json({
        ok: true,
        user: {
          email:   userInfo.email,
          name:    userInfo.name,
          picture: userInfo.picture,
          role,
        },
        token: sessionToken,
      });
    } catch (e) {
      return res.status(401).json({ error: '토큰 검증 실패: ' + e.message });
    }
  }

  // ── 3. OAuth Authorization Code 교환 ────────────────────
  if (action === 'exchangeCode' && code) {
    try {
      const tokenData = await exchangeCode(code, req);
      const userInfo  = await getGoogleUserInfo(tokenData.access_token);
      const role      = getRole(userInfo.email);
      const sessionToken = makeSessionToken(userInfo, role);

      return res.status(200).json({
        ok: true,
        user: { email: userInfo.email, name: userInfo.name, picture: userInfo.picture, role },
        token: sessionToken,
      });
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  // ── 4. 세션 토큰 검증 ────────────────────────────────────
  if (action === 'verify') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '');
    try {
      const payload = decodeSessionToken(token);
      return res.status(200).json({ ok: true, user: payload });
    } catch {
      return res.status(401).json({ error: '세션 만료 또는 유효하지 않음' });
    }
  }

  return res.status(400).json({ error: '알 수 없는 action' });
}

// ── 헬퍼 함수들 ──────────────────────────────────────────────

function getRole(email) {
  // 관리자 이메일 목록 (환경변수로 설정)
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  return admins.includes(email.toLowerCase()) ? 'manager' : 'worker';
}

function makeSessionToken(userInfo, role) {
  // 간단한 Base64 토큰 (프로덕션은 JWT 사용 권장)
  const payload = {
    email:   userInfo.email,
    name:    userInfo.name,
    picture: userInfo.picture,
    role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7일
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeSessionToken(token) {
  const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  if (payload.exp < Date.now()) throw new Error('세션 만료');
  return payload;
}

async function verifyGoogleIdToken(credential) {
  // Google tokeninfo 엔드포인트로 간단 검증
  const resp = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
  );
  if (!resp.ok) throw new Error('구글 토큰 검증 실패');
  const data = await resp.json();
  if (!data.email) throw new Error('이메일 정보 없음');
  return { email: data.email, name: data.name, picture: data.picture };
}

async function exchangeCode(code, req) {
  const redirectUri = `${process.env.APP_URL || ''}/api/auth/callback`;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(data.error_description || '코드 교환 실패');
  return data;
}

async function getGoogleUserInfo(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.json();
}
