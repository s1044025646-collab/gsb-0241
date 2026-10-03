/** HUF1 容器格式（自定义，不兼容 ZIP/gzip 等任何标准格式）。
 * 布局（全部小端）：
 *   0..3   魔数 "HUF1"
 *   4      版本 u8 = 1
 *   5      保留 u8 = 0
 *   6..13  原始字节数 u64
 *   14..21 载荷有效位数 u64
 *   22..277 256 字节码长表（0=符号未使用）
 *   278..  载荷字节（MSB 优先，末字节低位补 0）
 */
import { byteFrequencies, buildCodeLengths, encodeBits, decodeBits } from './huffman';

export const MAGIC = Buffer.from('HUF1');
export const VERSION = 1;
export const HEADER_SIZE = 278;

export interface ContainerInfo {
  origLen: number;
  payloadBits: number;
  codeLengths: Uint8Array;
  payload: Buffer;
  headerBytes: number;
  fileBytes: number;
}

export function compress(data: Buffer): Buffer {
  const freq = byteFrequencies(data);
  const lengths = buildCodeLengths(freq);
  const { payload, bitLength } = encodeBits(data, lengths);
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = 0;
  header.writeBigUInt64LE(BigInt(data.length), 6);
  header.writeBigUInt64LE(BigInt(bitLength), 14);
  for (let i = 0; i < 256; i++) header[22 + i] = lengths[i];
  return Buffer.concat([header, payload]);
}

export function parseContainer(buf: Buffer): ContainerInfo {
  if (buf.length < HEADER_SIZE) throw new Error('BAD_HEADER:文件小于头部长度');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('BAD_HEADER:魔数不匹配');
  if (buf[4] !== VERSION) throw new Error(`BAD_HEADER:不支持的版本 ${buf[4]}`);
  if (buf[5] !== 0) throw new Error('BAD_HEADER:保留字节非零');
  const origLen = Number(buf.readBigUInt64LE(6));
  const payloadBits = Number(buf.readBigUInt64LE(14));
  if (!Number.isSafeInteger(origLen) || !Number.isSafeInteger(payloadBits)) throw new Error('BAD_HEADER:长度超出安全整数');
  const codeLengths = new Uint8Array(256);
  for (let i = 0; i < 256; i++) codeLengths[i] = buf[22 + i];
  const payload = buf.subarray(HEADER_SIZE);
  return { origLen, payloadBits, codeLengths, payload, headerBytes: HEADER_SIZE, fileBytes: buf.length };
}

/** 解码并做全部一致性校验；maxLen 为输出长度上限。 */
export function decompress(buf: Buffer, maxLen: number = 64 * 1024 * 1024): Buffer {
  const info = parseContainer(buf);
  if (info.origLen > maxLen) throw new Error(`OUTPUT_LIMIT:声明长度 ${info.origLen} 超过上限 ${maxLen}`);
  const expectedPayloadBytes = Math.ceil(info.payloadBits / 8);
  if (info.payload.length !== expectedPayloadBytes) throw new Error('TRUNCATED_PAYLOAD:载荷字节数与有效位数不符');
  return decodeBits(info.payload, info.payloadBits, info.codeLengths, info.origLen);
}
