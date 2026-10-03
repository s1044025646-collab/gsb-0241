/** 字节级 Huffman 核心：频率统计、确定性建树、规范码字分配、位级编解码。 */

export interface CodeInfo { symbol: number; length: number; code: string; }

/** 统计 0..255 字节频率。 */
export function byteFrequencies(data: Buffer): Uint32Array {
  const freq = new Uint32Array(256);
  for (const b of data) freq[b]++;
  return freq;
}

interface Node { freq: number; minSym: number; symbol: number; left: Node | null; right: Node | null; }

/**
 * 由频率表构造 Huffman 码长（0 表示未使用）。
 * 平局规则（公开且确定）：频率小者优先；频率相同则子树内最小符号小者优先；
 * 再相同则先创建的节点优先。单符号时码长为 1。空输入全部为 0。
 */
export function buildCodeLengths(freq: Uint32Array): Uint8Array {
  const lengths = new Uint8Array(256);
  const nodes: Node[] = [];
  for (let s = 0; s < 256; s++) {
    if (freq[s] > 0) nodes.push({ freq: freq[s], minSym: s, symbol: s, left: null, right: null });
  }
  if (nodes.length === 0) return lengths;
  if (nodes.length === 1) { lengths[nodes[0].symbol] = 1; return lengths; }
  let counter = 0;
  const order = new Map<Node, number>();
  const pool: Node[] = nodes.map(n => { order.set(n, counter++); return n; });
  const cmp = (a: Node, b: Node) =>
    a.freq - b.freq || a.minSym - b.minSym || (order.get(a)! - order.get(b)!);
  while (pool.length > 1) {
    pool.sort(cmp);
    const a = pool.shift()!, b = pool.shift()!;
    const parent: Node = {
      freq: a.freq + b.freq,
      minSym: Math.min(a.minSym, b.minSym),
      symbol: -1, left: a, right: b,
    };
    order.set(parent, counter++);
    pool.push(parent);
  }
  const walk = (n: Node, depth: number) => {
    if (n.symbol >= 0) { lengths[n.symbol] = depth; return; }
    walk(n.left!, depth + 1);
    walk(n.right!, depth + 1);
  };
  walk(pool[0], 0);
  return lengths;
}

/**
 * 由码长表分配规范码字：按 (码长, 符号) 升序依次分配递增码字。
 * 满足前缀性质；同一码长表必得同一码字表。
 */
export function assignCanonicalCodes(lengths: Uint8Array): Map<number, { code: number; length: number }> {
  const map = new Map<number, { code: number; length: number }>();
  const entries: Array<[number, number]> = [];
  for (let s = 0; s < 256; s++) if (lengths[s] > 0) entries.push([lengths[s], s]);
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let code = 0, prevLen = 0;
  for (const [len, sym] of entries) {
    code <<= (len - prevLen);
    prevLen = len;
    map.set(sym, { code, length: len });
    code++;
  }
  return map;
}

export function codesToStrings(lengths: Uint8Array): CodeInfo[] {
  const map = assignCanonicalCodes(lengths);
  const out: CodeInfo[] = [];
  for (const [sym, { code, length }] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    out.push({ symbol: sym, length, code: code.toString(2).padStart(length, '0') });
  }
  return out;
}

/** 位流编码：MSB 优先写入；最后一个字节不足 8 位时低位补 0。返回 {payload, bitLength}。 */
export function encodeBits(data: Buffer, lengths: Uint8Array): { payload: Buffer; bitLength: number } {
  const codes = assignCanonicalCodes(lengths);
  const bytes: number[] = [];
  let cur = 0, nbits = 0, total = 0;
  for (const b of data) {
    const c = codes.get(b)!;
    for (let i = c.length - 1; i >= 0; i--) {
      cur = (cur << 1) | ((c.code >> i) & 1);
      nbits++; total++;
      if (nbits === 8) { bytes.push(cur); cur = 0; nbits = 0; }
    }
  }
  if (nbits > 0) bytes.push(cur << (8 - nbits));
  return { payload: Buffer.from(bytes), bitLength: total };
}

/** 位流解码：按码长表重建规范码，逐位匹配，恰好解出 origLen 字节并消费 payloadBits 位。 */
export function decodeBits(payload: Buffer, bitLength: number, lengths: Uint8Array, origLen: number): Buffer {
  if (origLen === 0) {
    if (bitLength !== 0) throw new Error('EMPTY_INPUT_BITS_NONZERO');
    return Buffer.alloc(0);
  }
  if (payload.length * 8 < bitLength) throw new Error('TRUNCATED_PAYLOAD');
  if (payload.length * 8 - bitLength > 7) throw new Error('PADDING_BITS_INVALID');
  const used = [];
  for (let s = 0; s < 256; s++) if (lengths[s] > 0) used.push(s);
  if (used.length === 0) throw new Error('BAD_CODE_TABLE');
  // Kraft 校验，保证前缀性质可行
  let kraft = 0;
  for (const s of used) kraft += 2 ** -lengths[s];
  if (used.length > 1 && Math.abs(kraft - 1) > 1e-9) throw new Error('BAD_CODE_TABLE');
  if (used.length === 1 && lengths[used[0]] !== 1) throw new Error('BAD_CODE_TABLE');

  const codes = codesToStrings(lengths);
  const byCode = new Map<string, number>();
  for (const c of codes) byCode.set(c.code, c.symbol);

  const out = Buffer.alloc(origLen);
  let cur = '', pos = 0, written = 0;
  for (let i = 0; i < bitLength; i++) {
    const byte = payload[i >> 3];
    const bit = (byte >> (7 - (i & 7))) & 1;
    cur += bit ? '1' : '0';
    const sym = byCode.get(cur);
    if (sym !== undefined) {
      if (written >= origLen) throw new Error('LENGTH_OVERRUN');
      out[written++] = sym;
      cur = '';
    }
    pos = i + 1;
    if (written === origLen) {
      if (pos !== bitLength) throw new Error('TRAILING_BITS');
      return out;
    }
  }
  throw new Error('TRUNCATED_PAYLOAD');
}
