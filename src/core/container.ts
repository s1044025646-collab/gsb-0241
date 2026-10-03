import { createHash } from 'node:crypto';
import {
  type CanonicalCode,
  type CodeEntry,
  buildCodeTable,
  buildDecodeTrie,
  canonicalShapeValid,
  canonicalCodes,
  codeLengths,
  countFrequencies,
  encodeSymbols,
  validatePrefixCodes,
  type TrieNode,
} from './huffman.js';
import { HfError } from './errors.js';

export const MAGIC = Buffer.from('HF1\x01', 'ascii');
export const FORMAT_VERSION = 1;
export const MAX_SYMBOLS = 256;
export const MAX_CODE_LENGTH = 32;
export const DEFAULT_MAX_OUTPUT = 1024 * 1024 * 256;

export interface CompressStats {
  originalSize: number;
  symbolCount: number;
  payloadBits: number;
  payloadBytes: number;
  padBits: number;
  headerBytes: number;
  fileSize: number;
  inputSha256: string;
  entropyBitsPerByte: number;
  avgCodeLength: number;
  sizeDelta: number;
  ratioPercent: number;
  savedBytes: number;
}

export interface ParsedHeader {
  originalSize: number;
  payloadBits: number;
  symbolCount: number;
  symbols: Uint8Array;
  codes: CanonicalCode[];
  sha256: string;
  headerLength: number;
}

const writeU32 = (buf: Buffer, offset: number, value: number): void => {
  buf.writeUInt32BE(value >>> 0, offset);
};

const readU32 = (buf: Buffer, offset: number): number => buf.readUInt32BE(offset);

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function compress(input: Uint8Array): { file: Buffer; table: CodeEntry[]; stats: CompressStats } {
  const freq = countFrequencies(input);
  const table = buildCodeTable(freq);
  const encoded = encodeSymbols(input, table);
  const payloadBytes = encoded.bytes.length;
  const padBits = payloadBytes === 0 ? 0 : (8 - (encoded.bits % 8)) % 8;

  const symbolCount = table.length;
  const codeSectionLength = symbolCount * 5;
  const headerLength = MAGIC.length + 4 + 4 + 4 + 2 + codeSectionLength + 32;
  const file = Buffer.alloc(headerLength + payloadBytes);

  let p = 0;
  MAGIC.copy(file, p);
  p += MAGIC.length;
  writeU32(file, p, input.length);
  p += 4;
  writeU32(file, p, encoded.bits);
  p += 4;
  writeU32(file, p, symbolCount);
  p += 4;
  file.writeUInt16BE(codeSectionLength, p);
  p += 2;
  for (const e of table) {
    file[p] = e.byte;
    p += 1;
    writeU32(file, p, e.length);
    p += 4;
  }
  file.set(Buffer.from(sha256Hex(input), 'hex'), p);
  p += 32;
  file.set(encoded.bytes, p);

  const total = input.length;
  let entropy = 0;
  if (total > 0) {
    for (const e of table) {
      const pr = e.freq / total;
      entropy -= pr * Math.log2(pr);
    }
  }
  const avgCodeLength = total > 0 ? encoded.bits / total : 0;

  const stats: CompressStats = {
    originalSize: input.length,
    symbolCount,
    payloadBits: encoded.bits,
    payloadBytes,
    padBits,
    headerBytes: headerLength,
    fileSize: file.length,
    inputSha256: sha256Hex(input),
    entropyBitsPerByte: entropy,
    avgCodeLength,
    sizeDelta: file.length - input.length,
    ratioPercent: input.length === 0 ? 0 : (file.length / input.length) * 100,
    savedBytes: input.length - file.length,
  };
  return { file, table, stats };
}

