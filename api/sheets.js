// api/sheets.js — Google Sheets API 프록시
// 서비스 계정 키는 Vercel 환경변수에 보관

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }

  // ── Google 서비스 계정 인증 ──────────────────────────────
  // GOOGLE_SERVICE_ACCOUNT_JSON 환경변수: 서비스 계정 JSON 전체를 한 줄로
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  } catch {
    return res.status(500).json({ error: 'Google 서비스 계정 설정 오류' });
  }

  if (!credentials.client_email) {
    return res.status(500).json({ error: 'Google 서비스 계정이 설정되지 않았습니다' });
  }

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  if (!SHEET_ID) {
    return res.status(500).json({ error: 'GOOGLE_SHEET_ID 환경변수 미설정' });
  }

  // JWT 토큰 생성 (googleapis 없이 직접)
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(credentials);
  } catch (e) {
    return res.status(500).json({ error: '인증 토큰 발급 실패: ' + e.message });
  }

  const { action, range, values, sheetName } = req.body || {};
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

  try {
    if (req.method === 'GET' || action === 'read') {
      // 시트 읽기
      const readRange = range || `${sheetName || 'Tasks'}!A1:Z1000`;
      const resp = await fetch(
        `${baseUrl}/values/${encodeURIComponent(readRange)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await resp.json();
      return res.status(200).json(data);

    } else if (action === 'append') {
      // 행 추가
      const appendRange = `${sheetName || 'Tasks'}!A1`;
      const resp = await fetch(
        `${baseUrl}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ values }),
        }
      );
      const data = await resp.json();
      return res.status(200).json(data);

    } else if (action === 'update') {
      // 특정 범위 업데이트
      const resp = await fetch(
        `${baseUrl}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
        }
      );
      const data = await resp.json();
      return res.status(200).json(data);

    } else if (action === 'batchUpdate') {
      // 배치 업데이트 (여러 범위 한번에)
      const resp = await fetch(
        `${baseUrl}/values:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            data: values, // [{range, values}] 배열
          }),
        }
      );
      const data = await resp.json();
      return res.status(200).json(data);

    } else if (action === 'getSheetInfo') {
      // 스프레드시트 메타데이터 조회 (현재 탭 목록 포함)
      const resp = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const data = await resp.json();
      return res.status(200).json(data);

    } else if (action === 'clearAndWrite') {
      // 시트 내용 전체 교체 (헤더 유지하며 데이터만 갱신)
      // 1) 먼저 기존 데이터 범위 clear
      const clearResp = await fetch(
        `${baseUrl}/values/${encodeURIComponent(sheetName + '!A2:Z10000')}:clear`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        }
      );
      await clearResp.json();
      // 2) 새 데이터 A2부터 write
      if (values && values.length > 0) {
        const writeResp = await fetch(
          `${baseUrl}/values/${encodeURIComponent(sheetName + '!A2')}?valueInputOption=USER_ENTERED`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range: sheetName + '!A2', majorDimension: 'ROWS', values }),
          }
        );
        const data = await writeResp.json();
        return res.status(200).json(data);
      }
      return res.status(200).json({ clearedAndWrote: 0 });

    } else if (action === 'createSheets') {
      // 시트 탭이 없으면 생성 — requests: [{title:'Projects'}, ...]
      // 1) 현재 시트 목록 조회
      const infoResp = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const info = await infoResp.json();
      const existingTitles = (info.sheets || []).map(s => s.properties.title);

      // 2) 없는 탭만 생성
      const toCreate = (values || []).filter(t => !existingTitles.includes(t));
      if (!toCreate.length) {
        return res.status(200).json({ created: [], existing: existingTitles });
      }

      const requests = toCreate.map(title => ({
        addSheet: { properties: { title } }
      }));

      const resp = await fetch(`${baseUrl}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      });
      const data = await resp.json();
      return res.status(200).json({ created: toCreate, result: data });
    }

    return res.status(400).json({ error: '알 수 없는 action: ' + action });

  } catch (e) {
    console.error('[api/sheets] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── Google OAuth2 JWT 인증 (googleapis 없이 직접 구현) ──────────
async function getGoogleAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  // Base64URL 인코딩
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const header  = b64({ alg: 'RS256', typ: 'JWT' });
  const claim   = b64(payload);
  const signing = `${header}.${claim}`;

  // RSA-SHA256 서명
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(credentials.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signing}.${sig}`;

  // 액세스 토큰 교환
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || 'Token 발급 실패');
  }
  return tokenData.access_token;
}
