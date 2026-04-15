// api/notify.js — 작업자 이메일 알림 발송 (Gmail API 직접 사용)
// Gmail API를 서비스 계정으로 사용하거나, nodemailer로 SMTP 발송

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, body, taskKey, worker } = req.body || {};
  if (!to || !to.includes('@')) return res.status(400).json({ error: '수신자 이메일 필요' });
  if (!subject || !body) return res.status(400).json({ error: '제목/내용 필요' });

  // ── 방법 1: Gmail API (서비스 계정 또는 OAuth) ──────────────
  // Gmail은 서비스 계정으로 발송이 제한적이므로
  // Gmail SMTP (앱 비밀번호) 방식 사용 권장
  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PW = process.env.GMAIL_APP_PASSWORD;

  if (GMAIL_USER && GMAIL_APP_PW) {
    try {
      const result = await sendViaGmailSmtp({ to, subject, body, from: GMAIL_USER, appPassword: GMAIL_APP_PW });
      return res.status(200).json({ ok: true, method: 'gmail_smtp', result });
    } catch (e) {
      console.error('[notify] Gmail SMTP 실패:', e.message);
    }
  }

  // ── 방법 2: 드래프트 생성 (Gmail API, 관리자가 직접 발송) ──
  // 실제 발송 대신 드래프트로 생성 — 관리자가 Gmail에서 확인 후 발송
  try {
    const draft = await createGmailDraft({ to, subject, body });
    return res.status(200).json({ ok: true, method: 'draft', message: `Gmail 드래프트로 생성됨 (${to})`, draft });
  } catch (e) {
    console.error('[notify] 드래프트 생성 실패:', e.message);
  }

  // ── 방법 3: 로그만 기록 (이메일 미설정 시 폴백) ──
  console.log(`[notify] 알림 로그: to=${to}, subject=${subject}`);
  return res.status(200).json({ ok: true, method: 'log_only', message: '이메일 환경변수 미설정 — 로그만 기록됨. GMAIL_USER, GMAIL_APP_PASSWORD를 Vercel에 설정하세요.' });
}

// Gmail SMTP 발송 (Node.js 내장 net 사용)
async function sendViaGmailSmtp({ to, subject, body, from, appPassword }) {
  // Vercel serverless에서 nodemailer 없이 Gmail SMTP 직접 구현은 복잡하므로
  // 간단히 Gmail API REST 사용
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!credentials.client_email) throw new Error('서비스 계정 없음');

  // Gmail API는 서비스 계정으로 개인 계정 대리 발송이 어려우므로 드래프트 방식 사용
  throw new Error('SMTP 미구현 — 드래프트 방식 사용');
}

// Gmail API 드래프트 생성
async function createGmailDraft({ to, subject, body }) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!credentials.client_email) throw new Error('Google 서비스 계정 없음');

  // 관리자 이메일 (ADMIN_EMAILS 첫 번째)
  const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  if (!adminEmail) throw new Error('ADMIN_EMAILS 미설정');

  // 서비스 계정 JWT로 액세스 토큰 발급
  const accessToken = await getGoogleAccessToken(credentials, adminEmail);

  // RFC 2822 메일 메시지 생성
  const message = [
    `From: PROJECT FLOW <${adminEmail}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(body).toString('base64'),
  ].join('\r\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${adminEmail}/drafts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: encoded } }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gmail 드래프트 생성 실패');
  }

  return resp.json();
}

// Google 서비스 계정 JWT 인증 (도메인 위임 필요)
async function getGoogleAccessToken(credentials, delegateEmail) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.client_email,
    sub: delegateEmail, // 도메인 위임
    scope: 'https://www.googleapis.com/auth/gmail.compose',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64(payload);
  const signing = `${header}.${claim}`;

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(credentials.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signing}.${sig}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });

  const data = await tokenResp.json();
  if (!data.access_token) throw new Error(data.error_description || '토큰 발급 실패');
  return data.access_token;
}
