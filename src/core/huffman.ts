export interface FreqEntry {
  byte: number;
  freq: number;
}

export interface CodeEntry {
  byte: number;
  freq: number;
  length: number;
  code: number;
  codeText: string;
}

export function countFrequencies(data: Uint8Array): FreqEntry[] {
  const counts = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    counts[byte] = counts[byte]! + 1;
  }
  const result: FreqEntry[] = [];
  for (let b = 0; b < 256; b++) {
    const value = counts[b]!;
    if (value > 0) result.push({ byte: b, freq: value });
  }
  return result;
}

interface Node {
  weight: number;
  minSymbol: number;
  leaf: number | null;
  left: Node | null;
  right: Node | null;
}

export function codeLengths(freq: FreqEntry[]): Map<number, number> {
  if (freq.length === 0) return new Map();
  if (freq.length === 1) {
    return new Map([[freq[0]!.byte, 1]]);
  }
  const queue: Node[] = freq
    .map((f) => ({
      weight: f.freq,
      minSymbol: f.byte,
      leaf: f.byte,
      left: null,
      right: null,
    }))
    .sort((a, b) => a.weight - b.weight || a.minSymbol - b.minSymbol);

  let head = 0;
  const combined: Node[] = [];
  let cHead = 0;

  const takeMin = (): Node => {
    if (head >= queue.length) return combined[cHead++]!;
    if (cHead >= combined.length) return queue[head++]!;
    const a = queue[head]!;
    const b = combined[cHead]!;
    if (a.weight < b.weight || (a.weight === b.weight && a.minSymbol < b.minSymbol)) {
      head++;
      return a;
    }
    cHead++;
    return b;
  };

  const leafCount = queue.length;
  for (let i = 0; i < leafCount - 1; i++) {
    const left = takeMin();
    const right = takeMin();
    const parent: Node = {
      weight: left.weight + right.weight,
      minSymbol: Math.min(left.minSymbol, right.minSymbol),
      leaf: null,
      left,
      right,
    };
    combined.push(parent);
  }
  const root = takeMin();

  const lengths = new Map<number, number>();
  const walk = (node: Node, depth: number): void => {
    if (node.leaf !== null) {
      lengths.set(node.leaf, depth);
      return;
    }
    walk(node.left!, depth + 1);
    walk(node.right!, depth + 1);
  };
  walk(root, 0);
  return lengths;
}

export interface CanonicalCode {
  byte: number;
  length: number;
  code: number;
}

export function canonicalCodes(lengths: Map<number, number>): CanonicalCode[] {
  const entries = [...lengths.entries()]
    .map(([byte, length]) => ({ byte, length }))
    .sort((a, b) => a.length - b.length || a.byte - b.byte);
  if (entries.length === 0) return [];
  const result: CanonicalCode[] = [];
  let code = 0;
  let prevLen = entries[0]!.length;
  for (const entry of entries) {
    if (entry.length !== prevLen) {
      code = code << (entry.length - prevLen);
      prevLen = entry.length;
    }
    result.push({ byte: entry.byte, length: entry.length, code });
    code++;
  }
  return result;
}

export function canonicalShapeValid(lengths: number[]): boolean {
  if (lengths.length === 0) return true;
  const sorted = [...lengths].sort((a, b) => a - b);
  let code = 0;
  let prev = sorted[0]!;
  for (const len of sorted) {
    if (len < prev) return false;
    code = code << (len - prev);
    prev = len;
    if (code >= (len >= 32 ? 0x100000000 : 1 << len)) return false;
    code++;
  }
  return true;
}

export function buildCodeTable(freq: FreqEntry[]): CodeEntry[] {
  const lengths = codeLengths(freq);
  const canon = canonicalCodes(lengths);
  const freqByByte = new Map(freq.map((f) => [f.byte, f.freq]));
  return canon.map((c) => ({
    byte: c.byte,
    freq: freqByByte.get(c.byte)!,
    length: c.length,
    code: c.code,
    codeText: c.code.toString(2).padStart(c.length, '0'),
  }));
}

export interface TrieNode {
  child: [TrieNode | null, TrieNode | null];
  symbol: number | null;
}

export function buildDecodeTrie(codes: CanonicalCode[]): TrieNode {
  const root: TrieNode = { child: [null, null], symbol: null };
  for (const c of codes) {
    let node = root;
    for (let i = c.length - 1; i >= 0; i--) {
      const bit = (c.code >>> i) & 1;
      let next = node.child[bit];
      if (!next) {
        next = { child: [null, null], symbol: null };
        node.child[bit] = next;
      }
      node = next;
    }
    node.symbol = c.byte;
  }
  return root;
}

export function validatePrefixCodes(codes: CanonicalCode[]): boolean {
  for (const c of codes) {
    if (c.length < 1 || c.length > 32) return false;
    const maxCode = c.length === 32 ? 0xffffffff : (1 << c.length) - 1;
    if (c.code < 0 || c.code > maxCode) return false;
  }
  const sorted = [...codes].sort((a, b) => a.length - b.length || a.code - b.code);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.length > b.length) break;
      const shift = b.length - a.length;
      if ((b.code >>> shift) === a.code) return false;
      if (a.length === b.length && a.code === b.code) return false;
    }
  }
  return true;
}

export function encodeSymbols(data: Uint8Array, table: CodeEntry[]): { bits: number; bytes: Uint8Array } {
  const byByte = new Map<number, CodeEntry>();
  for (const e of table) byByte.set(e.byte, e);
  let bitCount = 0;
  for (const e of table) bitCount += e.freq * e.length;
  const out = new Uint8Array(Math.ceil(bitCount / 8));
  let bytePos = 0;
  let bitPos = 0;
  for (let i = 0; i < data.length; i++) {
    const entry = byByte.get(data[i]!);
    if (!entry) throw new Error('符号缺少码字');
    for (let k = entry.length - 1; k >= 0; k--) {
      const bit = (entry.code >>> k) & 1;
      if (bit) out[bytePos]! |= 1 << (7 - bitPos);
      bitPos++;
      if (bitPos === 8) {
        bitPos = 0;
        bytePos++;
      }
    }
  }
  return { bits: bitCount, bytes: out };
}