export function parseHeader(buf: Buffer): ParsedHeader {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new HfError('BAD_HEADER_MAGIC', '魔数错误，不是 HF1 容器');
  }
  const version = buf[3]!;
  if (version !== FORMAT_VERSION) {
    throw new HfError('BAD_HEADER_VERSION', `不支持的容器版本: ${version}`);
  }
  const minFixed = MAGIC.length + 4 + 4 + 4 + 2;
  if (buf.length < minFixed) {
    throw new HfError('TRUNCATED_HEADER', '头部固定字段被截断');
  }
  let p = MAGIC.length;
  const originalSize = readU32(buf, p);
  p += 4;
  const payloadBits = readU32(buf, p);
  p += 4;
  const symbolCount = readU32(buf, p);
  p += 4;
  const codeSectionLength = buf.readUInt16BE(p);
  p += 2;

  if (symbolCount > MAX_SYMBOLS) {
    throw new HfError('BAD_CODETABLE', `码表符号数超出上限: ${symbolCount}`);
  }
  if (codeSectionLength !== symbolCount * 5) {
    throw new HfError('TRUNCATED_HEADER', '码表段长度与符号数不一致');
  }
  const headerLength = minFixed + codeSectionLength + 32;
  if (buf.length < headerLength) {
    throw new HfError('TRUNCATED_HEADER', '码表或校验和被截断');
  }

  const symbols = new Uint8Array(symbolCount);
  const codes: CanonicalCode[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < symbolCount; i++) {
    const byte = buf[p]!;
    p += 1;
    const length = readU32(buf, p);
    p += 4;
    if (length < 1 || length > MAX_CODE_LENGTH) {
      throw new HfError('BAD_CODETABLE', `码长越界: 字节 ${byte} 码长 ${length}`);
    }
    if (seen.has(byte)) {
      throw new HfError('BAD_CODETABLE', `码表存在重复字节: ${byte}`);
    }
    seen.add(byte);
    symbols[i] = byte;
    codes.push({ byte, length, code: 0 });
  }

  if (
    (originalSize === 0 && symbolCount !== 0) ||
    (originalSize > 0 && (symbolCount === 0 || payloadBits === 0))
  ) {
    throw new HfError('BAD_CODETABLE', '原始长度、符号数与载荷位数不一致');
  }

  const expectedPayloadBytes = Math.ceil(payloadBits / 8);
  if (buf.length < headerLength + expectedPayloadBytes) {
    throw new HfError('TRUNCATED_PAYLOAD', '载荷字节数少于有效位数声明');
  }

  const sha256 = buf.subarray(p, p + 32).toString('hex');
  p += 32;

  return {
    originalSize,
    payloadBits,
    symbolCount,
    symbols,
    codes,
    sha256,
    headerLength,
  };
}

function reconstructCanonical(
  header: ParsedHeader,
): { codes: CanonicalCode[]; entries: CodeEntry[] } {
  if (header.symbolCount === 0) return { codes: [], entries: [] };
  const lengths = new Map<number, number>();
  for (const c of header.codes) lengths.set(c.byte, c.length);
  const canon = canonicalCodes(lengths);
  const entries: CodeEntry[] = canon.map((c) => ({
    byte: c.byte,
    freq: 0,
    length: c.length,
    code: c.code,
    codeText: c.code.toString(2).padStart(c.length, '0'),
  }));
  return { codes: canon, entries };
}

function decodeBits(payload: Buffer, payloadBits: number, trie: TrieNode, expectedSize: number, maxOutput: number): Uint8Array {
  const out = new Uint8Array(Math.min(expectedSize, maxOutput) + 8);
  let count = 0;
  let node: TrieNode = trie;
  for (let bitIndex = 0; bitIndex < payloadBits; bitIndex++) {
    const byteIndex = bitIndex >>> 3;
    const bit = (payload[byteIndex]! >>> (7 - (bitIndex & 7))) & 1;
    const next = node.child[bit];
    if (!next) {
      throw new HfError('BAD_PAYLOAD', `位 ${bitIndex} 处出现码表外码字`);
    }
    node = next;
    if (node.symbol !== null) {
      if (count >= expectedSize) {
        throw new HfError('LENGTH_MISMATCH', '解码符号数超过声明的原始长度');
      }
      if (count >= maxOutput) {
        throw new HfError('OUTPUT_TOO_LARGE', `解码结果超过输出上限 ${maxOutput} 字节`);
      }
      out[count] = node.symbol;
      count++;
      node = trie;
    }
  }
  if (node !== trie) {
    throw new HfError('BAD_PAYLOAD', '载荷在码字中间结束（存在悬空位）');
  }
  if (count !== expectedSize) {
    throw new HfError('LENGTH_MISMATCH', `解码长度 ${count} 与声明 ${expectedSize} 不一致`);
  }
  return out.subarray(0, count);
}

