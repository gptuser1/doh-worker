/**
 * 从 GitHub520 同步最新 hosts 到本地配置文件
 *
 * 用法：
 *   node scripts/sync-hosts.js           # 同步并更新 src/hosts.js 中的 STATIC_HOSTS
 *   node scripts/sync-hosts.js --json    # 仅输出 JSON 格式
 *   node scripts/sync-hosts.js --kv      # 输出 KV 兼容格式
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GITHUB520_URL = 'https://raw.githubusercontent.com/521xueweihan/GitHub520/main/hosts.json';
const HOSTS_FILE = path.resolve(__dirname, '../src/hosts.js');

/**
 * 从 URL 获取 JSON 内容
 * @param {string} url
 * @returns {Promise<object>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理重定向
          fetchJson(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * 解析 GitHub520 JSON 格式为 hosts 映射
 * 支持三种格式：
 * 1. 对象格式：{ "github.com": "1.2.3.4" }
 * 2. 对象数组：[{ "name": "github.com", "ip": "1.2.3.4" }]
 * 3. 二维数组：[ ["1.2.3.4", "github.com"] ]
 * @param {object|Array} data
 * @returns {object} { domain: ip }
 */
function parseHosts(data) {
  const hosts = {};

  if (Array.isArray(data)) {
    for (const item of data) {
      let domain, ip;

      if (Array.isArray(item)) {
        // 二维数组格式：[ip, domain]
        ip = item[0];
        domain = item[1];
      } else {
        // 对象数组格式
        domain = item.name || item.domain || item.host;
        ip = item.ip || item.address || item.value;
      }

      if (domain && ip) {
        hosts[domain.toLowerCase()] = ip;
      }
    }
  } else {
    for (const [domain, ip] of Object.entries(data)) {
      hosts[domain.toLowerCase()] = ip;
    }
  }

  return hosts;
}

/**
 * 更新 src/hosts.js 中的 STATIC_HOSTS
 * @param {object} hosts
 */
function updateStaticHostsFile(hosts) {
  const originalContent = fs.readFileSync(HOSTS_FILE, 'utf-8');

  // 生成新的 STATIC_HOSTS 对象内容
  const entries = Object.entries(hosts);
  const maxDomainLen = Math.max(...entries.map(([d]) => d.length));

  const hostsObjStr = entries
    .map(([domain, ip]) => {
      const padding = ' '.repeat(maxDomainLen - domain.length + 1);
      return `  '${domain}':${padding}'${ip}',`;
    })
    .join('\n');

  // 替换 STATIC_HOSTS 块
  const newContent = originalContent.replace(
    /export const STATIC_HOSTS = \{[\s\S]*?\};/,
    `export const STATIC_HOSTS = {\n${hostsObjStr}\n};`
  );

  fs.writeFileSync(HOSTS_FILE, newContent, 'utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  const outputJson = args.includes('--json');
  const outputKv = args.includes('--kv');

  console.log(`Fetching hosts from ${GITHUB520_URL}...`);

  try {
    const data = await fetchJson(GITHUB520_URL);
    const hosts = parseHosts(data);

    console.log(`Parsed ${Object.keys(hosts).length} host entries`);

    if (outputJson) {
      console.log('\nJSON output:');
      console.log(JSON.stringify(hosts, null, 2));
      return;
    }

    if (outputKv) {
      console.log('\nKV format (key: hosts_map):');
      console.log(JSON.stringify(hosts));
      return;
    }

    // 默认：更新静态配置文件
    updateStaticHostsFile(hosts);
    console.log(`\nUpdated ${HOSTS_FILE}`);
    console.log('Run `wrangler deploy` to push changes to Cloudflare');
  } catch (e) {
    console.error('Failed to sync hosts:', e.message);
    process.exit(1);
  }
}

main();
