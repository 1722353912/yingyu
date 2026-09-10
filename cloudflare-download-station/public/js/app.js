/**
 * ============================================================
 *  应用插件下载站 · 前端核心逻辑（路由 + 页面渲染）
 * ============================================================
 *  纯原生 JS + hash 路由，无需构建步骤，改完即可直接部署。
 *
 *  页面路由：
 *   #/                 首页（英雄区 + 统计 + 板块入口 + 热门推荐）
 *   #/apps             应用列表
 *   #/plugins          插件列表
 *   #/search?q=xxx     搜索结果
 *   #/item/:id         详情页（下载 / 点赞 / 评论区）
 *   #/messages         留言建议
 *   #/contact          联系我
 *   #/login            登录
 *   #/register         注册
 *   #/admin            管理后台（上传 / 管理 / 留言 / 设置）
 *   #/history          下载历史
 * ============================================================
 */

/* ==========================================================
   工具函数
   ========================================================== */

/** 简化选择器 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 把 HTML 字符串转成 DOM 元素 */
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** HTML 转义，防止 XSS（所有用户输入都要过一遍） */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 时间格式化。
 * 后端 D1 存的是 UTC 时间（"YYYY-MM-DD HH:MM:SS"），
 * 这里补上 Z 转成当地时区显示。
 */
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 轻提示：msg 内容，isError 是否红色错误提示 */
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

/**
 * 资源图标渲染：
 * 有 icon_url 就显示图片，否则用名称首字符 + 主题渐变生成图标。
 */
function itemIcon(item, cls = 'item-icon') {
  const ch = esc((item.name || '?').slice(0, 1).toUpperCase());
  const img = item.icon_url
    ? `<img src="${esc(item.icon_url)}" alt="" onerror="this.remove()" />`
    : '';
  return `<div class="${cls}">${img}${img ? '' : ch}</div>`;
}

/* ==========================================================
   导航栏状态
   ========================================================== */

/** 根据当前路由高亮导航项 */
function renderNavActive() {
  const path = location.hash.replace(/^#/, '') || '/';
  $$('#nav-links a').forEach((a) => {
    const r = a.dataset.route;
    const active =
      r === path || (r === '/' && path === '/') || (r !== '/' && path.startsWith(r));
    a.classList.toggle('active', !!active);
  });
}

/** 渲染右上角登录状态区 */
function renderUserArea() {
  const area = $('#user-area');
  const user = getCurrentUser();
  const adminLink = $('#nav-admin');

  // 管理员才显示"管理后台"入口
  adminLink.classList.toggle('hidden', !isAdmin());

  if (user) {
    area.innerHTML = `
      <span class="user-chip">👤 <b>${esc(user.username)}</b>${user.role === 'admin' ? '（管理员）' : ''}</span>
      <button class="btn btn-sm" id="btn-logout">退出</button>
    `;
    $('#btn-logout').addEventListener('click', () => {
      clearAuth();
      renderUserArea();
      toast('已退出登录');
    });
  } else {
    area.innerHTML = `
      <a href="#/login" class="btn btn-sm">登录</a>
      <a href="#/register" class="btn btn-sm btn-primary">注册</a>
    `;
  }
}

/** 渲染导航栏 + 用户区 + 高亮（每次路由切换都调用） */
function renderChrome() {
  renderNavActive();
  renderUserArea();
}

/* ==========================================================
   路由
   ========================================================== */

// 路由表：pattern 为正则，命中后调用对应渲染函数（返回 HTML 字符串）
const routes = [];

function route(pattern, fn) {
  routes.push({ pattern, fn });
}

/** 解析当前 hash，返回 { fn, params, query } */
function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const query = new URLSearchParams(queryPart || '');
  for (const r of routes) {
    const m = pathPart.match(r.pattern);
    if (m) return { fn: r.fn, params: m.slice(1), query };
  }
  return { fn: notFoundPage, params: [], query };
}

