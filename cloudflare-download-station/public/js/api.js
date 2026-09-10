/**
 * ============================================================
 *  应用插件下载站 · 前端 API 封装层
 * ============================================================
 *  所有与后端交互的请求都从这里走：
 *   - 自动附带登录令牌（localStorage 中的 token）
 *   - 统一返回 { success, message, data }
 *   - 提供上传文件（multipart）能力
 * ============================================================
 */

// 登录令牌与用户信息的本地存储键
const TOKEN_KEY = 'token';
const USER_KEY = 'user';

/** 读取当前登录令牌 */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** 保存登录状态（登录成功后调用） */
function saveAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** 清除登录状态（退出登录时调用） */
function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** 读取当前登录用户（未登录返回 null） */
function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}

/** 是否已登录管理员 */
function isAdmin() {
  const user = getCurrentUser();
  return !!user && user.role === 'admin';
}

const API = {
  /**
   * 通用请求方法
   * @param {string} method  HTTP 方法
   * @param {string} path    接口路径（如 /api/items）
   * @param {object|undefined} data JSON 请求体（可不传）
   * @returns {Promise<object>} { success, message, data }
   */
  async request(method, path, data) {
    const opts = { method, headers: {} };
    // 已登录则自动携带令牌
    const token = getToken();
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    const res = await fetch(path, opts);
    // 兼容非 JSON 响应（如 500 页面）
    const body = await res.json().catch(() => ({ success: false, message: '网络异常，请稍后重试' }));
    return body;
  },

  get(path) {
    return this.request('GET', path);
  },

  post(path, data) {
    return this.request('POST', path, data);
  },

  put(path, data) {
    return this.request('PUT', path, data);
  },

  del(path) {
    return this.request('DELETE', path);
  },

  /** 上传文件（multipart），需管理员权限 */
  async upload(file) {
    const form = new FormData();
    form.append('file', file);
    const opts = { method: 'POST', body: form };
    const token = getToken();
    if (token) opts.headers = { Authorization: 'Bearer ' + token };
    const res = await fetch('/api/upload', opts);
    return res.json().catch(() => ({ success: false, message: '上传失败' }));
  },

  // ---------- 资源 ----------
  /** 分页查询资源列表（category: 'app' | 'plugin' | '' 全部；search 关键词） */
  listItems({ category = '', search = '', page = 1, pageSize = 12 } = {}) {
    const q = new URLSearchParams({ page, pageSize });
    if (category) q.set('category', category);
    if (search) q.set('search', search);
    return this.get(`/api/items?${q.toString()}`);
  },

  /** 查询资源详情 */
  getItem(id) {
    return this.get(`/api/items/${id}`);
  },

  /** 管理员发布资源 */
  createItem(data) {
    return this.post('/api/items', data);
  },

  /** 管理员修改资源 */
  updateItem(id, data) {
    return this.put(`/api/items/${id}`, data);
  },

  /** 管理员删除资源 */
  deleteItem(id) {
    return this.del(`/api/items/${id}`);
  },

  // ---------- 评论 ----------
  /** 获取某资源的评论列表 */
  listComments(itemId) {
    return this.get(`/api/items/${itemId}/comments`);
  },

  /** 发布评论（nickname 昵称 + content 内容） */
  addComment(itemId, data) {
    return this.post(`/api/items/${itemId}/comments`, data);
  },

  // ---------- 下载 / 点赞 ----------
  /** 下载：后端下载次数 +1，返回最新信息 */
  download(itemId) {
    return this.post(`/api/items/${itemId}/download`);
  },

  /** 点赞：后端点赞次数 +1（同一 IP 只能点一次） */
  like(itemId) {
    return this.post(`/api/items/${itemId}/like`);
  },

  // ---------- 认证 ----------
  login(data) {
    return this.post('/api/auth/login', data);
  },

  register(data) {
    return this.post('/api/auth/register', data);
  },

  me() {
    return this.get('/api/auth/me');
  },

  // ---------- 留言建议 ----------
  createMessage(data) {
    return this.post('/api/messages', data);
  },

  listMessages() {
    return this.get('/api/messages');
  },

  markMessageRead(id) {
    return this.put(`/api/messages/${id}/read`);
  },

  replyMessage(id, data) {
    return this.put(`/api/messages/${id}/reply`, data);
  },

  // ---------- 其他 ----------
  /** 下载历史 */
  listHistory() {
    return this.get('/api/history');
  },

  /** 站点统计（首页展示） */
  getStats() {
    return this.get('/api/stats');
  },

  /** 读取站点设置项 */
  getSetting(key) {
    return this.get(`/api/settings/${key}`);
  },

  /** 管理员写入站点设置项 */
  updateSetting(key, value) {
    return this.put('/api/settings', { key, value });
  },
};
