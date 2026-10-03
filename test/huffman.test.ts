import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { byteFrequencies, buildCodeLengths, codesToStrings, encodeBits, decodeBits } from '../src/huffman';
import { compress, decompress, parseContainer, HEADER_SIZE } from '../src/container';
import { openDb } from '../src/db';
import * as svc from '../src/service';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'huf-')); }

test('频率统计正确', () => {
  const freq = byteFrequencies(Buffer.from([0, 0, 0, 65, 65, 255]));
  assert.equal(freq[0], 3); assert.equal(freq[65], 2); assert.equal(freq[255], 1);
  assert.equal(freq[1], 0);
});

test('平局规则确定：同频率按符号升序，码字可复现', () => {
  const freq = new Uint32Array(256);
  freq[10] = 5; freq[5] = 5; freq[200] = 5; freq[100] = 1;
  const l1 = buildCodeLengths(freq);
  const l2 = buildCodeLengths(freq);
  assert.deepEqual([...l1], [...l2]);
  // 频率为 1 的符号码长应最长
  assert.ok(l1[100] >= l1[10]);
  // 同频率符号码长相同，规范码按符号升序分配
  assert.equal(l1[10], l1[5]);
  const codes = codesToStrings(l1);
  const c5 = codes.find(c => c.symbol === 5)!.code;
  const c10 = codes.find(c => c.symbol === 10)!.code;
  assert.ok(c5 < c10 || c5.length < c10.length);
});

test('前缀性质：无码字是另一码字前缀', () => {
  const data = Buffer.from('mississippi river', 'utf8');
  const lengths = buildCodeLengths(byteFrequencies(data));
  const codes = codesToStrings(lengths).map(c => c.code);
  for (const a of codes) for (const b of codes)
    if (a !== b) assert.ok(!b.startsWith(a), `${a} 是 ${b} 的前缀`);
});

test('空输入有明确表示并可往返', () => {
  const out = compress(Buffer.alloc(0));
  const info = parseContainer(out);
  assert.equal(info.origLen, 0);
  assert.equal(info.payloadBits, 0);
  assert.equal(info.payload.length, 0);
  assert.equal(decompress(out).length, 0);
});

test('单符号输入码长为 1 并可往返', () => {
  const data = Buffer.alloc(1000, 0x07);
  const out = compress(data);
  const info = parseContainer(out);
  assert.equal(info.payloadBits, 1000);
  assert.ok(decompress(out).equals(data));
});

test('非整字节结尾位流往返', () => {
  // 'a' 出现多次使码长不整除 8
  const data = Buffer.from('aab', 'utf8');
  const lengths = buildCodeLengths(byteFrequencies(data));
  const { payload, bitLength } = encodeBits(data, lengths);
  assert.equal(bitLength % 8 === 0, false);
  assert.ok(decodeBits(payload, bitLength, lengths, 3).equals(data));
});

test('二进制零字节往返', () => {
  const data = Buffer.from([0, 0, 0, 1, 0, 2, 0, 0, 0, 3]);
  assert.ok(decompress(compress(data)).equals(data));
});

test('所有字节频率相同（近似均匀）可往返', () => {
  const data = Buffer.alloc(256 * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  const out = compress(data);
  assert.ok(decompress(out).equals(data));
  const info = parseContainer(out);
  assert.equal(info.payloadBits, 256 * 4 * 8); // 均匀分布应全部 8 位码
});

test('确定性：同一输入两次压缩产物完全一致', () => {
  const data = Buffer.from('deterministic test 确定性', 'utf8');
  assert.ok(compress(data).equals(compress(data)));
});

test('损坏头部被拒绝', () => {
  const data = Buffer.from('hello world hello', 'utf8');
  const out = compress(data);
  const bad1 = Buffer.from(out); bad1[0] = 0x58; // 魔数
  assert.throws(() => decompress(bad1), /BAD_HEADER/);
  const bad2 = Buffer.from(out); bad2[4] = 99; // 版本
  assert.throws(() => decompress(bad2), /BAD_HEADER/);
});

test('截断载荷被拒绝', () => {
  const out = compress(Buffer.from('truncation test data 12345', 'utf8'));
  assert.throws(() => decompress(out.subarray(0, out.length - 1)), /TRUNCATED_PAYLOAD/);
});

test('错误有效位数被拒绝', () => {
  const out = compress(Buffer.from('bit length check abc', 'utf8'));
  const bad = Buffer.from(out);
  bad.writeBigUInt64LE(BigInt(3), 14); // 与载荷字节数不符
  assert.throws(() => decompress(bad), /TRUNCATED_PAYLOAD/);
});

test('坏码表（Kraft 不成立）被拒绝', () => {
  const out = compress(Buffer.from('kraft check data aa', 'utf8'));
  const bad = Buffer.from(out);
  bad[22] = 1; bad[23] = 1; bad[24] = 1; // 三个 1 位码，Kraft=1.5
  assert.throws(() => decompress(bad), /BAD_CODE_TABLE/);
});

test('输出长度上限生效', () => {
  const out = compress(Buffer.alloc(100, 9));
  assert.throws(() => decompress(out, 50), /OUTPUT_LIMIT/);
});

test('服务层：导入-压缩-验证-解码-历史，且重启后可查询', () => {
  const dir = tmpDir();
  const ctx = openDb(dir);
  const data = Buffer.from('持久化测试 persistence test '.repeat(30), 'utf8');
  const imp = svc.importInput(ctx, data, 't1');
  const art = svc.compressInput(ctx, imp.id);
  assert.equal(art.fileSize, art.payloadBytes + HEADER_SIZE);
  const ver = svc.verifyArtifact(ctx, art.id);
  assert.ok(ver.ok);
  const dec = svc.decodeArtifact(ctx, art.id);
  assert.ok(fs.readFileSync(dec.outPath).equals(data)); // 逐字节相等
  const sum = svc.artifactSummary(ctx, art.id);
  assert.equal(sum.origSize, data.length);
  ctx.db.close();
  // 模拟重启：重新打开同一数据目录
  const ctx2 = openDb(dir);
  const arts = svc.listArtifacts(ctx2) as any[];
  assert.equal(arts.length, 1);
  const ver2 = svc.verifyArtifact(ctx2, art.id);
  assert.ok(ver2.ok);
  const hist = svc.history(ctx2) as any[];
  assert.ok(hist.length >= 4);
  ctx2.db.close();
});

test('失败操作不记录为成功', () => {
  const dir = tmpDir();
  const ctx = openDb(dir);
  const imp = svc.importInput(ctx, Buffer.from('abcabcabc', 'utf8'), 't2');
  const art = svc.compressInput(ctx, imp.id);
  // 破坏产物文件
  const buf = fs.readFileSync(art.path);
  fs.writeFileSync(art.path, buf.subarray(0, buf.length - 1));
  assert.throws(() => svc.verifyArtifact(ctx, art.id));
  const hist = svc.history(ctx) as any[];
  const last = hist[0];
  assert.equal(last.kind, 'verify');
  assert.equal(last.ok, 0);
  ctx.db.close();
});