/** 主渲染入口：切换路由时调用 */
async function render() {
  renderChrome();
  const { fn, params, query } = parseRoute();
  const app = $('#app');
  app.innerHTML = '<div class="empty"><div class="empty-icon">🌀</div>加载中...</div>';
  try {
    const html = await fn(params, query);
    app.innerHTML = html;
    // 绑定页面级事件（由各页面函数在返回前通过 bindPage 注册）
    if (window._pageBinds) {
      window._pageBinds();
      window._pageBinds = null;
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = '<div class="empty"><div class="empty-icon">💥</div>页面加载失败</div>';
  }
  window.scrollTo({ top: 0 });
}

/**
 * 页面级事件绑定注册器：
 * 页面渲染函数里调用 bindPage(() => { ...绑定事件... })，
 * 渲染完成后自动执行，保证元素已存在于 DOM。
 */
function bindPage(fn) {
  window._pageBinds = fn;
}

// 监听 hash 变化
window.addEventListener('hashchange', render);

/* ==========================================================
   公共组件
   ========================================================== */

/** 资源卡片（列表 / 首页热门共用） */
function itemCard(item) {
  return `
    <div class="card item-card" data-id="${esc(item.id)}" onclick="location.hash='#/item/${esc(item.id)}'">
      <div class="item-card-head">
        ${itemIcon(item)}
        <div>
          <h3>${esc(item.name)}</h3>
          <div class="item-tags">
            <span class="badge badge-cat">${item.category === 'plugin' ? '插件' : '应用'}</span>
            ${item.type_tag ? `<span class="badge badge-type">${esc(item.type_tag)}</span>` : ''}
            ${item.version ? `<span class="badge badge-version">v${esc(item.version)}</span>` : ''}
          </div>
        </div>
      </div>
      <p class="item-desc">${esc(item.description || '暂无简介')}</p>
      <div class="item-meta">
        <span>⬇️ ${item.download_count ?? 0}</span>
        <span>👍 ${item.like_count ?? 0}</span>
        ${item.file_size ? `<span>📦 ${esc(item.file_size)}</span>` : ''}
      </div>
    </div>
  `;
}

/** 通用资源网格（items 数组 → 卡片列表；空则显示空状态） */
function itemsGrid(items) {
  if (!items.length) {
    return '<div class="empty"><div class="empty-icon">🛸</div>这里空空如也~</div>';
  }
  return `<div class="items-grid">${items.map(itemCard).join('')}</div>`;
}

/** 分页控件 */
function pagination(total, page, pageSize, baseUrl) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return '';
  const prev = page > 1 ? `href="${baseUrl}&page=${page - 1}"` : '';
  const next = page < totalPages ? `href="${baseUrl}&page=${page + 1}"` : '';
  return `
    <div class="pagination">
      <a class="btn btn-sm ${page <= 1 ? 'hidden' : ''}" ${prev}>← 上一页</a>
      <span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
      <a class="btn btn-sm ${page >= totalPages ? 'hidden' : ''}" ${next}>下一页 →</a>
    </div>
  `;
}

/* ==========================================================
   页面：首页
   ========================================================== */
route(/^\/$/, async () => {
  // 并行请求：站点统计 + 应用/插件热门数据
  const [statsRes, appsRes, pluginsRes] = await Promise.all([
    API.getStats(),
    API.listItems({ category: 'app', pageSize: 6 }),
    API.listItems({ category: 'plugin', pageSize: 6 }),
  ]);
  const stats = statsRes.data || {};
  const apps = appsRes.data?.items || [];
  const plugins = pluginsRes.data?.items || [];

  return `
    <div class="page">
      <!-- 英雄区 -->
      <section class="hero">
        <h1>⚡ 应用插件下载站</h1>
        <p>超炫酷的应用与插件分享平台 —— 发现、点赞、评论、下载，一站式搞定。管理员可随时上传新资源。</p>
        <div class="hero-actions">
          <a href="#/apps" class="btn btn-primary">📱 浏览应用</a>
          <a href="#/plugins" class="btn">🧩 浏览插件</a>
          <a href="#/messages" class="btn">💬 留言建议</a>
        </div>
      </section>

      <!-- 统计栏 -->
      <section class="stats-row">
        <div class="card stat-card"><div class="num">${stats.items ?? 0}</div><div class="label">资源总数</div></div>
        <div class="card stat-card"><div class="num">${stats.downloads ?? 0}</div><div class="label">累计下载</div></div>
        <div class="card stat-card"><div class="num">${stats.likes ?? 0}</div><div class="label">累计点赞</div></div>
        <div class="card stat-card"><div class="num">${stats.comments ?? 0}</div><div class="label">评论条数</div></div>
      </section>

      <!-- 两大板块入口 -->
      <h2 class="section-title">资源板块 <a href="#/apps">全部应用 →</a></h2>
      <div class="category-grid">
        <a href="#/apps" class="card category-card">
          <h3>📱 应用</h3>
          <p>效率工具、系统优化、创意软件……发现超好用的应用。</p>
          <span class="cat-count">${appsRes.data?.total ?? 0} 款应用</span>
        </a>
        <a href="#/plugins" class="card category-card">
          <h3>🧩 插件</h3>
          <p>主题美化、功能增强、效率提升……为你的设备加 Buff。</p>
          <span class="cat-count">${pluginsRes.data?.total ?? 0} 款插件</span>
        </a>
      </div>

      <!-- 热门应用 -->
      <h2 class="section-title">🔥 热门应用</h2>
      ${itemsGrid(apps)}

      <!-- 热门插件 -->
      <h2 class="section-title">🔥 热门插件</h2>
      ${itemsGrid(plugins)}
    </div>
  `;
});

