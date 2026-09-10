/**
 * ============================================================
 *  应用插件下载站 · Cloudflare Worker 后端（唯一入口文件）
 * ============================================================
 *
 *  职责：
 *   1. 托管静态资源（public/ 下的前端页面，交给 Workers Static Assets）
 *   2. 提供全部 REST API：
 *      - 资源（应用/插件）列表、详情、搜索、分页
 *      - 下载：下载次数 +1，并记录下载历史
 *      - 点赞：点赞次数 +1（同一 IP 对同一资源只能点一次）
 *      - 评论：查看 / 发布评论（站内直接评论）
 *      - 登录 / 注册（JWT 风格令牌；管理员可上传与管理）
 *      - 留言建议
 *      - 文件上传（R2 对象存储）与文件下载
 *      - 站点设置（如“联系我”图片）
 *
 *  依赖的 Cloudflare 资源：
 *   - env.DB      → D1 数据库（表结构见 schema.sql）
 *   - env.FILES   → R2 对象存储（存放上传的文件）
 *   - env.ASSETS  → 静态资源（public/ 目录，由 wrangler.toml 自动配置）
 *
 *  部署前建议执行：wrangler secret put AUTH_SECRET（设置令牌密钥）
 * ============================================================
 */

// ------------------------------------------------------------------
//  基础工具函数
// ------------------------------------------------------------------

/** 生成 UUID，用作所有表的自增主键（避免依赖数据库自增） */
function newId() {
  return crypto.randomUUID();
}

/** 返回 JSON 格式的响应 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 返回统一格式的错误响应 */
function fail(message, status = 400) {
  return json({ success: false, message }, status);
}

/** 从请求中读取客户端 IP（Cloudflare 转发头） */
function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/** 从请求头中提取 Bearer 令牌 */
function getToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ------------------------------------------------------------------
//  Base64URL / Hex 编解码（用于令牌与密码盐）
// ------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 字节数组 → Base64URL 字符串 */
function base64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64URL 字符串 → 字节数组 */
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '='; // 补齐填充符
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 字节数组 → 十六进制字符串 */
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 十六进制字符串 → 字节数组 */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ------------------------------------------------------------------
//  令牌（Token）与密码哈希 —— 全部基于 Web Crypto API，零外部依赖
// ------------------------------------------------------------------

/**
 * 读取令牌密钥。
 * 优先读取环境变量 AUTH_SECRET（wrangler secret put AUTH_SECRET），
 * 未设置时退回内置默认值（生产环境请务必设置）。
 */
function getSecret(env) {
  return env.AUTH_SECRET || 'download-station-default-secret-change-me';
}

/** HMAC-SHA256 签名（返回 Base64URL） */
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

/**
 * 生成登录令牌：base64url(payload).签名
 * payload = { uid: 用户ID, role: 角色, exp: 过期时间戳 }
 */
async function createToken(user, env) {
  const payload = {
    uid: user.id,
    role: user.role,
    exp: Date.now() + 7 * 24 * 3600 * 1000, // 7 天有效
  };
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmac(payloadB64, getSecret(env));
  return `${payloadB64}.${sig}`;
}

/** 校验令牌，合法时返回 payload，否则返回 null */
async function verifyToken(token, env) {
  if (!token) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  // 重算签名，比对是否一致（防篡改）
  const expect = await hmac(payloadB64, getSecret(env));
  if (expect !== sig) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadB64)));
    if (payload.exp < Date.now()) return null; // 已过期
    return payload;
  } catch {
    return null;
  }
}

