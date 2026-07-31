const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3456;
const ADMIN_PASSWORD = 'django2026';
const DEEPSEEK_API = 'api.deepseek.com';
const DATA_FILE = path.join(__dirname, 'keys.json');
const LOG_FILE = path.join(__dirname, 'log.txt');

// ==================== 数据存储 ====================
function loadKeys() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch(e) {}
  return {};
}

function saveKeys(keys) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

// ==================== HTTP 服务器 ====================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Password');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 路由
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/models' || url.pathname === '/v1') {
    return handleProxy(req, res);
  }

  if (url.pathname === '/admin') {
    return serveAdmin(req, res);
  }

  if (url.pathname.startsWith('/admin/api/')) {
    return handleAdminAPI(req, res, url);
  }

  // AI 写作网站首页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveWritingSite(req, res);
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 首页
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'AI API Proxy', admin: '/admin', usage: 'POST /v1/chat/completions' }));
});

// ==================== API 代理 ====================
function handleProxy(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: '只支持 POST' }));
    return;
  }

  // 提取客户 Key
  const auth = req.headers.authorization || '';
  const customerKey = auth.replace(/^Bearer\s+/i, '').trim();

  if (!customerKey) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: '缺少 API Key' }));
    return;
  }

  const keys = loadKeys();
  const keyData = keys[customerKey];

  if (!keyData) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'API Key 无效' }));
    return;
  }

  if (!keyData.active) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: '此 Key 已停用' }));
    return;
  }

  // 检查到期
  if (keyData.expiresAt) {
    const now = new Date().toISOString();
    if (now > keyData.expiresAt) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Key 已过期，联系卖家续费', expiresAt: keyData.expiresAt }));
      return;
    }
  }

  if (keyData.used >= keyData.budget) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: '额度已用完，联系卖家充值', budget: keyData.budget, used: keyData.used, remaining: 0 }));
    return;
  }

  // 读取请求体
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // 强制使用客户购买的模型
    const model = keyData.model === 'flash' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
    try {
      const parsed = JSON.parse(body);
      parsed.model = model;
      body = JSON.stringify(parsed);
    } catch(e) {}

    // 转发到 DeepSeek
    const apiReq = https.request({
      hostname: DEEPSEEK_API,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyData.realKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, apiRes => {
      let responseBody = '';
      apiRes.on('data', chunk => responseBody += chunk);
      apiRes.on('end', () => {
        // 统计 token
        let tokensUsed = 0;
        try {
          const data = JSON.parse(responseBody);
          if (data.usage && data.usage.total_tokens) {
            tokensUsed = data.usage.total_tokens;
          }
        } catch(e) {}

        // 更新用量
        if (tokensUsed > 0) {
          keys[customerKey].used += tokensUsed;
          saveKeys(keys);
          log(`${keyData.name}: +${tokensUsed} tokens (${keys[customerKey].used}/${keyData.budget})`);
        }

        const remaining = Math.max(0, keyData.budget - keys[customerKey].used);

        res.writeHead(apiRes.statusCode, {
          'Content-Type': 'application/json',
          'X-Remaining-Tokens': String(remaining),
          'X-Used-Tokens': String(keys[customerKey].used),
          'X-Budget-Tokens': String(keyData.budget)
        });
        res.end(responseBody);
      });
    });

    apiReq.on('error', err => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'AI 服务请求失败: ' + err.message }));
    });

    apiReq.write(body);
    apiReq.end();
  });
}

