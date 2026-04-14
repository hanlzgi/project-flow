// api/ai.js — Anthropic API 프록시
// API 키는 Vercel 환경변수에만 저장, 브라우저에 절대 노출되지 않음

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 인증 확인 — Authorization: Bearer <session_token>
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || token !== process.env.SESSION_SECRET) {
    // 간단한 공유 시크릿 인증 (확장 시 JWT로 교체)
    // 완전 공개 테스트 시 이 블록을 주석 처리
    // return res.status(401).json({ error: '인증 필요' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 서버에 설정되지 않았습니다' });
  }

  try {
    const body = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      body.model      || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1000,
        system:     body.system,
        messages:   body.messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'API 호출 실패' });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (e) {
    console.error('[api/ai] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