/**
 * 密码哈希：PBKDF2-SHA256，10 万次迭代，随机 16 字节盐。
 * 存储格式："盐(hex):哈希(hex)"
 */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return `${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

/** 校验密码是否与存储哈希一致 */
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits)) === hashHex;
}

/** 从请求中解析 JSON 请求体（解析失败返回 null） */
async function readJson(request) {
  return request.json().catch(() => null);
}

// ------------------------------------------------------------------
//  权限校验
// ------------------------------------------------------------------

/** 校验登录态，未登录返回错误响应 */
async function requireLogin(request, env) {
  const payload = await verifyToken(getToken(request), env);
  if (!payload) return { error: fail('请先登录', 401) };
  return { user: payload };
}

/** 校验管理员权限，非管理员返回错误响应 */
async function requireAdmin(request, env) {
  const result = await requireLogin(request, env);
  if (result.error) return result;
  if (result.user.role !== 'admin') return { error: fail('需要管理员权限', 403) };
  return { user: result.user };
}

// ------------------------------------------------------------------
//  首次运行自动初始化（建管理员账号 + 示例数据）
// ------------------------------------------------------------------

let seedPromise = null;

/** 确保初始化只执行一次（模块级 Promise 防并发重复建数据） */
function ensureSeed(env) {
  if (!seedPromise) seedPromise = doSeed(env);
  return seedPromise;
}

/** 初始化：默认管理员 + 示例资源 + 默认设置 */
async function doSeed(env) {
  const db = env.DB;

  // 1) 若无管理员则创建默认管理员：admin / admin123（部署后请尽快修改密码）
  const admin = await db
    .prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    .first();
  if (!admin) {
    const hash = await hashPassword('admin123');
    await db
      .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .bind(newId(), 'admin', hash)
      .run();
  }

  // 2) 资源表为空时，填充示例数据，方便首次部署直接看到效果
  const count = await db.prepare('SELECT COUNT(*) AS n FROM items').first();
  if (count.n === 0) {
    const now = new Date().toISOString();
    const samples = [
      {
        name: '极速清理大师',
        category: 'app',
        type_tag: '系统工具',
        version: '3.2.1',
        description: '一键清理手机/电脑垃圾，释放存储空间',
        detailed_intro:
          '极速清理大师是一款轻量级系统清理工具，支持缓存清理、大文件扫描、重复文件检测，让设备时刻保持流畅。',
        file_size: '18.5 MB',
      },
      {
        name: 'AI 写作助手',
        category: 'app',
        type_tag: '效率办公',
        version: '2.0.0',
        description: '智能生成文案、润色文章，提升写作效率',
        detailed_intro:
          'AI 写作助手基于大语言模型，提供文案生成、语法纠错、风格改写、摘要提炼等能力，是内容创作者的好帮手。',
        file_size: '42 MB',
      },
      {
        name: '霓虹主题插件',
        category: 'plugin',
        type_tag: '美化增强',
        version: '1.4.0',
        description: '为浏览器换上炫酷霓虹暗黑主题',
        detailed_intro:
          '霓虹主题插件为浏览器提供多套霓虹渐变主题皮肤，支持自定义配色与毛玻璃效果，让浏览体验更炫酷。',
        file_size: '2.3 MB',
      },
      {
        name: '网速加速插件',
        category: 'plugin',
        type_tag: '网络工具',
        version: '1.0.2',
        description: '智能优化网络连接，降低延迟',
        detailed_intro:
          '网速加速插件通过智能路由优化与缓存策略，帮助你降低网页加载延迟，提升访问速度。',
        file_size: '1.1 MB',
      },
    ];
    for (const s of samples) {
      await db
        .prepare(
          `INSERT INTO items
             (id, name, category, type_tag, description, detailed_intro, version, file_size, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          newId(), s.name, s.category, s.type_tag,
          s.description, s.detailed_intro, s.version, s.file_size, now, now
        )
        .run();
    }
  }

  // 3) 默认设置：联系我图片地址（管理员可在后台修改）
  const contact = await db
    .prepare("SELECT value FROM settings WHERE key = 'contact_image'")
    .first();
  if (!contact) {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES ('contact_image', ?)")
      .bind('') // 为空时前端显示“请到后台设置联系图片”占位
      .run();
  }
}

// ------------------------------------------------------------------
//  认证接口：登录 / 注册 / 当前用户
// ------------------------------------------------------------------

/** POST /api/auth/login —— 用户名密码登录，返回令牌 */
async function login(request, env) {
  const body = await readJson(request);
  const username = (body?.username || '').trim();
  const password = body?.password || '';
  if (!username || !password) return fail('请输入用户名和密码');

  const user = await env.DB
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return fail('用户名或密码错误', 401);
  }
  const token = await createToken(user, env);
  return json({
    success: true,
    data: {
      token,
      user: { id: user.id, username: user.username, role: user.role },
    },
  });
}

