/**
 * 内置的自定义 hosts 映射（静态配置）
 * 可直接在此处添加需要自定义解析的域名
 *
 * 格式：{ "域名": "IP地址" }
 * 域名不区分大小写，自动转为小写匹配
 */
export const STATIC_HOSTS = {
  'alive.github.com':                                          '140.82.113.25',
  'api.github.com':                                            '20.205.243.168',
  'api.individual.githubcopilot.com':                          '140.82.114.22',
  'avatars.githubusercontent.com':                             '185.199.110.133',
  'avatars0.githubusercontent.com':                            '185.199.110.133',
  'avatars1.githubusercontent.com':                            '185.199.110.133',
  'avatars2.githubusercontent.com':                            '185.199.110.133',
  'avatars3.githubusercontent.com':                            '185.199.110.133',
  'avatars4.githubusercontent.com':                            '185.199.110.133',
  'avatars5.githubusercontent.com':                            '185.199.110.133',
  'camo.githubusercontent.com':                                '185.199.110.133',
  'central.github.com':                                        '140.82.114.22',
  'cloud.githubusercontent.com':                               '185.199.110.133',
  'codeload.github.com':                                       '20.205.243.165',
  'collector.github.com':                                      '140.82.113.21',
  'desktop.githubusercontent.com':                             '185.199.110.133',
  'favicons.githubusercontent.com':                            '185.199.110.133',
  'gist.github.com':                                           '159.24.3.173',
  'github-cloud.s3.amazonaws.com':                             '52.216.51.241',
  'github-com.s3.amazonaws.com':                               '16.182.102.89',
  'github-production-release-asset-2e65be.s3.amazonaws.com':   '16.182.40.201',
  'github-production-repository-file-5c1aeb.s3.amazonaws.com': '54.231.166.233',
  'github-production-user-asset-6210df.s3.amazonaws.com':      '16.182.38.201',
  'github.blog':                                               '192.0.66.2',
  'github.com':                                                '20.205.243.166',
  'github.community':                                          '140.82.114.18',
  'github.githubassets.com':                                   '185.199.110.215',
  'github.global.ssl.fastly.net':                              '157.240.1.33',
  'github.io':                                                 '185.199.110.153',
  'github.map.fastly.net':                                     '185.199.110.133',
  'githubstatus.com':                                          '185.199.110.153',
  'live.github.com':                                           '140.82.112.25',
  'media.githubusercontent.com':                               '185.199.110.133',
  'objects.githubusercontent.com':                             '185.199.110.133',
  'pipelines.actions.githubusercontent.com':                   '13.107.42.16',
  'raw.githubusercontent.com':                                 '185.199.110.133',
  'user-images.githubusercontent.com':                         '185.199.110.133',
  'vscode.dev':                                                '150.171.110.103',
  'education.github.com':                                      '140.82.112.21',
  'private-user-images.githubusercontent.com':                 '185.199.110.133',
};

/**
 * 查找域名对应的自定义 IP
 * 支持精确匹配和后缀匹配（如 .example.com 匹配所有 *.example.com）
 *
 * @param {string} domain 要查询的域名（自动转小写）
 * @param {object} staticHosts 静态 hosts 映射
 * @param {object} kvHosts KV 中的 hosts 映射（可选）
 * @returns {string|null} 匹配到的 IP，未命中返回 null
 */
export function lookupHost(domain, staticHosts, kvHosts = null) {
  const normalizedDomain = domain.toLowerCase().replace(/\.$/, '');

  // 1. 精确匹配 KV hosts（优先级最高，动态配置可覆盖静态）
  if (kvHosts && kvHosts[normalizedDomain]) {
    return kvHosts[normalizedDomain];
  }

  // 2. 精确匹配静态 hosts
  if (staticHosts[normalizedDomain]) {
    return staticHosts[normalizedDomain];
  }

  // 3. 后缀匹配（通配符）
  // 合并所有规则，KV 优先级高于静态
  const allHosts = { ...staticHosts, ...(kvHosts || {}) };
  let bestMatch = null;
  let bestLength = 0;

  for (const [host, ip] of Object.entries(allHosts)) {
    if (host.startsWith('.')) {
      // 通配符规则：.example.com 匹配 *.example.com
      if (normalizedDomain.endsWith(host)) {
        if (host.length > bestLength) {
          bestMatch = ip;
          bestLength = host.length;
        }
      }
    }
  }

  return bestMatch;
}

// 内存缓存配置
let cachedHosts = null;
let lastCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 缓存有效期 10 分钟

/**
 * 从 KV 中加载 hosts 映射（带内存缓存）
 * 同时加载 GitHub520 同步的 gh_hosts_map 和 Cloudflare 优选 IP 的 cf_hosts_map
 * cf_hosts_map 优先级更高（本地测速结果更精准）
 * @param {KVNamespace} kv KV 命名空间
 * @returns {Promise<object>} hosts 映射对象
 */
export async function loadHostsFromKV(kv) {
  if (!kv) return {};

  // 检查缓存是否有效
  const now = Date.now();
  if (cachedHosts && now - lastCacheTime < CACHE_TTL) {
    return cachedHosts;
  }

  try {
    // 并行加载两个 KV key
    const [githubHosts, cfHosts] = await Promise.all([
      kv.get('gh_hosts_map', { type: 'json' }),
      kv.get('cf_hosts_map', { type: 'json' }),
    ]);
    // 合并，cf_hosts 优先级更高（后面的覆盖前面的）
    const hosts = { ...(githubHosts || {}), ...(cfHosts || {}) };

    // 更新缓存
    cachedHosts = hosts;
    lastCacheTime = now;

    return hosts;
  } catch (e) {
    console.warn('Failed to load hosts from KV:', e);
    // 加载失败时降级返回缓存数据
    return cachedHosts || {};
  }
}
