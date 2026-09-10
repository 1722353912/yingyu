# ⚡ 应用插件下载站（Cloudflare 完整部署版）

超炫酷的应用及插件下载分享平台。**纯前端 + Cloudflare Workers + D1 数据库 + R2 对象存储**，零构建步骤，源码完全可修改，可完整部署到 Cloudflare 免费套餐。

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| 💬 **站内评论** | 每个资源下可直接评论（填昵称即可，无需注册），评论持久化保存 |
| ⬇️ **下载计数** | 每次有人点击下载，下载量自动 **+1**，全站实时可见 |
| 👍 **点赞** | 每次点赞自动 **+1**，同一 IP 对同一资源只能点一次 |
| 🔐 登录/注册 | 管理员登录后可进入后台上传资源；普通用户/游客均可下载 |
| 📤 管理员上传 | 支持上传文件到 R2，或填写外部下载链接 |
| 📱/🧩 两大板块 | 应用、插件分区浏览，支持细分标签筛选 |
| 🔍 搜索 | 按名称/标签/简介搜索 |
| 🎨 三套主题 | 霓虹紫 / 科技蓝 / 暗夜绿，一键切换并记住选择 |
| 💫 1 秒加载动画 | 炫酷霓虹加载画面 |
| 💌 留言建议 | 访客留言，管理员可回复 |
| 📮 联系我 | 二维码/图片入口（后台可配置） |
| 📜 下载历史 | 管理员看全部，用户看自己的 |

## 📁 项目结构

```
cloudflare-download-station/
├── wrangler.toml        # Cloudflare 部署配置（D1 / R2 / 静态资源）
├── package.json         # 依赖与命令（wrangler）
├── schema.sql           # D1 数据库表结构（SQLite 语法）
├── README.md            # 本说明
├── src/
│   └── index.js         # 后端 Worker：全部 API（评论/下载+1/点赞+1/上传/登录…）
└── public/              # 前端（无需构建，改完直接生效）
    ├── index.html       # 页面骨架（加载动画、导航、页脚）
    ├── css/style.css    # 全部样式（暗黑霓虹 + 3 套主题变量）
    └── js/
        ├── api.js       # API 封装（自动带令牌、统一响应格式）
        ├── app.js       # 路由 + 全部页面渲染（首页/列表/详情/评论/后台…）
        └── main.js      # 启动入口（加载动画、主题、搜索框）
```

## 🚀 部署步骤（约 5 分钟）

### 1. 安装依赖

```bash
cd cloudflare-download-station
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页面，登录你的 Cloudflare 账号并授权即可。

### 3. 创建数据库（D1）

```bash
npx wrangler d1 create download-station-db
```

命令会输出一串 `database_id`，例如：

```
[[d1_databases]]
binding = "DB"
database_name = "download-station-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**把这段 `database_id` 填到 `wrangler.toml` 里**（替换 `REPLACE_WITH_YOUR_DATABASE_ID`）。

### 4. 创建存储桶（R2，用于存放上传的文件）

```bash
npx wrangler r2 bucket create download-station-files
```

### 5. 初始化数据库表

```bash
npx wrangler d1 execute download-station-db --file=./schema.sql
```

### 6. 设置令牌密钥（安全，必做）

```bash
npx wrangler secret put AUTH_SECRET
```

按提示输入一串任意随机字符（越长越好，例如 `M7xK2pQ9...`）。

### 7. 本地预览（可选）

```bash
npm run dev
```

浏览器打开 `http://localhost:8787` 即可预览。

### 8. 部署上线 🎉

```bash
npm run deploy
```

部署完成后会输出你的访问地址：`https://download-station.<你的子域>.workers.dev`。

> 也可以绑定自己的域名：Cloudflare 控制台 → Workers 详情 → 设置 → 域与路由。

## 👤 默认管理员

| 用户名 | 密码 |
|---|---|
| `admin` | `admin123` |

> ⚠️ **上线后请立即修改密码**：登录后台后暂时没有改密码入口，请直接在数据库执行：
> ```bash
> npx wrangler d1 execute download-station-db --remote --command "UPDATE users SET password_hash='' WHERE username='admin'"
> ```
> 或者在代码 `src/index.js` 的 `doSeed()` 里修改默认密码后重新部署（首次部署前修改最方便）。

## 🛠️ 常用修改

改完代码后重新执行 `npm run deploy` 即可生效（前端无需构建）。

- **改站点名称**：`public/index.html` 里的 `<title>` 与导航 Logo
- **改主题颜色**：`public/css/style.css` 顶部的三个 `body[data-theme]` 变量块
- **改每页显示数量**：`public/js/app.js` 里 `pageSize = 12`
- **加新的细分标签**：后台发布资源时填写即可，列表页自动出现筛选标签
- **换联系图片**：后台 → 设置 → 填写图片地址

## 🧩 核心技术点（改代码前先看这里）

- **下载 +1**：前端点「立即下载」→ `POST /api/items/:id/download` → 后端 `UPDATE items SET download_count = download_count + 1`（原子自增，并发安全）→ 返回最新计数 → 前端刷新显示。
- **点赞 +1**：`POST /api/items/:id/like` → 先往 `likes` 表插入 `(item_id, ip_address)`（有 UNIQUE 约束，重复点赞会冲突报错）→ 成功后再 `like_count + 1`。
- **评论**：`GET/POST /api/items/:id/comments`，填昵称即可发布，无需登录。
- **数据表**：见 `schema.sql`（users / items / comments / messages / download_histories / likes / settings）。
- **令牌**：JWT 风格 HMAC-SHA256 签名，密钥来自 `AUTH_SECRET` 环境变量，零外部依赖。
- **密码**：PBKDF2-SHA256 + 随机盐，100000 次迭代。

## ⚠️ 注意事项

- 本项目使用 Cloudflare **免费套餐**即可运行（Workers 免费额度、D1 免费额度、R2 免费存储额度）。
- 评论、点赞计数按 IP 去重；同一 NAT 下的用户可能被算作同一 IP，这是 Cloudflare 环境下的常见取舍。
- 如需完全自定义域名，可在 Cloudflare 控制台为 Workers 绑定域名。