/** POST /api/auth/register —— 注册普通用户 */
async function register(request, env) {
  const body = await readJson(request);
  const username = (body?.username || '').trim();
  const password = body?.password || '';
  const email = (body?.email || '').trim();

  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) {
    return fail('用户名需为 2-20 位字母、数字、中文或下划线');
  }
  if (password.length < 6) return fail('密码至少 6 位');

  const exists = await env.DB
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (exists) return fail('用户名已存在', 409);

  const hash = await hashPassword(password);
  await env.DB
    .prepare("INSERT INTO users (id, username, password_hash, email, role) VALUES (?, ?, ?, ?, 'user')")
    .bind(newId(), username, hash, email || null)
    .run();
  return json({ success: true, message: '注册成功，请登录' });
}

/** GET /api/auth/me —— 根据令牌返回当前用户信息 */
async function me(request, env) {
  const result = await requireLogin(request, env);
  if (result.error) return result.error;
  const user = await env.DB
    .prepare('SELECT id, username, role, email, created_at FROM users WHERE id = ?')
    .bind(result.user.uid)
    .first();
  return json({ success: true, data: user });
}

// ------------------------------------------------------------------
//  资源接口：列表 / 详情 / 新建 / 修改 / 删除
// ------------------------------------------------------------------

/** GET /api/items?category=&search=&page=&pageSize= —— 分页查询资源 */
async function listItems(url, env) {
  const category = url.searchParams.get('category') || ''; // app / plugin / 空=全部
  const search = (url.searchParams.get('search') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get('pageSize') || '12', 10) || 12)
  );
  const offset = (page - 1) * pageSize;

  // 动态拼接 WHERE 条件（参数全部用 ? 占位，防止 SQL 注入）
  let where = 'WHERE is_active = 1';
  const binds = [];
  if (category) {
    where += ' AND category = ?';
    binds.push(category);
  }
  if (search) {
    where += ' AND (name LIKE ? OR type_tag LIKE ? OR description LIKE ?)';
    const like = `%${search}%`;
    binds.push(like, like, like);
  }

  const items = await env.DB
    .prepare(`SELECT * FROM items ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all();
  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM items ${where}`)
    .bind(...binds)
    .first();

  return json({
    success: true,
    data: { items: items.results, total: totalRow.n, page, pageSize },
  });
}

/** GET /api/items/:id —— 资源详情 */
async function getItem(id, env) {
  const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!item) return fail('资源不存在', 404);
  return json({ success: true, data: item });
}

