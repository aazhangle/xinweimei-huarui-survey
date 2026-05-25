# 信为美花蕊焕新调研系统 - Cloudflare Pages + D1 部署说明

## 已完成的 Cloudflare 化改造

- 前台问卷页面、首页、感谢页、后台列表、详情、分析、题目编辑器保留原有结构和视觉风格。
- Manus Storage 资源已迁移到 `client/public/assets/`。
- Manus 运行时插件已从 Vite 构建中移除。
- 新增 Cloudflare Pages Functions 后端：`functions/api/trpc/[[path]].ts`。
- 新增 D1 数据库适配层：`server/cloudflareDb.ts`。
- 新增 Cloudflare 版 tRPC Router：`server/cloudflareRouter.ts`。
- 新增 CSV 导出接口：`functions/api/admin/export-excel.ts`，可用 Excel 打开。
- 新增 D1 初始化迁移：`migrations/0001_init.sql`。
- 新增 `wrangler.toml` 模板。
- 新增 SPA 刷新兜底：`client/public/_redirects`。

## 一、Cloudflare Pages 构建配置

Cloudflare Pages 项目中填写：

```txt
Build command: pnpm build
Build output directory: dist/public
Root directory: / 或留空
```

如果 Cloudflare 没有自动识别 pnpm，也可以改用：

```txt
Build command: npm run build
Build output directory: dist/public
```

## 二、创建 D1 数据库

在本地安装并登录 Wrangler 后执行：

```bash
npx wrangler login
npx wrangler d1 create xinweimei-survey
```

把返回的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "xinweimei-survey"
database_id = "这里替换成 Cloudflare 返回的 ID"
migrations_dir = "migrations"
```

执行远程迁移：

```bash
npx wrangler d1 migrations apply xinweimei-survey --remote
```

## 三、设置环境变量

在 Cloudflare Pages 项目：

Settings → Environment variables

建议设置：

```txt
JWT_SECRET=一串很长的随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=正式后台密码
```

第一次后台登录时，如果 D1 里还没有管理员，会自动创建管理员账号。

## 四、后台地址

部署成功后：

```txt
前台首页：你的域名/
问卷填写：你的域名/survey
后台登录：你的域名/admin/login
```

## 五、和旧版一致性说明

保持一致：

- 首页视觉风格
- 问卷分步骤填写
- 草稿保存
- 提交成功页
- 后台登录
- 客户列表、筛选、详情
- 数据分析图表
- 城市地图统计
- 题目编辑器

有变化：

- 后端从 Express/MySQL 改为 Cloudflare Pages Functions + D1。
- 原 XLSX 导出改为 CSV 导出，文件可用 Excel 直接打开。这样更适合 Cloudflare Workers Runtime。
- 后台登录从 Cookie Session 改为 localStorage Token + Authorization Header，适配 Cloudflare Functions。

## 六、上线后建议

1. 修改 `ADMIN_PASSWORD`，不要使用默认密码。
2. 正式域名绑定完成后，重新生成二维码并替换 `client/public/assets/xinweimei-qrcode.png`。
3. 如后续提交量很大，可把 D1 切换为外部 MySQL + Hyperdrive。
4. 如要防刷，可后续加入 Cloudflare Turnstile。
