// api/notion.js — Notion API 프록시
// Vercel 환경변수: NOTION_TOKEN, NOTION_PROJECTS_DB_ID, NOTION_TASKS_DB_ID

const NOTION_VERSION = '2022-06-28';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'NOTION_TOKEN 환경변수 미설정' });

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };

  const { action } = req.body || {};

  try {
    if (action === 'test') {
      const r = await fetch('https://api.notion.com/v1/users/me', { headers });
      if (!r.ok) throw new Error('Notion 연결 실패: ' + r.status);
      const d = await r.json();
      return res.json({ ok: true, name: d.name || 'Notion Bot' });
    }

    if (action === 'readProjects') {
      const dbId = process.env.NOTION_PROJECTS_DB_ID;
      if (!dbId) return res.status(500).json({ error: 'NOTION_PROJECTS_DB_ID 미설정' });
      const pages = await queryAllPages(dbId, headers);
      return res.json({ ok: true, projects: pages.map(notionPageToProject) });
    }

    if (action === 'readTasks') {
      const dbId = process.env.NOTION_TASKS_DB_ID;
      if (!dbId) return res.status(500).json({ error: 'NOTION_TASKS_DB_ID 미설정' });
      const pages = await queryAllPages(dbId, headers);
      return res.json({ ok: true, tasks: pages.map(notionPageToTask) });
    }

    if (action === 'syncToNotion') {
      const { projects = [], tasks = [] } = req.body;
      const projDbId = process.env.NOTION_PROJECTS_DB_ID;
      const taskDbId = process.env.NOTION_TASKS_DB_ID;
      if (!projDbId || !taskDbId) return res.status(500).json({ error: 'Notion DB ID 미설정' });

      const [existingProjs, existingTasks] = await Promise.all([
        queryAllPages(projDbId, headers),
        queryAllPages(taskDbId, headers),
      ]);

      const projIdMap = {};
      existingProjs.forEach(p => {
        const appId = getNotionProp(p, 'AppID', 'rich_text');
        if (appId) projIdMap[appId] = p.id;
      });
      const taskIdMap = {};
      existingTasks.forEach(p => {
        const appId = getNotionProp(p, 'AppID', 'rich_text');
        if (appId) taskIdMap[appId] = p.id;
      });

      let createdP = 0, updatedP = 0, createdT = 0, updatedT = 0;

      for (const proj of projects) {
        const props = projectToNotionProps(proj);
        if (projIdMap[proj.id]) {
          await updateNotionPage(projIdMap[proj.id], props, headers);
          updatedP++;
        } else {
          await createNotionPage(projDbId, props, headers);
          createdP++;
        }
      }

      for (const task of tasks) {
        const props = taskToNotionProps(task);
        if (taskIdMap[task.key]) {
          await updateNotionPage(taskIdMap[task.key], props, headers);
          updatedT++;
        } else {
          await createNotionPage(taskDbId, props, headers);
          createdT++;
        }
      }

      return res.json({
        ok: true,
        message: '프로젝트 생성 ' + createdP + ' / 수정 ' + updatedP + ', 태스크 생성 ' + createdT + ' / 수정 ' + updatedT,
      });
    }

    if (action === 'syncFromNotion') {
      const projDbId = process.env.NOTION_PROJECTS_DB_ID;
      const taskDbId = process.env.NOTION_TASKS_DB_ID;
      if (!projDbId || !taskDbId) return res.status(500).json({ error: 'Notion DB ID 미설정' });

      const [projPages, taskPages] = await Promise.all([
        queryAllPages(projDbId, headers),
        queryAllPages(taskDbId, headers),
      ]);

      return res.json({
        ok: true,
        projects: projPages.map(notionPageToProject),
        tasks: taskPages.map(notionPageToTask),
      });
    }

    return res.status(400).json({ error: '알 수 없는 action: ' + action });
  } catch (e) {
    console.error('[api/notion]', e);
    return res.status(500).json({ error: e.message });
  }
}

async function queryAllPages(dbId, headers) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch('https://api.notion.com/v1/databases/' + dbId + '/query', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || 'Notion 쿼리 실패: ' + r.status);
    }
    const d = await r.json();
    pages.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return pages;
}

async function createNotionPage(dbId, properties, headers) {
  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST', headers,
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || '페이지 생성 실패');
  }
  return r.json();
}

async function updateNotionPage(pageId, properties, headers) {
  const r = await fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'PATCH', headers,
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || '페이지 수정 실패');
  }
  return r.json();
}

function getNotionProp(page, name, type) {
  const prop = page.properties && page.properties[name];
  if (!prop) return '';
  if (type === 'title') return (prop.title && prop.title[0] && prop.title[0].plain_text) || '';
  if (type === 'rich_text') return (prop.rich_text && prop.rich_text[0] && prop.rich_text[0].plain_text) || '';
  if (type === 'select') return (prop.select && prop.select.name) || '';
  if (type === 'date') return (prop.date && prop.date.start) || '';
  if (type === 'number') return prop.number != null ? prop.number : '';
  return '';
}

function projectToNotionProps(proj) {
  return {
    '프로젝트명': { title: [{ text: { content: proj.name || '' } }] },
    'AppID':     { rich_text: [{ text: { content: String(proj.id || '') } }] },
    '시작일':    proj.start ? { date: { start: proj.start } } : { date: null },
    '마감일':    proj.end   ? { date: { start: proj.end   } } : { date: null },
    '상태':      { select: { name: proj.status || '진행 중' } },
    '설명':      { rich_text: [{ text: { content: proj.desc || '' } }] },
  };
}

function taskToNotionProps(task) {
  return {
    '공정명':      { title: [{ text: { content: task.task || '' } }] },
    'AppID':      { rich_text: [{ text: { content: String(task.key || '') } }] },
    '프로젝트':   { rich_text: [{ text: { content: task.projectName || '' } }] },
    '프로젝트ID': { rich_text: [{ text: { content: String(task.projectId || '') } }] },
    '카테고리':   { select: { name: task.cat || '기타' } },
    '담당자':     { rich_text: [{ text: { content: task.worker || '' } }] },
    '시작일':     task.start ? { date: { start: task.start } } : { date: null },
    '마감일':     task.end   ? { date: { start: task.end   } } : { date: null },
    '상태':       { select: { name: task.status || '시작 전' } },
    '비중':       { number: parseFloat(task.weight) || 0 },
    '메모'
