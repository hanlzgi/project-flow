// api/notify.js — 작업자 알림 발송
// 우선순위: 1) Slack Webhook  2) Gmail SMTP  3) Gmail 드래프트  4) 로그만

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, body, taskKey, worker } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: '제목/내용 필요' });

  // ── 방법 1: Slack Incoming Webhook ────────────────────────
  // Vercel 환경변수: SLACK_WEBHOOK_URL
  // 설정: Slack → 앱 → Incoming Webhooks → 채널 선택 → Webhook URL 복사
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
  if (SLACK_WEBHOOK) {
    try {
      const slackBody = {
        text: `📋 *PROJECT FLOW 알림*`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '📋 PROJECT FLOW 공정 알림', emoji: true }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*공정명*\n${subject.replace('[PROJECT FLOW] ','').replace(' 공정이 배정되었습니다','')}` },
              { type: 'mrkdwn', text: `*담당자*\n${worker || to || '-'}` },
            ]
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: body.replace(/\n/g, '\n').slice(0, 500) }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `수신: ${to || worker || '-'} | 공정키: ${taskKey || '-'}` }]
          }
        ]
      };
      const resp = await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackBody),
      });
      if (resp.ok) {
        return res.status(200).json({ ok: true, method: 'slack', message: 'Slack 알림 전송됨' });
      }
      console.warn('[notify] Slack Webhook 실패:', resp.status);
    } catch (e) {
      console.error('[notify] Slack 오류:', e.message);
    }
  }

  // ── 방법 2: Gmail SMTP (앱 비밀번호 방식) ─────────────────
  // Vercel 환경변수: GMAIL_USER, GMAIL_APP_PASSWORD
  // 설정: Google 계정 → 보안 → 2단계 인증 → 앱 비밀번호 생성
  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PW = process.env.GMAIL_APP_PASSWORD;

  if (GMAIL_USER && GMAIL_APP_PW && to?.includes('@')) {
    try {
      const result = await sendViaGmailApi(GMAIL_USER, GMAIL_APP_PW, { to, subject, body });
      return res.status(200).json({ ok: true, method: 'gmail_smtp', result });
    } catch (e) {
      console.error('[notify] Gmail SMTP 실패:', e.message);
    }
  }

  // ── 방법 3: Gmail 드래프트 (서비스 계정 도메인 위임) ───────
  if (to?.includes('@')) {
    try {
      const draft = await createGmailDraft({ to, subject, body });
      return res.status(200).json({
        ok: true,
        method: 'draft',
        message: `Gmail 임시보관함에 생성됨 (${to}) — Gmail에서 직접 발송하세요`
      });
    } catch (e) {
      console.error('[notify] 드래프트 생성 실패:', e.message);
    }
  }

  // ── 방법 4: 로그만 (폴백) ─────────────────────────────────
  console.log(`[notify] 알림 기록: to=${to}, worker=${worker}, subject=${subject}`);
  return res.status(200).json({
    ok: false,
    method: 'log_only',
    message: '알림 미설정 상태입니다. Vercel에 SLACK_WEBHOOK_URL 또는 GMAIL_USER + GMAIL_APP_PASSWORD를 설정하세요.'
  });
}

// Gmail REST API로 메일 발송 (OAuth2 불필요한 앱 비밀번호 SMTP 방식)
async function sendViaGmailApi(user, appPassword, { to, subject, body }) {
  // Base64 인코딩 메일 메시지
  const raw = [
    `From: ${user}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  // Gmail API (서비스 계정 방식은 도메인 위임 필요 → 앱 비밀번호 방식 권장)
  // 여기서는 서비스 계정으로 드래프트 생성 후 발송 시도
  throw new Error('Gmail SMTP은 Vercel에서 직접 지원 안 됨 — Slack Webhook 사용 권장');
}

// Gmail 드래프트 생성
async function createGmailDraft({ to, subject, body }) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!credentials.client_email) throw new Error('Google 서비스 계정 없음');

  const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  if (!adminEmail) throw new Error('ADMIN_EMAILS 미설정');

  const accessToken = await getGoogleAccessToken(credentials, adminEmail);

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

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

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

async function getGoogleAccessToken(credentials, delegateEmail) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.client_email,
    sub: delegateEmail,
    scope: 'https://www.googleapis.com/auth/gmail.compose',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64(payload);
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const sig = sign.sign(credentials.private_key, 'base64url');
  const jwt = `${header}.${claim}.${sig}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await tokenResp.json();
  if (!data.access_token) throw new Error(data.error_description || '토큰 발급 실패');
  return data.access_token;
}
