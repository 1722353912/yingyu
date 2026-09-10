-- ============================================================
--  应用插件下载站 · D1 数据库表结构（SQLite 语法）
-- ============================================================
--  建表命令：wrangler d1 execute download-station-db --file=./schema.sql
--  本地调试：wrangler d1 execute download-station-db --local --file=./schema.sql
-- ============================================================

-- 1) 用户表：管理员 + 普通注册用户
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                          -- 用户ID（UUID）
  username      TEXT NOT NULL UNIQUE,                      -- 用户名（唯一）
  password_hash TEXT NOT NULL,                             -- 密码哈希（PBKDF2，格式：盐:哈希）
  role          TEXT NOT NULL DEFAULT 'user',              -- 角色：admin 管理员 / user 普通用户
  email         TEXT,                                      -- 邮箱（选填）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))    -- 注册时间（UTC）
);

-- 2) 应用/插件资源表
CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,                         -- 资源ID（UUID）
  name           TEXT NOT NULL,                            -- 名称
  category       TEXT NOT NULL DEFAULT 'app',              -- 分类：app 应用 / plugin 插件
  type_tag       TEXT,                                     -- 细分标签（如：工具/美化/游戏…）
  description    TEXT,                                     -- 一句话简介
  detailed_intro TEXT,                                     -- 详细介绍
  icon_url       TEXT,                                     -- 图标地址（为空则前端自动生成渐变图标）
  version        TEXT,                                     -- 版本号
  download_count INTEGER NOT NULL DEFAULT 0,               -- 下载次数（每次有人下载自动 +1）
  like_count     INTEGER NOT NULL DEFAULT 0,               -- 点赞次数（每次有人点赞自动 +1）
  file_url       TEXT,                                     -- 站内文件地址（/api/files/xxx，上传到 R2 的文件）
  external_url   TEXT,                                     -- 外部下载链接（与 file_url 二选一）
  file_size      TEXT,                                     -- 文件大小描述
  is_active      INTEGER NOT NULL DEFAULT 1,               -- 是否上架：1 上架 / 0 下架
  uploader_id    TEXT,                                     -- 上传人（users.id）
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),  -- 创建时间
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))   -- 更新时间
);

-- 3) 评论区：每个资源下的用户评论（新增功能）
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,                                -- 所属资源ID
  nickname   TEXT NOT NULL,                                -- 评论者昵称
  content    TEXT NOT NULL,                                -- 评论内容
  created_at TEXT NOT NULL DEFAULT (datetime('now'))       -- 评论时间
);

-- 4) 留言建议：访客给作者的留言
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  name       TEXT,                                         -- 留言人昵称
  email      TEXT,                                         -- 留言人邮箱
  content    TEXT NOT NULL,                                -- 留言内容
  is_read    INTEGER NOT NULL DEFAULT 0,                   -- 是否已读：0 未读 / 1 已读
  reply      TEXT,                                         -- 作者回复
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5) 下载历史：每次下载记录一条
CREATE TABLE IF NOT EXISTS download_histories (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,                                -- 下载的资源ID
  user_id    TEXT,                                         -- 登录用户ID（未登录为 NULL）
  ip_address TEXT,                                         -- 客户端IP（未登录时用于识别）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 6) 点赞记录：防止同一 IP 对同一资源重复点赞
CREATE TABLE IF NOT EXISTS likes (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, ip_address)                             -- 同一资源 + 同一IP 只能出现一次
);

-- 7) 站点设置：键值对（如“联系我”图片地址 contact_image）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 常用索引，加快查询速度
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_active  ON items(is_active);
CREATE INDEX IF NOT EXISTS idx_comments_item  ON comments(item_id);
CREATE INDEX IF NOT EXISTS idx_histories_item ON download_histories(item_id);
CREATE INDEX IF NOT EXISTS idx_histories_user ON download_histories(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_read  ON messages(is_read);
