# DoH Worker

基于 Cloudflare Workers 的 DNS over HTTPS (DoH) 服务，支持自定义 hosts 解析规则。

## 功能特性

- ✅ 标准 RFC 8484 DoH 协议，支持 GET 和 POST 两种请求方式
- ✅ 自定义域名解析（类似 hosts 文件功能），指定域名返回优选 IP
- ✅ 未命中规则自动转发上游 DoH 服务器
- ✅ 支持静态配置和 Cloudflare KV 动态存储两种方式
- ✅ 内置 GitHub520 hosts 自动同步脚本
- ✅ 支持 Cron Triggers 定时自动同步到 KV，无需手动更新
- ✅ 提供 HTTP 手动同步接口，支持 token 鉴权
- ✅ 支持通配符后缀匹配（如 `.example.com` 匹配所有子域名）

## 项目结构

```
doh-worker/
├── src/
│   ├── index.js      # Worker 入口
│   ├── dns.js        # DNS 报文解析与构造
│   └── hosts.js      # 自定义 hosts 管理
├── scripts/
│   └── sync-hosts.js # GitHub520 hosts 同步脚本
├── wrangler.toml     # Wrangler 配置
└── package.json
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置自定义 hosts

编辑 `src/hosts.js` 中的 `STATIC_HOSTS` 对象：

```javascript
export const STATIC_HOSTS = {
  'github.com': '20.205.243.166',
  'api.github.com': '20.205.243.168',
  // 添加更多域名...
};
```

或者使用同步脚本从 GitHub520 获取最新优选 IP：

```bash
npm run sync-hosts
```

### 3. 本地开发调试

```bash
npm run dev
```

启动后本地测试：

```bash
# 测试 GET 方式
curl "http://localhost:8787/dns-query?dns=AAABAAABAAAAAAAABmdpdGh1YgNjb20AAAEAAQ"

# 测试健康检查
curl http://localhost:8787/health
```

### 4. 部署到 Cloudflare

```bash
npm run deploy
```

部署完成后，DoH 地址为：`https://你的-worker域名/dns-query`

## 配置说明

### 环境变量

在 `wrangler.toml` 中配置：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `UPSTREAM_DOH` | `https://cloudflare-dns.com/dns-query` | 上游 DoH 服务器地址 |
| `DOH_PATH` | `/dns-query` | DoH 服务路径 |
| `SYNC_TOKEN` | 无 | 手动同步接口鉴权 token，不配置则无鉴权 |

### KV 动态配置（可选）

如果需要不重新部署即可更新 hosts，可使用 Cloudflare KV：

1. 在 Cloudflare 控制台创建 KV 命名空间
2. 在 `wrangler.toml` 中配置 KV 绑定：

```toml
[[kv_namespaces]]
binding = "HOSTS_KV"
id = "你的KV命名空间ID"
```

3. 向 KV 中写入 key 为 `hosts_map`，value 为 JSON 格式的 hosts 映射：

```json
{
  "github.com": "20.205.243.166",
  "api.github.com": "20.205.243.168"
}
```

KV 中的规则优先级高于静态配置。

### 定时自动同步（推荐）

配置 KV 后，可开启 Cron Triggers 让 Worker 定时自动从 GitHub520 拉取最新 hosts 并同步到 KV，完全无需手动维护。

**配置步骤：**

1. 确保已配置 `HOSTS_KV` 命名空间（见上一节）
2. 在 `wrangler.toml` 中取消注释并调整 cron 表达式：

```toml
[triggers]
crons = ["0 */6 * * *"]  # 每 6 小时同步一次
```

3. 重新部署：`npm run deploy`

**Cron 表达式格式：** `分 时 日 月 周`

常用示例：
- `0 * * * *` — 每小时
- `0 */6 * * *` — 每 6 小时
- `0 0 * * *` — 每天 0 点
- `0 0 */3 * *` — 每 3 天

同步失败不会影响 DNS 服务，会继续使用 KV 中上一次成功同步的数据。

### 手动同步接口

配置 KV 后，可通过 HTTP 接口手动触发同步，方便立即拉取最新的 hosts。

**接口地址：** `POST https://你的域名/sync`

**鉴权（可选）：**

在 `wrangler.toml` 中配置 `SYNC_TOKEN` 环境变量启用鉴权：

```toml
[vars]
SYNC_TOKEN = "your-secret-token"
```

支持两种传参方式：
- Header: `X-Sync-Token: your-secret-token`
- Query 参数: `?token=your-secret-token`

不配置 `SYNC_TOKEN` 则无鉴权，任何人都能触发同步（不推荐）。

**响应示例：**

```json
{
  "count": 40,
  "updated_at": "2026-06-23T00:00:00.000Z"
}
```

**调用示例：**

```bash
# 带 token（header 方式）
curl -X POST https://你的域名/sync \
  -H "X-Sync-Token: your-secret-token"

# 带 token（query 方式）
curl -X POST "https://你的域名/sync?token=your-secret-token"
```

### 通配符匹配

支持后缀匹配，配置时域名以 `.` 开头：

```javascript
{
  '.example.com': '1.2.3.4'
}
```

上述配置会匹配 `foo.example.com`、`bar.baz.example.com` 等所有子域名。

## 客户端配置

### Firefox / Iceraven 浏览器

设置 → 隐私与安全 → 安全 DNS → 自定义 → 填入：

```
https://你的域名/dns-query
```

### iOS 系统

通过描述文件配置全局 DoH，或使用 DNS 工具类应用。

### 安卓系统

使用 AdGuard、Nebulo、Intra 等应用配置系统级 DoH。

## 同步脚本用法

```bash
# 同步并更新本地静态配置
node scripts/sync-hosts.js

# 仅输出 JSON 格式
node scripts/sync-hosts.js --json

# 输出 KV 兼容格式
node scripts/sync-hosts.js --kv
```

## 响应头说明

| 响应头 | 值 | 说明 |
|--------|----|------|
| `X-Custom-Host` | `true` / `false` | 是否命中了自定义 hosts 规则 |

可用于调试和验证规则是否生效。

## 注意事项

- Worker 免费版每日 10 万次请求，个人使用完全充足
- 仅支持 A 记录的自定义匹配，其他记录类型直接转发上游
- 如需 DoT（DNS over TLS）支持，需搭配 Cloudflare Zero Trust Gateway 使用
