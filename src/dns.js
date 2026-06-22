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
 * 读取 16 位无符号整数
 */
function readUInt16BE(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

/**
 * 写入 16 位无符号整数
 */
function writeUInt16BE(buffer, offset, value) {
  buffer[offset] = (value >> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

/**
 * 写入 32 位无符号整数
 */
function writeUInt32BE(buffer, offset, value) {
  buffer[offset] = (value >> 24) & 0xff;
  buffer[offset + 1] = (value >> 16) & 0xff;
  buffer[offset + 2] = (value >> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

/**
 * 解析 DNS 报文中的域名（支持压缩指针）
 * @param {Uint8Array} buffer
 * @param {number} offset
 * @returns {{ name: string, offset: number }}
 */
function parseDomainName(buffer, offset) {
  const labels = [];
  let jumped = false;
  let originalOffset = offset;
  let maxJumps = 10; // 防止无限循环

  while (maxJumps-- > 0) {
    if (offset >= buffer.length) {
      throw new Error('DNS packet out of bounds');
    }

    const length = buffer[offset];

    // 域名结束
    if (length === 0) {
      offset++;
      break;
    }

    // 压缩指针（最高两位是 11）
    if ((length & 0xc0) === 0xc0) {
      if (!jumped) {
        originalOffset = offset + 2;
        jumped = true;
      }
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      offset = pointer;
      continue;
    }

    // 普通标签
    if (length > 63) {
      throw new Error('Invalid DNS label length');
    }

    offset++;
    const label = String.fromCharCode(...buffer.slice(offset, offset + length));
    labels.push(label);
    offset += length;
  }

  return {
    name: labels.join('.'),
    offset: jumped ? originalOffset : offset,
  };
}

/**
 * 解析 DNS 查询报文
 * @param {Uint8Array} buffer
 * @returns {object} 解析后的 DNS 查询对象
 */
export function decodeDnsQuery(buffer) {
  if (buffer.length < 12) {
    throw new Error('Invalid DNS query: too short');
  }

  const id = readUInt16BE(buffer, 0);
  const flags = readUInt16BE(buffer, 2);
  const qdcount = readUInt16BE(buffer, 4);

  const questions = [];
  let offset = 12;

  for (let i = 0; i < qdcount; i++) {
    const { name, offset: newOffset } = parseDomainName(buffer, offset);
    offset = newOffset;

    const type = readUInt16BE(buffer, offset);
    const qclass = readUInt16BE(buffer, offset + 2);
    offset += 4;

    // 类型编号转名称（只处理我们需要的 A 记录）
    let typeName = 'UNKNOWN';
    if (type === 1) typeName = 'A';
    else if (type === 28) typeName = 'AAAA';
    else if (type === 5) typeName = 'CNAME';

    questions.push({
      name: name.toLowerCase(),
      type: typeName,
      class: qclass === 1 ? 'IN' : String(qclass),
    });
  }

  return {
    id,
    type: (flags & 0x8000) ? 'response' : 'query',
    flags,
    questions,
  };
}

/**
 * 将域名编码为 DNS QNAME 格式
 * @param {string} domain
 * @returns {Uint8Array}
 */
function encodeDomainName(domain) {
  const labels = domain.split('.');
  const parts = [];

  for (const label of labels) {
    if (label.length > 63) {
      throw new Error('Label too long');
    }
    parts.push(label.length);
    for (let i = 0; i < label.length; i++) {
      parts.push(label.charCodeAt(i));
    }
  }
  parts.push(0); // 结束

  return new Uint8Array(parts);
}

/**
 * 将 IP 地址字符串转换为 4 字节
 * @param {string} ip
 * @returns {Uint8Array}
 */
function ipToBytes(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error('Invalid IP address');
  }
  return new Uint8Array(parts);
}

/**
 * 构造自定义 A 记录 DNS 响应
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

  const qname = encodeDomainName(question.name);
  const ipBytes = ipToBytes(ip);

  // 计算总长度
  // Header: 12
  // Question: qname.length + 4 (type + class)
  // Answer: 2 (name pointer) + 2 (type) + 2 (class) + 4 (ttl) + 2 (rdlength) + 4 (ip)
  const totalLength = 12 + qname.length + 4 + 2 + 2 + 2 + 4 + 2 + 4;
  const buffer = new Uint8Array(totalLength);
  let offset = 0;

  // Header
  writeUInt16BE(buffer, offset, query.id); offset += 2;
  // Flags: QR=1, OPCODE=0, AA=1, TC=0, RD=1, RA=1, Z=0, RCODE=0
  // 0x8400 = 1000 0100 0000 0000
  // 加上 RD 位（查询里的 RD 位）
  const rdFlag = query.flags & 0x0100; // 保留查询中的 RD 位
  const flags = 0x8000 | 0x0400 | rdFlag | 0x0080; // QR | AA | RD | RA
  writeUInt16BE(buffer, offset, flags); offset += 2;
  writeUInt16BE(buffer, offset, 1); offset += 2; // QDCOUNT
  writeUInt16BE(buffer, offset, 1); offset += 2; // ANCOUNT
  writeUInt16BE(buffer, offset, 0); offset += 2; // NSCOUNT
  writeUInt16BE(buffer, offset, 0); offset += 2; // ARCOUNT

  // Question
  buffer.set(qname, offset); offset += qname.length;
  writeUInt16BE(buffer, offset, 1); offset += 2; // TYPE A
  writeUInt16BE(buffer, offset, 1); offset += 2; // CLASS IN

  // Answer
  // Name: 压缩指针，指向第 12 字节（0x0c）
  writeUInt16BE(buffer, offset, 0xc00c); offset += 2;
  writeUInt16BE(buffer, offset, 1); offset += 2; // TYPE A
  writeUInt16BE(buffer, offset, 1); offset += 2; // CLASS IN
  writeUInt32BE(buffer, offset, ttl); offset += 4; // TTL
  writeUInt16BE(buffer, offset, 4); offset += 2; // RDLENGTH
  buffer.set(ipBytes, offset); offset += 4; // IP

  return buffer;
}

/**
 * 构造 NXDOMAIN 响应（域名不存在）
 * @param {object} query
 * @returns {Uint8Array}
 */
export function buildNxDomainResponse(query) {
  const question = query.questions?.[0];
  if (!question) {
    throw new Error('No question in DNS query');
  }

  const qname = encodeDomainName(question.name);
  const totalLength = 12 + qname.length + 4;
  const buffer = new Uint8Array(totalLength);
  let offset = 0;

  // Header
  writeUInt16BE(buffer, offset, query.id); offset += 2;
  // Flags: QR=1, RA=1, RCODE=3 (NXDOMAIN)
  const rdFlag = query.flags & 0x0100;
  const flags = 0x8000 | rdFlag | 0x0080 | 0x0003;
  writeUInt16BE(buffer, offset, flags); offset += 2;
  writeUInt16BE(buffer, offset, 1); offset += 2; // QDCOUNT
  writeUInt16BE(buffer, offset, 0); offset += 2; // ANCOUNT
  writeUInt16BE(buffer, offset, 0); offset += 2; // NSCOUNT
  writeUInt16BE(buffer, offset, 0); offset += 2; // ARCOUNT

  // Question
  buffer.set(qname, offset); offset += qname.length;
  writeUInt16BE(buffer, offset, 1); offset += 2; // TYPE A
  writeUInt16BE(buffer, offset, 1); offset += 2; // CLASS IN

  return buffer;
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