// ==================== 管理后台 API ====================
function handleAdminAPI(req, res, url) {
  const password = req.headers['x-admin-password'] || '';
  if (password !== ADMIN_PASSWORD) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: '密码错误' }));
    return;
  }

  const pathname = url.pathname;
  const method = req.method;

  // POST /admin/api/keys — 创建 Key
  if (pathname === '/admin/api/keys' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, duration, model, realKey } = JSON.parse(body);
        if (!name || !duration || !realKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name、duration、realKey 必填' }));
          return;
        }
        // duration: day/week/month, model: flash/pro
        const now = new Date();
        let expiresAt;
        let budget;
        const DURATION = { day: 1, week: 7, month: 30 };
        const BUDGET = { day: 5000000, week: 20000000, month: 50000000 };
        if (!DURATION[duration]) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'duration 必须为 day/week/month' }));
          return;
        }
        now.setDate(now.getDate() + DURATION[duration]);
        expiresAt = now.toISOString();
        budget = BUDGET[duration];

        const keys = loadKeys();
        const kid = 'sk-' + crypto.randomBytes(24).toString('hex');
        const label = { day: '日卡', week: '周卡', month: '月卡' };
        const modelLabel = model === 'flash' ? 'Flash' : 'Pro';
        keys[kid] = {
          name: name || (label[duration] + '-' + modelLabel),
          budget,
          used: 0,
          realKey: realKey || '',
          active: true,
          model: model || 'pro',
          duration,
          createdAt: new Date().toISOString().split('T')[0],
          expiresAt: expiresAt.split('T')[0] + ' ' + expiresAt.split('T')[1].substring(0, 8)
        };
        saveKeys(keys);
        log(`创建 ${label[duration]}(${modelLabel}): ${keys[kid].name} (${budget} tokens, 到期: ${keys[kid].expiresAt})`);
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, key: kid, name: keys[kid].name, budget, expiresAt: keys[kid].expiresAt }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请求格式错误: ' + e.message }));
      }
    });
    return;
  }

  // GET /admin/api/keys — 列出所有 Key
  if (pathname === '/admin/api/keys' && method === 'GET') {
    const keys = loadKeys();
    const list = Object.entries(keys).map(([id, data]) => ({ id, ...data }));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200);
    res.end(JSON.stringify({ total: list.length, keys: list }));
    return;
  }

  // DELETE /admin/api/keys/:id — 删除 Key
  if (pathname.startsWith('/admin/api/keys/') && method === 'DELETE') {
    const kid = pathname.replace('/admin/api/keys/', '');
    const keys = loadKeys();
    delete keys[kid];
    saveKeys(keys);
    log(`删除 Key: ${kid}`);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // PUT toggle
  if (pathname.endsWith('/toggle') && method === 'PUT') {
    const kid = pathname.replace('/admin/api/keys/', '').replace('/toggle', '');
    const keys = loadKeys();
    if (keys[kid]) {
      keys[kid].active = !keys[kid].active;
      saveKeys(keys);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, active: keys[kid]?.active }));
    return;
  }

  // GET stats
  if (pathname === '/admin/api/stats' && method === 'GET') {
    const keys = loadKeys();
    const list = Object.values(keys);
    const now = new Date().toISOString();
    const keyArr = Object.entries(keys).map(([id, data]) => ({ id, ...data }));
    res.writeHead(200);
    res.end(JSON.stringify({
      totalKeys: list.length,
      activeKeys: list.filter(k => k.active).length,
      expiredKeys: list.filter(k => k.expiresAt && now > k.expiresAt).length,
      totalBudget: list.reduce((s, k) => s + k.budget, 0),
      totalUsed: list.reduce((s, k) => s + k.used, 0),
      totalRemaining: list.reduce((s, k) => s + k.budget - k.used, 0),
      keys: keyArr
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: '未找到' }));
}

