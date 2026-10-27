import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
const stateFile = join(dataDir, 'state.json');
const port = Number(process.env.PORT || 4173);
let state = { snapshot: null, jobs: [] };
await mkdir(dataDir, { recursive: true });
if (existsSync(stateFile)) {
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* start with an empty store if the file is malformed */ }
}
async function save() { await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8'); }
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw Object.assign(new Error('请求内容过大'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}
function jobView(job) { const { timer, ...view } = job; return view; }
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && path === '/api/v1/health') return send(res, 200, { status:'ok', storage:'local-json', provider:'mock' });
    if (path === '/api/v1/state' && req.method === 'GET') return send(res, 200, { state: state.snapshot });
    if (path === '/api/v1/state' && req.method === 'PUT') {
      const next = await bodyJson(req);
      if (!next || !Array.isArray(next.works) || !Array.isArray(next.characters)) return send(res, 422, { error:{ code:'VALIDATION_ERROR', message:'作品或角色数据结构无效' } });
      state.snapshot = next; await save(); return send(res, 200, { saved:true, updatedAt:Date.now() });
    }
    if (path === '/api/v1/works' && req.method === 'GET') return send(res, 200, { items: state.snapshot?.works || [] });
    if (path === '/api/v1/characters' && req.method === 'GET') return send(res, 200, { items: state.snapshot?.characters || [] });
    if (path === '/api/v1/jobs' && req.method === 'POST') {
      const input = await bodyJson(req);
      if (!['storyboard','panel_image','export'].includes(input.type)) return send(res, 422, { error:{ code:'VALIDATION_ERROR', message:'不支持的任务类型' } });
      const job = { id:randomUUID(), type:input.type, status:'queued', progress:0, createdAt:Date.now(), result:null, error:null };
      state.jobs.unshift(job); state.jobs = state.jobs.slice(0,100);
      job.timer = setTimeout(async () => { job.status='succeeded'; job.progress=100; job.result={ mode:'mock', completedAt:Date.now() }; await save(); }, input.type === 'export' ? 900 : 650);
      await save(); return send(res, 202, jobView(job));
    }
    const jobMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') { const job = state.jobs.find(x=>x.id===jobMatch[1]); return job ? send(res, 200, jobView(job)) : send(res,404,{error:{code:'NOT_FOUND',message:'任务不存在'}}); }
    const cancelMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') { const job=state.jobs.find(x=>x.id===cancelMatch[1]); if(!job)return send(res,404,{error:{code:'NOT_FOUND',message:'任务不存在'}}); clearTimeout(job.timer);job.status='cancelled';job.progress=0;await save();return send(res,200,jobView(job)); }
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      const requested = path === '/' ? 'index.html' : path.slice(1);
      const file = normalize(join(root, requested));
      if (!file.startsWith(root)) return send(res, 403, { error:{code:'FORBIDDEN',message:'禁止访问'} });
      try { const data=await readFile(file); res.writeHead(200, {'content-type':mime[extname(file)]||'application/octet-stream'}); return res.end(data); }
      catch { return send(res,404,{error:{code:'NOT_FOUND',message:'页面不存在'}}); }
    }
    return send(res,404,{error:{code:'NOT_FOUND',message:'接口不存在'}});
  } catch (error) {
    return send(res, error.status || 500, { error:{ code:error.status===413?'PAYLOAD_TOO_LARGE':error.status===400?'BAD_JSON':'INTERNAL_ERROR', message:error.message || '服务暂时不可用' } });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`漫工厂 AI 已启动：http://localhost:${port}`));