/* ==========================================================
   页面：列表（应用 / 插件）与搜索
   ========================================================== */

/**
 * 通用列表页渲染函数
 * @param {string} category app / plugin
 * @param {URLSearchParams} query 页码等参数
 */
async function listPage(category, query) {
  const name = category === 'plugin' ? '插件' : '应用';
  const page = parseInt(query.get('page') || '1', 10) || 1;
  const pageSize = 12;
  const res = await API.listItems({ category, page, pageSize });
  const data = res.data || { items: [], total: 0 };
  const total = data.total;

  // 从数据里提取所有细分标签，生成筛选 chips
  const tags = [...new Set((data.items || []).map((i) => i.type_tag).filter(Boolean))];

  return `
    <div class="page">
      <h1 class="page-title">${name}专区</h1>
      <p class="page-sub">共 ${total} 款${name}，点击卡片查看详情、下载、点赞或评论</p>

      <div class="list-toolbar">
        <div class="filter-chips">
          <span class="chip active">全部</span>
          ${tags.map((t) => `<span class="chip" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}
        </div>
        <span class="list-total">共 ${total} 条</span>
      </div>

      <div id="list-body">${itemsGrid(data.items || [])}</div>
      ${pagination(total, page, pageSize, `#/${category === 'plugin' ? 'plugins' : 'apps'}?`)}
    </div>
  `;
}

route(/^\/apps$/, async (params, query) => listPage('app', query));
route(/^\/plugins$/, async (params, query) => listPage('plugin', query));

// 搜索页
route(/^\/search$/, async (params, query) => {
  const q = query.get('q') || '';
  const page = parseInt(query.get('page') || '1', 10) || 1;
  const res = await API.listItems({ search: q, page, pageSize: 12 });
  const data = res.data || { items: [], total: 0 };

  return `
    <div class="page">
      <h1 class="page-title">搜索结果</h1>
      <p class="page-sub">关键词：<b>${esc(q)}</b> · 共 ${data.total} 条</p>
      ${itemsGrid(data.items || [])}
      ${pagination(data.total, page, 12, `#/search?q=${encodeURIComponent(q)}&`)}
    </div>
  `;
});

/* ==========================================================
   页面：详情页（下载 / 点赞 / 评论）
   ========================================================== */
route(/^\/item\/(.+)$/, async (params) => {
  const id = decodeURIComponent(params[0]);
  const [itemRes, commentsRes] = await Promise.all([
    API.getItem(id),
    API.listComments(id),
  ]);
  if (!itemRes.success) {
    return `<div class="page"><div class="empty"><div class="empty-icon">🔍</div>${esc(itemRes.message)}</div></div>`;
  }
  const item = itemRes.data;
  const comments = commentsRes.data || [];

  return `
    <div class="page">
      <!-- 详情头部 -->
      <div class="card detail-head">
        ${itemIcon(item, 'detail-icon')}
        <div class="detail-info">
          <h1>${esc(item.name)}</h1>
          <div class="detail-meta">
            <span class="badge badge-cat">${item.category === 'plugin' ? '🧩 插件' : '📱 应用'}</span>
            ${item.type_tag ? `<span class="badge badge-type">${esc(item.type_tag)}</span>` : ''}
            ${item.version ? `<span class="badge badge-version">v${esc(item.version)}</span>` : ''}
            ${item.file_size ? `<span class="badge badge-version">📦 ${esc(item.file_size)}</span>` : ''}
          </div>
          <p class="detail-desc">${esc(item.description || '暂无简介')}</p>
          <div class="detail-stats">
            <span>下载 <b>${item.download_count ?? 0}</b></span>
            <span>点赞 <b>${item.like_count ?? 0}</b></span>
            <span>发布时间 <b>${fmtTime(item.created_at)}</b></span>
          </div>
        </div>

        <!-- 下载 / 点赞按钮区 -->
        <div class="detail-actions">
          <button class="btn btn-primary btn-download" id="btn-download">
            ⬇️ 立即下载（${item.download_count ?? 0}）
          </button>
          <button class="btn btn-like" id="btn-like">👍 点赞（${item.like_count ?? 0}）</button>
        </div>
      </div>

      <!-- 详细介绍 -->
      <div class="card detail-body">
        <h2>📋 详细介绍</h2>
        <div class="detail-intro">${esc(item.detailed_intro || item.description || '暂无详细介绍')}</div>
      </div>

      <!-- 评论区 -->
      <div class="card comments">
        <h2>💬 评论区<small>${comments.length} 条评论 · 本站直接评论，无需注册</small></h2>
        <form class="comment-form" id="comment-form">
          <input class="input" name="nickname" placeholder="你的昵称" maxlength="30" required />
          <textarea class="textarea" name="content" placeholder="说点什么吧..." maxlength="1000" required></textarea>
          <button class="btn btn-primary" type="submit">发表评论</button>
        </form>
        <div class="comment-list" id="comment-list">
          ${
            comments.length
              ? comments
                  .map(
                    (c) => `
                      <div class="comment-item">
                        <div class="comment-head">
                          <span class="comment-nick">${esc(c.nickname)}</span>
                          <span class="comment-time">${fmtTime(c.created_at)}</span>
                        </div>
                        <div class="comment-content">${esc(c.content)}</div>
                      </div>`
                  )
                  .join('')
              : '<div class="empty"><div class="empty-icon">✍️</div>还没有评论，快来抢沙发！</div>'
          }
        </div>
      </div>
    </div>
  `;
});

/* ==========================================================
   页面：留言建议
   ========================================================== */
route(/^\/messages$/, async () => {
  // 公开留言列表（含作者回复）
  const res = await API.listMessages().catch(() => null);
  const messages = res?.success && Array.isArray(res.data) ? res.data : [];

  return `
    <div class="page">
      <h1 class="page-title">留言与建议</h1>
      <p class="page-sub">对作者或网站有什么想说的？欢迎留言，作者会回复你哦~</p>

      <form class="card message-form" id="message-form">
        <div class="row">
          <div>
            <label class="label">昵称</label>
            <input class="input" name="name" placeholder="你的昵称" maxlength="30" />
          </div>
          <div>
            <label class="label">邮箱（选填）</label>
            <input class="input" name="email" type="email" placeholder="用于接收回复通知" maxlength="100" />
          </div>
        </div>
        <div>
          <label class="label">留言内容</label>
          <textarea class="textarea" name="content" placeholder="写下你的建议 / 想法..." maxlength="2000" required></textarea>
        </div>
        <button class="btn btn-primary" type="submit">💌 提交留言</button>
      </form>

      <h2 class="section-title">📢 公开留言</h2>
      <div class="message-list">
        ${
          messages.length
            ? messages
                .map(
                  (m) => `
                    <div class="card comment-item">
                      <div class="comment-head">
                        <span class="comment-nick">${esc(m.name || '匿名')}</span>
                        <span class="comment-time">${fmtTime(m.created_at)}</span>
                      </div>
                      <div class="comment-content">${esc(m.content)}</div>
                      ${
                        m.reply
                          ? `<div class="msg-reply" style="margin-top:8px">作者回复：${esc(m.reply)}</div>`
                          : ''
                      }
                    </div>`
                )
                .join('')
            : '<div class="empty"><div class="empty-icon">📭</div>暂无留言</div>'
        }
      </div>
    </div>
  `;
});

/* ==========================================================
   页面：联系我
   ========================================================== */
route(/^\/contact$/, async () => {
  // 联系图片地址存在站点设置里，管理员可在后台修改
  const res = await API.getSetting('contact_image').catch(() => null);
  const img = res?.data?.value;

  return `
    <div class="page">
      <div class="contact-wrap">
        <div class="card contact-card">
          <h2>📮 联系我</h2>
          <p>扫一扫二维码添加我的联系方式，或通过留言板给我留言~</p>
          ${
            img
              ? `<img class="contact-img" src="${esc(img)}" alt="联系二维码" />`
              : `<div class="contact-placeholder">二维码图片暂未设置<br/>管理员可在「管理后台 → 设置」中填写图片地址</div>`
          }
          <div style="margin-top:22px">
            <a href="#/messages" class="btn">💬 去留言</a>
          </div>
        </div>
      </div>
    </div>
  `;
});

/* ==========================================================
   页面：登录 / 注册
   ========================================================== */
route(/^\/login$/, () => {
  return `
    <div class="page">
      <div class="card auth-wrap">
        <h2>🔐 登录</h2>
        <form class="auth-form" id="login-form">
          <div>
            <label class="label">用户名</label>
            <input class="input" name="username" placeholder="请输入用户名" autocomplete="username" required />
          </div>
          <div>
            <label class="label">密码</label>
            <input class="input" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" required />
          </div>
          <button class="btn btn-primary" type="submit">登 录</button>
        </form>
        <p class="auth-switch">还没有账号？<a href="#/register">立即注册</a></p>
        <p class="auth-contact">📮 <a href="#/contact">联系我</a></p>
      </div>
    </div>
  `;
});

route(/^\/register$/, () => {
  return `
    <div class="page">
      <div class="card auth-wrap">
        <h2>📝 注册</h2>
        <form class="auth-form" id="register-form">
          <div>
            <label class="label">用户名（2-20 位字母/数字/中文）</label>
            <input class="input" name="username" placeholder="设置用户名" required />
          </div>
          <div>
            <label class="label">邮箱（选填）</label>
            <input class="input" name="email" type="email" placeholder="邮箱" />
          </div>
          <div>
            <label class="label">密码（至少 6 位）</label>
            <input class="input" name="password" type="password" placeholder="设置密码" autocomplete="new-password" required />
          </div>
          <button class="btn btn-primary" type="submit">注 册</button>
        </form>
        <p class="auth-switch">已有账号？<a href="#/login">去登录</a></p>
      </div>
    </div>
  `;
});

/* ==========================================================
   页面：下载历史
   ========================================================== */
route(/^\/history$/, async () => {
  const user = getCurrentUser();
  if (!user) {
    return `
      <div class="page">
        <h1 class="page-title">下载历史</h1>
        <p class="page-sub">登录后可查看你的完整下载历史；未登录仅能看到当前设备（IP）的下载记录。</p>
        <div class="empty">
          <div class="empty-icon">📜</div>
          <p>当前未登录，仍会显示本机下载记录。</p>
        </div>
        ${await historyList()}
      </div>
    `;
  }
  return `
    <div class="page">
      <h1 class="page-title">下载历史</h1>
      <p class="page-sub">${esc(user.username)} 的下载记录</p>
      ${await historyList()}
    </div>
  `;
});

/** 渲染下载历史列表（登录/未登录都按后端逻辑返回对应记录） */
async function historyList() {
  const res = await API.listHistory().catch(() => null);
  const list = res?.success && Array.isArray(res.data) ? res.data : [];
  if (!list.length) {
    return '<div class="empty"><div class="empty-icon">🕳️</div>暂无下载记录，去下载一个试试？</div>';
  }
  return `
    <div class="history-list">
      ${list
        .map(
          (h) => `
            <div class="card history-item">
              <span class="h-icon">⬇️</span>
              <span class="h-name">${esc(h.item_name || '已删除的资源')}</span>
              <span class="h-time">${fmtTime(h.created_at)}</span>
            </div>`
        )
        .join('')}
    </div>
  `;
}

/* ==========================================================
   页面：管理后台（上传 / 资源管理 / 留言管理 / 设置）
   ========================================================== */
route(/^\/admin$/, async () => {
  // 非管理员直接拦下
  if (!isAdmin()) {
    return `
      <div class="page">
        <div class="empty">
          <div class="empty-icon">🔒</div>
          <p>需要管理员权限才能进入后台</p>
          <p style="margin-top:14px"><a class="btn btn-primary" href="#/login">去登录</a></p>
        </div>
      </div>
    `;
  }

  // 并行加载资源与留言数据
  const [itemsRes, msgsRes] = await Promise.all([
    API.listItems({ page: 1, pageSize: 50 }).catch(() => null),
    API.listMessages().catch(() => null),
  ]);
  const items = itemsRes?.data?.items || [];
  const msgs = msgsRes?.success && Array.isArray(msgsRes.data) ? msgsRes.data : [];

  return `
    <div class="page">
      <h1 class="page-title">管理后台</h1>
      <p class="page-sub">发布 / 管理资源，查看留言建议，配置站点设置</p>

      <div class="admin-tabs">
        <button class="chip active" data-tab="upload">📤 发布资源</button>
        <button class="chip" data-tab="manage">🗂️ 资源管理（${items.length}）</button>
        <button class="chip" data-tab="messages">💬 留言管理（${msgs.length}）</button>
        <button class="chip" data-tab="settings">⚙️ 设置</button>
      </div>

      <!-- 发布资源 -->
      <div class="card admin-panel" id="panel-upload">
        <h2>📤 发布新资源</h2>
        <form class="upload-form" id="upload-form">
          <div>
            <label class="label">名称 *</label>
            <input class="input" name="name" placeholder="资源名称" required />
          </div>
          <div>
            <label class="label">分类 *</label>
            <select class="select" name="category">
              <option value="app">📱 应用</option>
              <option value="plugin">🧩 插件</option>
            </select>
          </div>
          <div>
            <label class="label">细分标签</label>
            <input class="input" name="type_tag" placeholder="如：系统工具 / 美化增强" />
          </div>
          <div>
            <label class="label">版本号</label>
            <input class="input" name="version" placeholder="如：1.0.0" />
          </div>
          <div class="full">
            <label class="label">一句话简介</label>
            <input class="input" name="description" placeholder="显示在卡片上的一句话介绍" />
          </div>
          <div class="full">
            <label class="label">详细介绍</label>
            <textarea class="textarea" name="detailed_intro" placeholder="资源的完整介绍，会展示在详情页"></textarea>
          </div>
          <div>
            <label class="label">图标地址（选填，留空自动生成）</label>
            <input class="input" name="icon_url" placeholder="https://.../icon.png" />
          </div>
          <div>
            <label class="label">文件大小</label>
            <input class="input" name="file_size" placeholder="如：18.5 MB" />
          </div>
          <div class="full">
            <label class="label">上传文件（存到 Cloudflare R2）</label>
            <input class="input" type="file" name="file" />
          </div>
          <div class="full">
            <label class="label">外部下载链接（选填，与上传文件二选一）</label>
            <input class="input" name="external_url" placeholder="https://example.com/download" />
          </div>
          <div class="full">
            <button class="btn btn-primary" type="submit">🚀 发布资源</button>
          </div>
        </form>
      </div>

      <!-- 资源管理 -->
      <div class="card admin-panel hidden" id="panel-manage">
        <h2>🗂️ 资源管理</h2>
        <div class="table-wrap" style="overflow-x:auto">
          <table class="admin-table">
            <thead>
              <tr>
                <th>名称</th><th>分类</th><th>下载</th><th>点赞</th><th>上架</th><th>操作</th>
              </tr>
            </thead>
            <tbody id="manage-body">
              ${items
                .map(
                  (it) => `
                    <tr data-id="${esc(it.id)}">
                      <td>${esc(it.name)}</td>
                      <td>${it.category === 'plugin' ? '插件' : '应用'}</td>
                      <td>${it.download_count ?? 0}</td>
                      <td>${it.like_count ?? 0}</td>
                      <td>${it.is_active ? '✅ 上架' : '⛔ 下架'}</td>
                      <td>
                        <div class="row-actions">
                          <a class="btn btn-sm" href="#/item/${esc(it.id)}">查看</a>
                          <button class="btn btn-sm" data-act="toggle">${it.is_active ? '下架' : '上架'}</button>
                          <button class="btn btn-sm btn-danger" data-act="delete">删除</button>
                        </div>
                      </td>
                    </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 留言管理 -->
      <div class="card admin-panel hidden" id="panel-messages">
        <h2>💬 留言管理</h2>
        <div id="msgs-body">
          ${
            msgs.length
              ? msgs
                  .map(
                    (m) => `
                      <div class="msg-card ${m.is_read ? '' : 'unread'}" data-id="${esc(m.id)}">
                        <div class="msg-head">
                          <b>${esc(m.name || '匿名')}</b>
                          ${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''}
                          <span style="color:var(--text-3)">${fmtTime(m.created_at)}</span>
                          ${m.is_read ? '' : '<span class="badge badge-type">未读</span>'}
                        </div>
                        <div class="msg-content">${esc(m.content)}</div>
                        ${
                          m.reply
                            ? `<div class="msg-reply">作者回复：${esc(m.reply)}</div>`
                            : ''
                        }
                        <div class="row-actions">
                          ${
                            m.is_read
                              ? ''
                              : `<button class="btn btn-sm" data-act="read">标为已读</button>`
                          }
                          <button class="btn btn-sm" data-act="reply">回复</button>
                        </div>
                      </div>`
                  )
                  .join('')
              : '<div class="empty">暂无留言</div>'
          }
        </div>
      </div>

      <!-- 设置 -->
      <div class="card admin-panel hidden" id="panel-settings">
        <h2>⚙️ 站点设置</h2>
        <form class="upload-form" id="settings-form">
          <div class="full">
            <label class="label">联系我二维码图片地址</label>
            <input class="input" name="contact_image" id="set-contact-img" placeholder="https://.../qr.png" />
            <p style="color:var(--text-3);font-size:12px;margin-top:6px">填写后，「联系我」页面会显示这张图片作为联系方式</p>
          </div>
          <div class="full">
            <button class="btn btn-primary" type="submit">💾 保存设置</button>
          </div>
        </form>
      </div>
    </div>
  `;
});