/** POST /api/items —— 管理员发布新资源 */
async function createItem(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const body = await readJson(request);
  if (!body?.name?.trim()) return fail('请填写资源名称');

  const id = newId();
  await env.DB
    .prepare(
      `INSERT INTO items
         (id, name, category, type_tag, description, detailed_intro, icon_url,
          version, file_url, external_url, file_size, uploader_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      id,
      body.name.trim(),
      body.category === 'plugin' ? 'plugin' : 'app',
      body.type_tag || null,
      body.description || null,
      body.detailed_intro || null,
      body.icon_url || null,
      body.version || null,
      body.file_url || null,
      body.external_url || null,
      body.file_size || null,
      auth.user.uid
    )
    .run();
  return json({ success: true, message: '发布成功', data: { id } });
}

/** PUT /api/items/:id —— 管理员修改资源（只更新传入的字段） */
async function updateItem(request, id, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const body = await readJson(request);
  if (!body) return fail('参数错误');

  // 允许被修改的字段白名单
  const fields = [
    'name', 'category', 'type_tag', 'description', 'detailed_intro',
    'icon_url', 'version', 'file_url', 'external_url', 'file_size', 'is_active',
  ];
  const sets = [];
  const binds = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      binds.push(body[f]);
    }
  }
  if (sets.length === 0) return fail('没有需要修改的内容');

  sets.push("updated_at = datetime('now')");
  binds.push(id);
  const res = await env.DB
    .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (res.meta.changes === 0) return fail('资源不存在', 404);
  return json({ success: true, message: '修改成功' });
}

/** DELETE /api/items/:id —— 管理员删除资源（连带删除评论/点赞/下载历史） */
async function deleteItem(id, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const res = await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  if (res.meta.changes === 0) return fail('资源不存在', 404);
  await env.DB.prepare('DELETE FROM comments WHERE item_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM likes WHERE item_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM download_histories WHERE item_id = ?').bind(id).run();
  return json({ success: true, message: '删除成功' });
}

// ------------------------------------------------------------------
//  评论接口：查看 / 发布（站内自行评论）
// ------------------------------------------------------------------

/** GET /api/items/:id/comments —— 获取某资源的全部评论（新的在前） */
async function listComments(itemId, env) {
  const rows = await env.DB
    .prepare('SELECT * FROM comments WHERE item_id = ? ORDER BY created_at DESC LIMIT 200')
    .bind(itemId)
    .all();
  return json({ success: true, data: rows.results });
}

/** POST /api/items/:id/comments —— 发布评论（无需登录，填昵称即可） */
async function addComment(request, itemId, env) {
  const body = await readJson(request);
  const nickname = (body?.nickname || '').trim().slice(0, 30);
  const content = (body?.content || '').trim();

  if (!nickname) return fail('请填写昵称');
  if (!content) return fail('评论内容不能为空');
  if (content.length > 1000) return fail('评论内容过长（最多 1000 字）');

  // 确认资源存在
  const item = await env.DB.prepare('SELECT id FROM items WHERE id = ?').bind(itemId).first();
  if (!item) return fail('资源不存在', 404);

  await env.DB
    .prepare('INSERT INTO comments (id, item_id, nickname, content) VALUES (?, ?, ?, ?)')
    .bind(newId(), itemId, nickname, content)
    .run();
  return json({ success: true, message: '评论成功' });
}

// ------------------------------------------------------------------
//  下载接口：下载次数 +1，并记录历史
// ------------------------------------------------------------------

/** POST /api/items/:id/download —— 下载计数 +1（登录与否都可以下载） */
async function doDownload(request, itemId, env) {
  const ip = getClientIp(request);
  const token = getToken(request);
  const payload = await verifyToken(token, env);

  // 下载次数 +1（使用原子自增，避免并发错乱）
  const res = await env.DB
    .prepare(
      "UPDATE items SET download_count = download_count + 1, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(itemId)
    .run();
  if (res.meta.changes === 0) return fail('资源不存在', 404);

  // 记录一条下载历史
  await env.DB
    .prepare(
      'INSERT INTO download_histories (id, item_id, user_id, ip_address) VALUES (?, ?, ?, ?)'
    )
    .bind(newId(), itemId, payload?.uid || null, ip)
    .run();

  const item = await env.DB
    .prepare('SELECT id, name, download_count, file_url, external_url FROM items WHERE id = ?')
    .bind(itemId)
    .first();
  return json({
    success: true,
    message: '下载成功，下载量 +1',
    data: item,
  });
}

// ------------------------------------------------------------------
//  点赞接口：点赞次数 +1（同一 IP 只能点一次）
// ------------------------------------------------------------------

/** POST /api/items/:id/like —— 点赞计数 +1 */
async function doLike(request, itemId, env) {
  const ip = getClientIp(request);

  const item = await env.DB.prepare('SELECT id FROM items WHERE id = ?').bind(itemId).first();
  if (!item) return fail('资源不存在', 404);

  // 先插入点赞记录：利用 UNIQUE(item_id, ip_address) 约束去重
  try {
    await env.DB
      .prepare('INSERT INTO likes (id, item_id, ip_address) VALUES (?, ?, ?)')
      .bind(newId(), itemId, ip)
      .run();
  } catch {
    return fail('你已经点过赞啦', 409); // 唯一约束冲突 → 重复点赞
  }

  // 点赞次数 +1
  await env.DB
    .prepare('UPDATE items SET like_count = like_count + 1 WHERE id = ?')
    .bind(itemId)
    .run();

  const row = await env.DB
    .prepare('SELECT like_count FROM items WHERE id = ?')
    .bind(itemId)
    .first();
  return json({
    success: true,
    message: '点赞成功',
    data: { like_count: row.like_count },
  });
}

// ------------------------------------------------------------------
//  文件接口：上传（R2）/ 下载（流式）
// ------------------------------------------------------------------

/** POST /api/upload —— 管理员上传文件到 R2，返回站内访问地址 */
async function uploadFile(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const form = await request.formData().catch(() => null);
  if (!form) return fail('请通过表单上传文件');
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('没有收到文件');

  // 文件名清洗（只保留字母数字、点、横线、下划线，防止路径注入）
  const safeName = file.name.replace(/[^\w.\-]/g, '_');
  const key = `${Date.now()}-${safeName}`; // 加时间戳避免同名覆盖

  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return json({
    success: true,
    message: '上传成功',
    data: { key, url: `/api/files/${key}`, name: file.name, size: file.size },
  });
}

/** GET /api/files/:key —— 从 R2 流式返回文件内容 */
async function getFile(key, env) {
  const obj = await env.FILES.get(key);
  if (!obj) return fail('文件不存在', 404);
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(obj.body, { headers });
}

// ------------------------------------------------------------------
//  留言建议接口
// ------------------------------------------------------------------

/** POST /api/messages —— 访客提交留言建议 */
async function createMessage(request, env) {
  const body = await readJson(request);
  const name = (body?.name || '匿名').trim().slice(0, 30);
  const email = (body?.email || '').trim().slice(0, 100);
  const content = (body?.content || '').trim();
  if (!content) return fail('留言内容不能为空');
  if (content.length > 2000) return fail('留言过长（最多 2000 字）');

  await env.DB
    .prepare('INSERT INTO messages (id, name, email, content) VALUES (?, ?, ?, ?)')
    .bind(newId(), name, email || null, content)
    .run();
  return json({ success: true, message: '留言成功，感谢你的建议！' });
}

/** GET /api/messages —— 管理员查看全部留言 */
async function listMessages(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const rows = await env.DB
    .prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200')
    .all();
  return json({ success: true, data: rows.results });
}

/** PUT /api/messages/:id/read —— 管理员标记已读 */
async function markMessageRead(id, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(id).run();
  return json({ success: true, message: '已标记为已读' });
}

/** PUT /api/messages/:id/reply —— 管理员回复留言 */
async function replyMessage(request, id, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const body = await readJson(request);
  if (!body?.reply?.trim()) return fail('回复内容不能为空');
  await env.DB
    .prepare('UPDATE messages SET reply = ?, is_read = 1 WHERE id = ?')
    .bind(body.reply.trim(), id)
    .run();
  return json({ success: true, message: '回复成功' });
}

// ------------------------------------------------------------------
//  历史 / 统计 / 设置接口
// ------------------------------------------------------------------

/** GET /api/history —— 下载历史：管理员看全部，登录用户看自己，未登录按 IP 看 */
async function listHistory(request, env) {
  const token = getToken(request);
  const payload = await verifyToken(token, env);
  const ip = getClientIp(request);

  let rows;
  if (payload?.role === 'admin') {
    rows = await env.DB
      .prepare(
        `SELECT h.*, i.name AS item_name FROM download_histories h
         LEFT JOIN items i ON h.item_id = i.id
         ORDER BY h.created_at DESC LIMIT 100`
      )
      .all();
  } else if (payload?.uid) {
    rows = await env.DB
      .prepare(
        `SELECT h.*, i.name AS item_name FROM download_histories h
         LEFT JOIN items i ON h.item_id = i.id
         WHERE h.user_id = ? ORDER BY h.created_at DESC LIMIT 100`
      )
      .bind(payload.uid)
      .all();
  } else {
    rows = await env.DB
      .prepare(
        `SELECT h.*, i.name AS item_name FROM download_histories h
         LEFT JOIN items i ON h.item_id = i.id
         WHERE h.ip_address = ? ORDER BY h.created_at DESC LIMIT 100`
      )
      .bind(ip)
      .all();
  }
  return json({ success: true, data: rows.results });
}

/** GET /api/stats —— 站点统计（首页展示） */
async function getStats(env) {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(download_count), 0) AS downloads,
              COALESCE(SUM(like_count), 0) AS likes
       FROM items WHERE is_active = 1`
    )
    .first();
  const comments = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments').first();
  return json({
    success: true,
    data: { items: row.items, downloads: row.downloads, likes: row.likes, comments: comments.n },
  });
}

