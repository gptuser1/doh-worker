import {
  extractDnsQuery,
  decodeDnsQuery,
  buildAResponse,
  forwardToUpstream,
} from './dns.js';
import { STATIC_HOSTS, lookupHost, loadHostsFromKV } from './hosts.js';

const GITHUB520_URL = 'https://raw.githubusercontent.com/521xueweihan/GitHub520/main/hosts.json';

/**
 * 从 GitHub520 拉取并解析 hosts（JSON 格式）
 * @returns {Promise<object>} hosts 映射
 */
async function fetchGitHub520Hosts() {
  const response = await fetch(GITHUB520_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub520: ${response.status}`);
  }
  const data = await response.json();

  // 支持两种格式：
  // 1. 对象格式：{ "github.com": "1.2.3.4" }
  // 2. 数组格式：[{ "name": "github.com", "ip": "1.2.3.4" }]
  if (Array.isArray(data)) {
    const hosts = {};
    for (const item of data) {
      const domain = item.name || item.domain || item.host;
      const ip = item.ip || item.address || item.value;
      if (domain && ip) {
        hosts[domain.toLowerCase()] = ip;
      }
    }
    return hosts;
  }

  // 对象格式，直接转小写 key
  const hosts = {};
  for (const [domain, ip] of Object.entries(data)) {
    hosts[domain.toLowerCase()] = ip;
  }
  return hosts;
}

/**
 * 执行 GitHub520 hosts 同步到 KV
 * @param {KVNamespace} kv
 * @returns {Promise<{count: number, updated_at: string}>}
 */
async function syncHostsToKV(kv) {
  if (!kv) {
    throw new Error('HOSTS_KV not bound');
  }

  const hosts = await fetchGitHub520Hosts();
  const updatedAt = new Date().toISOString();

  await kv.put('hosts_map', JSON.stringify(hosts), {
    metadata: { updated_at: updatedAt },
  });

  return {
    count: Object.keys(hosts).length,
    updated_at: updatedAt,
  };
}

/**
 * Cloudflare Worker 入口
 *
 * 环境变量（wrangler.toml 中配置）：
 * - UPSTREAM_DOH: 上游 DoH 服务器地址
 * - DOH_PATH: DoH 服务路径，默认 /dns-query
 * - SYNC_TOKEN: 手动同步接口的鉴权 token（可选）
 *
 * KV 绑定（可选）：
 * - HOSTS_KV: 存储自定义 hosts 映射的 KV 命名空间
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dohPath = env.DOH_PATH || '/dns-query';

    // 健康检查
    if (url.pathname === '/health') {
      return new Response('OK', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // 手动同步接口
    if (url.pathname === '/sync') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // 鉴权：如果配置了 SYNC_TOKEN，则验证
      if (env.SYNC_TOKEN) {
        const token =
          request.headers.get('x-sync-token') ||
          url.searchParams.get('token');
        if (token !== env.SYNC_TOKEN) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      // 没有配置 KV
      if (!env.HOSTS_KV) {
        return new Response(
          JSON.stringify({ error: 'HOSTS_KV not configured' }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      try {
        const result = await syncHostsToKV(env.HOSTS_KV);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        console.error('Manual sync failed:', e);
        return new Response(
          JSON.stringify({ error: e.message }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 仅处理 DoH 路径
    if (url.pathname !== dohPath) {
      return new Response('Not Found', { status: 404 });
    }

    try {
      // 1. 提取并解析 DNS 查询
      const queryBuffer = await extractDnsQuery(request);
      const query = decodeDnsQuery(queryBuffer);
      const question = query.questions?.[0];

      // 无查询内容，直接转发上游
      if (!question) {
        const responseBuffer = await forwardToUpstream(
          queryBuffer,
          env.UPSTREAM_DOH,
          request.method
        );
        return new Response(responseBuffer, {
          headers: { 'Content-Type': 'application/dns-message' },
        });
      }

      const domain = question.name;
      const recordType = question.type;

      // 2. 仅对 A 记录查询做自定义匹配
      if (recordType === 'A') {
        // 从 KV 加载动态 hosts（如果配置了 KV）
        const kvHosts = await loadHostsFromKV(env.HOSTS_KV);

        // 查找自定义 hosts
        const customIp = lookupHost(domain, STATIC_HOSTS, kvHosts);

        if (customIp) {
          // 命中自定义规则，直接构造响应
          const responseBuffer = buildAResponse(query, customIp, 300);
          return new Response(responseBuffer, {
            headers: {
              'Content-Type': 'application/dns-message',
              'X-Custom-Host': 'true',
            },
          });
        }
      }

      // 3. 未命中规则，转发上游 DoH
      const responseBuffer = await forwardToUpstream(
        queryBuffer,
        env.UPSTREAM_DOH,
        request.method
      );

      return new Response(responseBuffer, {
        headers: {
          'Content-Type': 'application/dns-message',
          'X-Custom-Host': 'false',
        },
      });
    } catch (e) {
      console.error('DoH request failed:', e);

      if (e.message === 'Method not allowed') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (e.message === 'Missing dns parameter' || e.message === 'Invalid content type') {
        return new Response('Bad Request', { status: 400 });
      }

      return new Response('Internal Server Error', { status: 500 });
    }
  },

  /**
   * 定时任务触发器（Cron Trigger）
   * 定时从 GitHub520 拉取最新 hosts 并同步到 KV
   */
  async scheduled(event, env, ctx) {
    if (!env.HOSTS_KV) {
      console.warn('HOSTS_KV not bound, skipping scheduled sync');
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          console.log('Starting GitHub520 sync...');
          const result = await syncHostsToKV(env.HOSTS_KV);
          console.log(`Synced ${result.count} host entries to KV`);
        } catch (e) {
          console.error('Scheduled sync failed:', e);
        }
      })()
    );
  },
};
