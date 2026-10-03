/** 服务层：API 与 CLI 共用的业务逻辑。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Db, recordOp } from './db';
import { compress, decompress, parseContainer } from './container';
import { byteFrequencies, buildCodeLengths, codesToStrings } from './huffman';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function importInput(ctx: Db, data: Buffer, name: string) {
  if (!name || name.length > 200) throw new ApiError('BAD_PARAM', 'name 必填且不超过 200 字符');
  const digest = sha256(data);
  const file = path.join(ctx.dataDir, 'inputs', `${digest}.bin`);
  fs.writeFileSync(file, data);
  const r = ctx.db.prepare('INSERT INTO inputs(name,sha256,size,path) VALUES(?,?,?,?)')
    .run(name, digest, data.length, file);
  const id = Number(r.lastInsertRowid);
  recordOp(ctx.db, 'import', true, `导入 ${name} (${data.length} 字节)`, id);
  return { id, name, sha256: digest, size: data.length };
}

function getInput(ctx: Db, id: number) {
  const row = ctx.db.prepare('SELECT * FROM inputs WHERE id=?').get(id) as any;
  if (!row) throw new ApiError('NOT_FOUND', `输入 ${id} 不存在`);
  return row;
}

function getArtifact(ctx: Db, id: number) {
  const row = ctx.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as any;
  if (!row) throw new ApiError('NOT_FOUND', `产物 ${id} 不存在`);
  return row;
}

export function compressInput(ctx: Db, inputId: number) {
  const input = getInput(ctx, inputId);
  const data = fs.readFileSync(input.path);
  let out: Buffer;
  try {
    out = compress(data);
  } catch (e: any) {
    recordOp(ctx.db, 'compress', false, e.message, inputId);
    throw new ApiError('COMPRESS_FAILED', e.message);
  }
  const file = path.join(ctx.dataDir, 'artifacts', `${input.sha256}.huf1`);
  fs.writeFileSync(file, out);
  const info = parseContainer(out);
  const payloadBits = info.payloadBits;
  const ratio = data.length === 0 ? 0 : out.length / data.length;
  const r = ctx.db.prepare(
    'INSERT INTO artifacts(input_id,path,orig_size,payload_bits,header_bytes,file_size,ratio) VALUES(?,?,?,?,?,?,?)')
    .run(inputId, file, data.length, payloadBits, info.headerBytes, out.length, ratio);
  const id = Number(r.lastInsertRowid);
  recordOp(ctx.db, 'compress', true,
    `原始 ${data.length}B -> 文件 ${out.length}B（头部 ${info.headerBytes}B + 载荷 ${Math.ceil(payloadBits / 8)}B），比率 ${ratio.toFixed(4)}${out.length > data.length ? '（变大，如实报告）' : ''}`,
    inputId, id);
  return {
    id, inputId, path: file, origSize: data.length, payloadBits,
    payloadBytes: Math.ceil(payloadBits / 8), headerBytes: info.headerBytes,
    fileSize: out.length, ratio, expanded: out.length > data.length,
  };
}

export function frequencyTable(ctx: Db, inputId: number) {
  const input = getInput(ctx, inputId);
  const data = fs.readFileSync(input.path);
  const freq = byteFrequencies(data);
  const table = [];
  for (let s = 0; s < 256; s++) if (freq[s] > 0) table.push({ symbol: s, count: freq[s] });
  return { inputId, size: data.length, distinct: table.length, table };
}

export function codeTable(ctx: Db, artifactId: number) {
  const art = getArtifact(ctx, artifactId);
  const buf = fs.readFileSync(art.path);
  const info = parseContainer(buf);
  return { artifactId, codes: codesToStrings(info.codeLengths) };
}

export function verifyArtifact(ctx: Db, artifactId: number, maxLen = 64 * 1024 * 1024) {
  const art = getArtifact(ctx, artifactId);
  try {
    const buf = fs.readFileSync(art.path);
    const decoded = decompress(buf, maxLen);
    const input = getInput(ctx, art.input_id);
    const orig = fs.readFileSync(input.path);
    const match = decoded.equals(orig);
    recordOp(ctx.db, 'verify', match, match ? '解码逐字节等于原输入' : '解码与原文不一致', art.input_id, artifactId);
    return { artifactId, ok: match, decodedBytes: decoded.length, sha256: sha256(decoded) };
  } catch (e: any) {
    recordOp(ctx.db, 'verify', false, e.message, art.input_id, artifactId);
    throw new ApiError('VERIFY_FAILED', e.message);
  }
}

export function decodeArtifact(ctx: Db, artifactId: number, outPath?: string, maxLen = 64 * 1024 * 1024) {
  const art = getArtifact(ctx, artifactId);
  let decoded: Buffer;
  try {
    decoded = decompress(fs.readFileSync(art.path), maxLen);
  } catch (e: any) {
    recordOp(ctx.db, 'decode', false, e.message, art.input_id, artifactId);
    throw new ApiError('DECODE_FAILED', e.message);
  }
  const file = outPath ?? path.join(ctx.dataDir, 'outputs', `artifact-${artifactId}.bin`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, decoded);
  recordOp(ctx.db, 'decode', true, `解码 ${decoded.length} 字节 -> ${file}`, art.input_id, artifactId);
  return { artifactId, outPath: file, bytes: decoded.length, sha256: sha256(decoded) };
}

export function artifactSummary(ctx: Db, artifactId: number) {
  const art = getArtifact(ctx, artifactId) as any;
  const input = getInput(ctx, art.input_id);
  return {
    artifactId, inputId: art.input_id, inputName: input.name, inputSha256: input.sha256,
    origSize: art.orig_size, payloadBits: art.payload_bits,
    payloadBytes: Math.ceil(art.payload_bits / 8), headerBytes: art.header_bytes,
    fileSize: art.file_size, ratio: art.ratio, expanded: art.file_size > art.orig_size,
    path: art.path, createdAt: art.created_at,
  };
}

export function history(ctx: Db, limit = 50) {
  return ctx.db.prepare('SELECT * FROM ops ORDER BY id DESC LIMIT ?').all(limit);
}

export function listInputs(ctx: Db) {
  return ctx.db.prepare('SELECT id,name,sha256,size,created_at FROM inputs ORDER BY id DESC').all();
}

export function listArtifacts(ctx: Db) {
  return ctx.db.prepare('SELECT id,input_id,orig_size,payload_bits,header_bytes,file_size,ratio,created_at FROM artifacts ORDER BY id DESC').all();
}

/** 供测试直接使用：由频率表得到码长与码字。 */
export { buildCodeLengths, codesToStrings };