/* ==========================================================
   页面：404
   ========================================================== */
function notFoundPage() {
  return `
    <div class="page">
      <div class="empty">
        <div class="empty-icon">🚫</div>
        <h2>页面不存在</h2>
        <p style="margin-top:10px"><a class="btn btn-primary" href="#/">返回首页</a></p>
      </div>
    </div>
  `;
}

/* ==========================================================
   页面级事件绑定（每个页面返回后执行）
   ========================================================== */

/* ---- 详情页：下载 / 点赞 / 评论 ---- */
document.addEventListener('click', async (e) => {
  // 下载按钮
  if (e.target.closest('#btn-download')) {
    const btn = e.target.closest('#btn-download');
    const id = decodeURIComponent((location.hash.match(/^#\/item\/(.+)$/) || [])[1] || '');
    if (!id) return;
    btn.disabled = true;
    btn.textContent = '⏳ 正在处理...';
    const res = await API.download(id);
    btn.disabled = false;
    if (res.success) {
      const item = res.data;
      // 刷新按钮上的下载数
      btn.innerHTML = `⬇️ 立即下载（${item.download_count}）`;
      toast('下载成功，下载量 +1');
      // 有站内文件则直接打开下载，有外部链接则跳转
      if (item.file_url) {
        const a = document.createElement('a');
        a.href = item.file_url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (item.external_url) {
        window.open(item.external_url, '_blank');
      }
      // 更新页面上其他位置的计数显示
      const stat = $('.detail-stats');
      if (stat) stat.innerHTML = stat.innerHTML.replace(/(下载 <b>)\d+(<\/b>)/, `$1${item.download_count}$2`);
    } else {
      btn.innerHTML = `⬇️ 立即下载（${res.data?.download_count ?? ''}）`;
      toast(res.message || '下载失败', true);
    }
  }

  // 点赞按钮
  if (e.target.closest('#btn-like')) {
    const btn = e.target.closest('#btn-like');
    const id = decodeURIComponent((location.hash.match(/^#\/item\/(.+)$/) || [])[1] || '');
    if (!id) return;
    btn.disabled = true;
    const res = await API.like(id);
    btn.disabled = false;
    if (res.success) {
      btn.classList.add('liked');
      btn.innerHTML = `👍 已点赞（${res.data.like_count}）`;
      toast('点赞成功，+1 👍');
      const stat = $('.detail-stats');
      if (stat) stat.innerHTML = stat.innerHTML.replace(/(点赞 <b>)\d+(<\/b>)/, `$1${res.data.like_count}$2`);
    } else {
      toast(res.message || '点赞失败', true);
    }
  }
});

/* ---- 详情页：发布评论 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#comment-form');
  if (!form) return;
  e.preventDefault();
  const id = decodeURIComponent((location.hash.match(/^#\/item\/(.+)$/) || [])[1] || '');
  if (!id) return;
  const fd = new FormData(form);
  const res = await API.addComment(id, {
    nickname: fd.get('nickname'),
    content: fd.get('content'),
  });
  if (res.success) {
    toast('评论成功 ✨');
    form.reset();
    // 重新渲染详情页刷新评论区
    render();
  } else {
    toast(res.message || '评论失败', true);
  }
});

/* ---- 留言页：提交留言 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#message-form');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const res = await API.createMessage({
    name: fd.get('name'),
    email: fd.get('email'),
    content: fd.get('content'),
  });
  if (res.success) {
    toast('留言成功，感谢你的建议！💌');
    form.reset();
    render(); // 刷新公开留言列表
  } else {
    toast(res.message || '提交失败', true);
  }
});

/* ---- 登录页 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#login-form');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const res = await API.login({
    username: fd.get('username'),
    password: fd.get('password'),
  });
  if (res.success) {
    saveAuth(res.data.token, res.data.user);
    renderChrome();
    toast(`欢迎回来，${res.data.user.username}！`);
    // 管理员直接进后台，普通用户回首页
    location.hash = res.data.user.role === 'admin' ? '#/admin' : '#/';
  } else {
    toast(res.message || '登录失败', true);
  }
});

/* ---- 注册页 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#register-form');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const res = await API.register({
    username: fd.get('username'),
    email: fd.get('email'),
    password: fd.get('password'),
  });
  if (res.success) {
    toast('注册成功，请登录 🎉');
    location.hash = '#/login';
  } else {
    toast(res.message || '注册失败', true);
  }
});

/* ---- 管理后台：发布资源 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#upload-form');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const file = fd.get('file');

  let fileUrl = null;
  // 1) 如果选择了文件，先上传到 R2
  if (file && file.size > 0) {
    toast('正在上传文件...');
    const up = await API.upload(file);
    if (up.success) {
      fileUrl = up.data.url;
      toast('文件上传成功，正在发布...');
    } else {
      toast(up.message || '文件上传失败', true);
      return;
    }
  }

  // 2) 创建资源
  const res = await API.createItem({
    name: fd.get('name'),
    category: fd.get('category'),
    type_tag: fd.get('type_tag'),
    version: fd.get('version'),
    description: fd.get('description'),
    detailed_intro: fd.get('detailed_intro'),
    icon_url: fd.get('icon_url'),
    file_size: fd.get('file_size'),
    file_url: fileUrl,
    external_url: fd.get('external_url'),
  });
  if (res.success) {
    toast('发布成功 🚀');
    location.hash = '#/admin'; // 刷新后台，资源出现在管理列表
  } else {
    toast(res.message || '发布失败', true);
  }
});

/* ---- 管理后台：标签页切换 / 资源操作 / 留言操作 ---- */
document.addEventListener('click', async (e) => {
  // 标签页切换
  const tabBtn = e.target.closest('.admin-tabs .chip');
  if (tabBtn) {
    $$('.admin-tabs .chip').forEach((c) => c.classList.toggle('active', c === tabBtn));
    const tab = tabBtn.dataset.tab;
    ['upload', 'manage', 'messages', 'settings'].forEach((t) => {
      $(`#panel-${t}`).classList.toggle('hidden', t !== tab);
    });
    return;
  }

  // 资源管理：上架/下架
  const toggleBtn = e.target.closest('[data-act="toggle"]');
  if (toggleBtn) {
    const row = toggleBtn.closest('tr');
    const id = row.dataset.id;
    const isActive = toggleBtn.textContent.trim() === '下架' ? 0 : 1;
    const res = await API.updateItem(id, { is_active: isActive });
    toast(res.success ? '已更新' : res.message || '操作失败', !res.success);
    if (res.success) render();
    return;
  }

  // 资源管理：删除
  const delBtn = e.target.closest('[data-act="delete"]');
  if (delBtn) {
    const id = delBtn.closest('tr').dataset.id;
    if (!confirm('确定要删除该资源吗？相关评论与下载记录也会一并删除。')) return;
    const res = await API.deleteItem(id);
    toast(res.success ? '已删除' : res.message || '删除失败', !res.success);
    if (res.success) render();
    return;
  }

  // 留言管理：标为已读
  const readBtn = e.target.closest('[data-act="read"]');
  if (readBtn) {
    const id = readBtn.closest('.msg-card').dataset.id;
    const res = await API.markMessageRead(id);
    if (res.success) render();
    return;
  }

  // 留言管理：回复（用 prompt 简单输入）
  const replyBtn = e.target.closest('[data-act="reply"]');
  if (replyBtn) {
    const id = replyBtn.closest('.msg-card').dataset.id;
    const reply = prompt('输入你的回复内容：');
    if (reply === null) return;
    const res = await API.replyMessage(id, { reply });
    toast(res.success ? '回复成功' : res.message || '回复失败', !res.success);
    if (res.success) render();
    return;
  }
});

/* ---- 管理后台：保存设置 ---- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#settings-form');
  if (!form) return;
  e.preventDefault();
  const res = await API.updateSetting('contact_image', $('#set-contact-img').value.trim());
  toast(res.success ? '设置已保存' : res.message || '保存失败', !res.success);
});