export interface DecompressResult {
  data: Uint8Array;
  header: ParsedHeader;
  table: CodeEntry[];
  padBits: number;
}

export function decompress(file: Uint8Array, options?: { maxOutput?: number; verifyChecksum?: boolean }): DecompressResult {
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file);
  const maxOutput = options?.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const verifyChecksum = options?.verifyChecksum ?? true;
  const header = parseHeader(buf);

  if (header.payloadBits % 1 !== 0 || header.payloadBits > 0xffffffff) {
    throw new HfError('BAD_PAD_BITS', '有效位数非法');
  }
  const payloadByteCount = Math.ceil(header.payloadBits / 8);
  const expectedFileLength = header.headerLength + payloadByteCount;
  if (buf.length < expectedFileLength) {
    throw new HfError('TRUNCATED_PAYLOAD', '载荷被截断');
  }
  const padBits = payloadByteCount === 0 ? 0 : (8 - (header.payloadBits % 8)) % 8;
  if (payloadByteCount > 0 && padBits > 0) {
    const last = buf[header.headerLength + payloadByteCount - 1]!;
    const padMask = (1 << padBits) - 1;
    if ((last & padMask) !== 0) {
      throw new HfError('BAD_PAD_BITS', `最后一个字节的 ${padBits} 个填充位必须为 0`);
    }
  }

  let data: Uint8Array;
  let table: CodeEntry[] = [];
  if (header.originalSize === 0) {
    if (header.symbolCount !== 0 || header.payloadBits !== 0) {
      throw new HfError('BAD_CODETABLE', '空输入必须使用空码表与零位载荷');
    }
    data = new Uint8Array(0);
  } else {
    if (!canonicalShapeValid(header.codes.map((c) => c.length))) {
      throw new HfError('BAD_CODETABLE', '码长组合不满足 Kraft 不等式，无法构成合法 Huffman 码');
    }
    const { codes, entries } = reconstructCanonical(header);
    if (!validatePrefixCodes(codes)) {
      throw new HfError('BAD_CODETABLE', '码表不满足前缀性质或码值越界');
    }
    if (header.symbolCount === 1 && header.payloadBits !== header.originalSize) {
      throw new HfError('BAD_CODETABLE', '单符号输入有效位数必须等于原始字节数');
    }
    table = entries;
    const trie = buildDecodeTrie(codes);
    const payload = buf.subarray(header.headerLength, expectedFileLength);
    data = decodeBits(payload, header.payloadBits, trie, header.originalSize, maxOutput);
  }

  if (data.length > maxOutput) {
    throw new HfError('OUTPUT_TOO_LARGE', `输出超过上限 ${maxOutput} 字节`);
  }
  if (verifyChecksum) {
    const actual = sha256Hex(data);
    if (actual !== header.sha256) {
      throw new HfError('CHECKSUM_MISMATCH', '解码结果 SHA-256 与容器内声明不一致（数据已损坏）');
    }
  }
  return { data, header, table, padBits };
}

export interface VerifyResult {
  ok: boolean;
  originalSize: number;
  fileSize: number;
  payloadBits: number;
  headerBytes: number;
  padBits: number;
  symbolCount: number;
  inputSha256: string;
  checksumMatches: boolean;
}

export function verify(file: Uint8Array, options?: { maxOutput?: number }): VerifyResult {
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file);
  const result = decompress(buf, { maxOutput: options?.maxOutput ?? DEFAULT_MAX_OUTPUT });
  return {
    ok: true,
    originalSize: result.header.originalSize,
    fileSize: buf.length,
    payloadBits: result.header.payloadBits,
    headerBytes: result.header.headerLength,
    padBits: result.padBits,
    symbolCount: result.header.symbolCount,
    inputSha256: result.header.sha256,
    checksumMatches: sha256Hex(result.data) === result.header.sha256,
  };
}