// ==================== AI 写作网站 ====================
function serveWritingSite(req, res) {
  try {
    const htmlPath = path.join(__dirname, '..', 'ai-writing-site', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    // 服务器端注入 Key，用户不用手动填
    // Key 预配置：写入环境变量或使用默认值
    const key = process.env.DEEPSEEK_KEY || '';
    if (key) {
      html = html.replace(
        "let DEEPSEEK_API_KEY = localStorage.getItem('biling_key') || '';",
        "let DEEPSEEK_API_KEY = '" + key + "';"
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch(e) {
    res.writeHead(500);
    res.end('网站文件未找到');
  }
}

// ==================== 管理后台页面 ====================
function serveAdmin(req, res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Key 管理后台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f5;color:#1a1a2e}
.header{background:#1a1a2e;color:white;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:17px}
.container{max-width:1000px;margin:0 auto;padding:20px}
.card{background:white;border-radius:10px;padding:20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:15px;margin-bottom:14px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.stat{flex:1;min-width:130px;background:#f9fafb;border-radius:8px;padding:14px;text-align:center}
.stat .value{font-size:26px;font-weight:700;color:#7c3aed}
.stat .label{font-size:11px;color:#6b7280;margin-top:4px}
.form-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.form-group{flex:1;min-width:140px}
.form-group label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#555}
.form-group input{width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;outline:none}
.form-group input:focus{border-color:#7c3aed}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.btn-primary{background:#7c3aed;color:white}
.btn-primary:hover{background:#6d28d9}
.btn-danger{background:#ef4444;color:white;padding:5px 10px;font-size:11px;border:none;border-radius:6px;cursor:pointer}
.btn-danger:hover{background:#dc2626}
.btn-sm{padding:5px 10px;font-size:11px;border-radius:6px;cursor:pointer;border:1px solid #e5e7eb;background:white}
.btn-sm:hover{background:#f3f4f6}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f0f0f0}
th{font-weight:600;color:#6b7280;font-size:11px;text-transform:uppercase}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600}
.badge-active{background:#d1fae5;color:#065f46}
.badge-inactive{background:#fee2e2;color:#991b1b}
.badge-empty{background:#fef3c7;color:#92400e}.badge-expired{background:#fee2e2;color:#991b1b}
.key-text{font-family:monospace;font-size:10px;background:#f3f4f6;padding:3px 6px;border-radius:4px;word-break:break-all;cursor:pointer}
.progress-bar{width:100%;height:5px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;background:#7c3aed;border-radius:3px;transition:width .3s}
.progress-fill.high{background:#ef4444}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:white;padding:10px 24px;border-radius:10px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.login-box{max-width:360px;margin:60px auto}
.empty-state{text-align:center;padding:40px;color:#9ca3af}
@media(max-width:600px){.container{padding:10px}.stats{flex-direction:column}.form-row{flex-direction:column}}
</style>
</head>
<body>
<div class="header"><h1>🔑 API Key 管理</h1><span style="font-size:12px;opacity:.7">本地服务器</span></div>
<div class="container">

<div id="loginBox" class="card login-box">
<h2>管理员登录</h2>
<div class="form-group" style="margin-bottom:10px"><label>密码</label>
<input type="password" id="pwd" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')login()"></div>
<button class="btn btn-primary" onclick="login()" style="width:100%">登录</button>
</div>

<div id="mainPanel" style="display:none">
<div class="stats" id="statsCards"></div>

<div class="card">
<h2>➕ 创建客户 Key</h2>
<div class="form-row">
<div class="form-group"><label>模型</label><select id="newModel" style="width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px"><option value="flash">V4 Flash</option><option value="pro">V4 Pro</option></select></div>
<div class="form-group"><label>套餐</label><select id="newDuration" style="width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px" onchange="updatePrice()"><option value="day">日卡 ¥2.88/¥4.88</option><option value="week">周卡 ¥16.88/¥24.88</option><option value="month">月卡 ¥44.88/¥68.88</option></select></div>
<div class="form-group"><label>客户备注</label><input type="text" id="newName" placeholder="例：闲鱼-张三"></div>
<div class="form-group"><label>DeepSeek Key</label><input type="text" id="newRealKey" placeholder="你的真实Key"></div>
<button class="btn btn-primary" onclick="createKey()">创建 & 复制</button>
</div>
<div id="priceHint" style="font-size:12px;color:#7c3aed;margin-top:6px;font-weight:600"></div>
</div>

<div class="card">
<h2>📋 客户 Key 列表</h2>
<div id="loading">加载中...</div>
<table id="keyTable" style="display:none"><thead><tr><th>客户</th><th>Key</th><th>模型</th><th>额度/已用</th><th>到期</th><th>状态</th><th>操作</th></tr></thead><tbody id="tbody"></tbody></table>
<div class="empty-state" id="emptyState" style="display:none">还没有 Key，👆 创建一个</div>
</div>

<div class="card" style="background:#f9fafb;font-size:12px;color:#6b7280">
<strong>📡 外网访问地址：</strong> <span id="publicUrl" style="color:#7c3aed">启动 tunnel 后显示</span><br>
<strong>📖 客户使用方式：</strong> API 地址 = 上面的地址 + <code>/v1/chat/completions</code>, Key = 你创建的 sk-xxx
</div>
</div>
</div>

<div class="toast" id="toast"></div>
<script>
let pwd='';
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000)}
async function api(method,path,body){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Admin-Password':pwd},body:body?JSON.stringify(body):undefined});
  return r.json();
}
async function login(){
  pwd=document.getElementById('pwd').value;
  const r=await api('GET','/admin/api/keys');
  if(r.error){toast('❌ '+r.error);return}
  document.getElementById('loginBox').style.display='none';
  document.getElementById('mainPanel').style.display='block';
  updatePrice();
  loadAll();
}
async function loadAll(){await Promise.all([loadStats(),loadKeys()])}
async function loadStats(){
  const r=await api('GET','/admin/api/stats');
  if(r.error)return;
  const PRICE={day:{flash:2.88,pro:4.88},week:{flash:16.88,pro:24.88},month:{flash:44.88,pro:68.88}};
  let rev=0;(r.keys||[]).forEach(k=>{if(PRICE[k.duration]&&PRICE[k.duration][k.model])rev+=PRICE[k.duration][k.model]});
  document.getElementById('statsCards').innerHTML=[
    {l:'总 Key 数',v:r.totalKeys},{l:'活跃',v:r.activeKeys},{l:'已过期',v:(r.expiredKeys||0)},{l:'总售出',v:(r.totalBudget/1e6).toFixed(1)+'M'},{l:'收入 ¥',v:rev.toFixed(0)}
  ].map(s=>'<div class="stat"><div class="value">'+s.v+'</div><div class="label">'+s.l+'</div></div>').join('');
}
async function loadKeys(){
  document.getElementById('loading').style.display='block';
  document.getElementById('keyTable').style.display='none';
  document.getElementById('emptyState').style.display='none';
  const r=await api('GET','/admin/api/keys');
  document.getElementById('loading').style.display='none';
  if(!r.keys||r.keys.length===0){document.getElementById('emptyState').style.display='block';return}
  document.getElementById('keyTable').style.display='table';
  const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);
  const now=new Date().toISOString();
  document.getElementById('tbody').innerHTML=r.keys.map(k=>{
    const pct=k.budget>0?(k.used/k.budget*100):0;
    const cls=pct>90?'high':'';
    const expired=k.expiresAt&&now>k.expiresAt;
    const sc=!k.active?'badge-inactive':(expired?'badge-empty':(k.used>=k.budget?'badge-empty':'badge-active'));
    const st=!k.active?'已停用':(expired?'已过期':(k.used>=k.budget?'已用完':'使用中'));
    const modelL=k.model==='flash'?'⚡Flash':'💎Pro';
    const expT=k.expiresAt?k.expiresAt.substring(0,16):'-';
    return'<tr><td><b>'+k.name+'</b></td><td><span class="key-text" onclick="navigator.clipboard.writeText(\\''+k.id+'\\');toast(\\'已复制\\')" title="点击复制">'+k.id.substring(0,18)+'...</span></td><td>'+modelL+'</td><td>'+fmt(k.used)+' / '+fmt(k.budget)+'<div class="progress-bar"><div class="progress-fill '+cls+'" style="width:'+pct+'%"></div></div></td><td>'+expT+'</td><td><span class="badge '+sc+'">'+st+'</span></td><td><button class="btn-sm" onclick="toggleKey(\\''+k.id+'\\')">'+(k.active?'停用':'启用')+'</button> <button class="btn-danger" onclick="deleteKey(\\''+k.id+'\\')">删除</button></td></tr>';
  }).join('');
}
function updatePrice(){
  const m=document.getElementById('newModel').value;
  const d=document.getElementById('newDuration').value;
  const p={day:{flash:'¥2.88',pro:'¥4.88'},week:{flash:'¥16.88',pro:'¥24.88'},month:{flash:'¥44.88',pro:'¥68.88'}};
  document.getElementById('priceHint').textContent='售价: '+p[d][m]+' | 成本: ~¥0.2/百万token';
}
async function createKey(){
  const name=document.getElementById('newName').value.trim()||'';
  const duration=document.getElementById('newDuration').value;
  const model=document.getElementById('newModel').value;
  const realKey=document.getElementById('newRealKey').value.trim();
  if(!realKey){toast('填你的DeepSeek Key');return}
  const r=await api('POST','/admin/api/keys',{name,duration,model,realKey});
  if(r.error){toast('❌ '+r.error);return}
  await navigator.clipboard.writeText(r.key);
  toast('✅ 已创建并复制 Key！到期: '+r.expiresAt);
  loadAll();
}
async function deleteKey(id){if(!confirm('确定删除？'))return;await api('DELETE','/admin/api/keys/'+id);toast('已删除');loadAll()}
async function toggleKey(id){await api('PUT','/admin/api/keys/'+id+'/toggle');toast('已切换');loadAll()}
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ==================== 启动 ====================
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🔑 API Key 代理系统已启动            ║');
  console.log('║                                        ║');
  console.log(`║   管理后台: http://localhost:${PORT}/admin ║`);
  console.log(`║   API 地址: http://localhost:${PORT}/v1  ║`);
  console.log('║                                        ║');
  console.log('║   接下来: npx localtunnel --port ' + PORT + '  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
