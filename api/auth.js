// api/auth.js — Google OAuth2 로그인 + Workers 시트에서 작업자 정보 조회

export default async function handler(req, res) {
  const { action, code, credential } = req.body || req.query || {};

  // ── 0. 이메일 로그인 ─────────────────────────────────────
  if (action === 'emailLogin') {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: '유효한 이메일 필요' });
    }
    const role = getRole(email);

    // Workers 시트에서 이 이메일로 등록된 작업자 이름 조회
    const workerInfo = await lookupWorkerByEmail(email);

    const user = {
      email,
      name:    workerInfo?.name || email.split('@')[0], // 마스터에 등록된 이름 우선
      picture: '',
      role,
      workerName: workerInfo?.name || '',  // 작업자 등록 이름 (task 매칭용)
      workerId:   workerInfo?.id   || '',
    };
    const token = makeSessionToken(user);
    return res.status(200).json({ ok: true, user, token });
  }

  // ── 1. Google One Tap ID 토큰 검증 ───────────────────────
  if (action === 'verifyIdToken' && credential) {
    try {
      const googleUser = await verifyGoogleIdToken(credential);
      const role = getRole(googleUser.email);

      // Workers 시트에서 이메일로 등록된 작업자 이름 조회
      const workerInfo = await lookupWorkerByEmail(googleUser.email);

      const user = {
        email:      googleUser.email,
        name:       workerInfo?.name || googleUser.name || googleUser.email.split('@')[0],
        picture:    googleUser.picture || '',
        role,
        workerName: workerInfo?.name || '',
        workerId:   workerInfo?.id   || '',
      };
      const token = makeSessionToken(user);
      return res.status(200).json({ ok: true, user, token });
    } catch (e) {
      return res.status(401).json({ error: '토큰 검증 실패: ' + e.message });
    }
  }

  // ── 2. Google OAuth Authorization Code 교환 ──────────────
  if (action === 'exchangeCode' && code) {
    try {
      const tokenData  = await exchangeCode(code, req);
      const googleUser = await getGoogleUserInfo(tokenData.access_token);
      const role       = getRole(googleUser.email);
      const workerInfo = await lookupWorkerByEmail(googleUser.email);

      const user = {
        email:      googleUser.email,
        name:       workerInfo?.name || googleUser.name,
        picture:    googleUser.picture || '',
        role,
        workerName: workerInfo?.name || '',
        workerId:   workerInfo?.id   || '',
      };
      const token = makeSessionToken(user);
      return res.status(200).json({ ok: true, user, token });
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  // ── 3. 세션 토큰 검증 ─────────────────────────────────────
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

  // ── 4. Google OAuth URL 생성 ──────────────────────────────
  if (action === 'getUrl') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID 미설정' });
    const redirectUri = `${process.env.APP_URL || ''}/api/auth/callback`;
    const url = `https://accounts.google.com/o/oauth2/v2/auth`
      + `?client_id=${clientId}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&response_type=code`
      + `&scope=${encodeURIComponent('openid email profile')}`
      + `&access_type=offline&prompt=select_account`;
    return res.status(200).json({ url });
  }

  return res.status(400).json({ error: '알 수 없는 action' });
}

// ── Workers 시트에서 이메일로 작업자 조회 ─────────────────────────
async function lookupWorkerByEmail(email) {
  if (!email) return null;
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_JSON  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!SHEET_ID || !SA_JSON) return null; // Sheets 미연동 시 null 반환

  try {
    const credentials = JSON.parse(SA_JSON);
    const accessToken = await getGoogleAccessToken(credentials);
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Workers!A1:J200')}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.values || data.values.length < 2) return null;

    // 헤더: id, name, role, type, email, skills, color, memo, createdAt
    const [, ...rows] = data.values;
    const found = rows.find(r => r[4] && r[4].toLowerCase().trim() === email.toLowerCase().trim());
    if (!found) return null;
    return { id: found[0], name: found[1], role: found[2], type: found[3], email: found[4] };
  } catch (e) {
    console.warn('[auth] Workers 조회 실패:', e.message);
    return null;
  }
}

// ── 헬퍼 ────────────────────────────────────────────────────────
function getRole(email) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  return admins.includes(email.toLowerCase()) ? 'manager' : 'worker';
}

function makeSessionToken(user) {
  const payload = { ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeSessionToken(token) {
  const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  if (payload.exp < Date.now()) throw new Error('세션 만료');
  return payload;
}

async function verifyGoogleIdToken(credential) {
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
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
      code, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
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

async function getGoogleAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const signing = `${b64({alg:'RS256',typ:'JWT'})}.${b64(payload)}`;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(credentials.private_key,'base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt = `${signing}.${sig}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt}),
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error(tokenData.error_description || 'Token 발급 실패');
  return tokenData.access_token;
}
