import dnsPacket from 'dns-packet';

/**
 * 从 HTTP 请求中提取 DNS 查询报文
 * @param {Request} request
 * @returns {Promise<Uint8Array>} DNS 查询报文
 */
export async function extractDnsQuery(request) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const dnsParam = url.searchParams.get('dns');
    if (!dnsParam) {
      throw new Error('Missing dns parameter');
    }
    // RFC 8484: base64url 编码，需要转换为标准 base64
    const base64 = dnsParam.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type');
    if (contentType !== 'application/dns-message') {
      throw new Error('Invalid content type');
    }
    return new Uint8Array(await request.arrayBuffer());
  }

  throw new Error('Method not allowed');
}

/**
 * 解析 DNS 查询报文
 * @param {Uint8Array} buffer
 * @returns {object} 解析后的 DNS 查询对象
 */
export function decodeDnsQuery(buffer) {
  try {
    return dnsPacket.decode(buffer);
  } catch (e) {
    throw new Error('Invalid DNS query');
  }
}

/**
 * 构造自定义 DNS 响应
 * @param {object} query 原始 DNS 查询
 * @param {string} ip 要返回的 IP 地址
 * @param {number} ttl TTL 秒数
 * @returns {Uint8Array} DNS 响应报文
 */
export function buildAResponse(query, ip, ttl = 300) {
  const question = query.questions?.[0];
  if (!question) {
    throw new Error('No question in DNS query');
  }

  const response = {
    id: query.id,
    type: 'response',
    flags:
      dnsPacket.RECURSION_DESIRED |
      dnsPacket.RECURSION_AVAILABLE |
      dnsPacket.AUTHORITATIVE_ANSWER,
    questions: query.questions,
    answers: [
      {
        type: 'A',
        class: 'IN',
        name: question.name,
        ttl: ttl,
        data: ip,
      },
    ],
  };

  return dnsPacket.encode(response);
}

/**
 * 构造 NXDOMAIN 响应（域名不存在）
 * @param {object} query
 * @returns {Uint8Array}
 */
export function buildNxDomainResponse(query) {
  const response = {
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: query.questions,
    answers: [],
  };
  // 设置 RCODE = 3 (NXDOMAIN)
  response.flags |= 3;
  return dnsPacket.encode(response);
}

/**
 * 转发 DNS 查询到上游 DoH 服务器
 * @param {Uint8Array} queryBuffer DNS 查询报文
 * @param {string} upstreamUrl 上游 DoH 地址
 * @param {string} method 请求方法
 * @returns {Promise<Uint8Array>} DNS 响应报文
 */
export async function forwardToUpstream(queryBuffer, upstreamUrl, method = 'POST') {
  const response = await fetch(upstreamUrl, {
    method: method,
    headers: {
      'Content-Type': 'application/dns-message',
      Accept: 'application/dns-message',
    },
    body: method === 'POST' ? queryBuffer : undefined,
  });

  if (!response.ok) {
    throw new Error(`Upstream error: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}