/** GET /api/settings/:key —— 读取站点设置项 */
async function getSetting(key, env) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return json({ success: true, data: { key, value: row?.value || null } });
}

/** PUT /api/settings —— 管理员写入站点设置（upsert） */
async function updateSettings(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const body = await readJson(request);
  if (!body || typeof body.key !== 'string' || typeof body.value !== 'string') {
    return fail('参数错误');
  }
  await env.DB
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .bind(body.key, body.value)
    .run();
  return json({ success: true, message: '设置已保存' });
}

// ------------------------------------------------------------------
//  路由分发
// ------------------------------------------------------------------

/** 处理所有 /api/* 请求 */
async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---------- 认证 ----------
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/register' && method === 'POST') return register(request, env);
  if (path === '/api/auth/me' && method === 'GET') return me(request, env);

  // ---------- 资源 ----------
  if (path === '/api/items' && method === 'GET') return listItems(url, env);
  if (path === '/api/items' && method === 'POST') return createItem(request, env);

  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch) {
    const id = itemMatch[1];
    if (method === 'GET') return getItem(id, env);
    if (method === 'PUT') return updateItem(request, id, env);
    if (method === 'DELETE') return deleteItem(id, env);
  }

  // ---------- 评论 ----------
  const commentMatch = path.match(/^\/api\/items\/([^/]+)\/comments$/);
  if (commentMatch) {
    const id = commentMatch[1];
    if (method === 'GET') return listComments(id, env);
    if (method === 'POST') return addComment(request, id, env);
  }

  // ---------- 下载 / 点赞 ----------
  const downloadMatch = path.match(/^\/api\/items\/([^/]+)\/download$/);
  if (downloadMatch && method === 'POST') return doDownload(request, downloadMatch[1], env);

  const likeMatch = path.match(/^\/api\/items\/([^/]+)\/like$/);
  if (likeMatch && method === 'POST') return doLike(request, likeMatch[1], env);

  // ---------- 文件 ----------
  if (path === '/api/upload' && method === 'POST') return uploadFile(request, env);
  const fileMatch = path.match(/^\/api\/files\/(.+)$/);
  if (fileMatch && method === 'GET') return getFile(fileMatch[1], env);

  // ---------- 留言建议 ----------
  if (path === '/api/messages' && method === 'POST') return createMessage(request, env);
  if (path === '/api/messages' && method === 'GET') return listMessages(request, env);
  const msgRead = path.match(/^\/api\/messages\/([^/]+)\/read$/);
  if (msgRead && method === 'PUT') return markMessageRead(msgRead[1], env);
  const msgReply = path.match(/^\/api\/messages\/([^/]+)\/reply$/);
  if (msgReply && method === 'PUT') return replyMessage(request, msgReply[1], env);

  // ---------- 历史 / 统计 / 设置 ----------
  if (path === '/api/history' && method === 'GET') return listHistory(request, env);
  if (path === '/api/stats' && method === 'GET') return getStats(env);
  if (path === '/api/settings' && method === 'PUT') return updateSettings(request, env);
  const settingMatch = path.match(/^\/api\/settings\/([^/]+)$/);
  if (settingMatch && method === 'GET') return getSetting(settingMatch[1], env);

  return fail('接口不存在', 404);
}

// ------------------------------------------------------------------
//  主入口：fetch 事件
// ------------------------------------------------------------------

export default {
  /**
   * 所有请求都会进入这里：
   *  - /api/*  → 走后端逻辑
   *  - 其他    → 交给静态资源（public/ 前端页面）
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        await ensureSeed(env); // 首次运行自动初始化（管理员 + 示例数据）
        return await handleApi(request, env);
      } catch (err) {
        console.error('[download-station] 服务器错误:', err);
        return fail('服务器内部错误：' + (err?.message || err), 500);
      }
    }

    // 静态资源：由 Workers Static Assets 自动托管 public/ 目录
    return env.ASSETS.fetch(request);
  },
};
