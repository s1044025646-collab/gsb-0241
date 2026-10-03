import test from 'node:test';
import assert from 'node:assert/strict';
import { compress, decompress, verify, sha256Hex } from '../../dist/src/core/container.js';
import { HfError } from '../../dist/src/core/errors.js';

const roundTrip = (input) => {
  const { file, stats } = compress(input);
  const { data } = decompress(file);
  assert.equal(data.length, input.length, '长度一致');
  for (let i = 0; i < input.length; i++) assert.equal(data[i], input[i], `字节 ${i} 一致`);
  return { file, stats };
};

test('空输入往返：零符号、零位载荷', () => {
  const input = Buffer.alloc(0);
  const { file, stats } = roundTrip(input);
  assert.equal(stats.symbolCount, 0);
  assert.equal(stats.payloadBits, 0);
  assert.equal(stats.payloadBytes, 0);
  assert.equal(stats.padBits, 0);
  assert.ok(file.length > 0);
});

test('单符号往返：码字长度 1，有效位数等于字节数', () => {
  const input = Buffer.alloc(300, 0x41);
  const { file, stats } = roundTrip(input);
  assert.equal(stats.symbolCount, 1);
  assert.equal(stats.payloadBits, 300);
  assert.equal(stats.padBits, (8 - (300 % 8)) % 8);
  const result = decompress(file);
  assert.equal(result.table[0].codeText, '0');
});

test('非整字节结尾：填充位为 0 且往返一致', () => {
  const input = Buffer.from('ab', 'ascii');
  const { file, stats } = roundTrip(input);
  assert.notEqual(stats.payloadBits % 8, 0);
  const pad = (8 - (stats.payloadBits % 8)) % 8;
  const last = file[file.length - 1];
  assert.equal(last & ((1 << pad) - 1), 0);
});

test('二进制零字节往返', () => {
  roundTrip(Buffer.from([0, 0, 1, 0, 255, 255, 0, 128, 127]));
});

test('随机 4KB 往返逐字节一致', () => {
  const input = Buffer.alloc(4096);
  let s = 7;
  for (let i = 0; i < input.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    input[i] = s & 0xff;
  }
  roundTrip(input);
});

test('实际存储如实报告：区分载荷位、头部与总大小', () => {
  const input = Buffer.alloc(10, 0x55);
  const { stats } = compress(input);
  assert.equal(stats.fileSize, stats.headerBytes + stats.payloadBytes);
  assert.equal(stats.headerBytes, 4 + 4 + 4 + 4 + 2 + 5 + 32);
  assert.equal(stats.sizeDelta, stats.fileSize - stats.originalSize);
});

test('损坏头部：魔数错误', () => {
  const { file } = compress(Buffer.from('hello'));
  file[0] = 0x58;
  assert.throws(() => decompress(file), (e) => e instanceof HfError && e.code === 'BAD_HEADER_MAGIC');
});

test('损坏头部：截断头部', () => {
  const { file } = compress(Buffer.from('hello'));
  assert.throws(() => decompress(file.subarray(0, 10)), (e) => e.code === 'TRUNCATED_HEADER');
});

test('截断载荷被拒绝', () => {
  const { file } = compress(Buffer.alloc(5000, 0x33));
  assert.throws(() => decompress(file.subarray(0, file.length - 1)), (e) => e.code === 'TRUNCATED_PAYLOAD');
});

test('错误填充位被拒绝', () => {
  const { file } = compress(Buffer.from('abcdefg'));
  file[file.length - 1] = file[file.length - 1] | 0x01;
  assert.throws(() => decompress(file), (e) => e.code === 'BAD_PAD_BITS');
});

test('坏码表：重复符号被拒绝', () => {
  const { file } = compress(Buffer.from('aabbcc'));
  const count = file.readUInt32BE(12);
  file[18 + 5] = file[18];
  assert.ok(count >= 2);
  assert.throws(() => decompress(file), (e) => e.code === 'BAD_CODETABLE');
});

test('坏码表：非 Kraft 码长组合被拒绝', () => {
  const { file } = compress(Buffer.from('aabbccdd'));
  file.writeUInt32BE(1, 19);
  file.writeUInt32BE(1, 24);
  file.writeUInt32BE(1, 29);
  file.writeUInt32BE(1, 34);
  assert.throws(() => decompress(file), (e) => e.code === 'BAD_CODETABLE');
});

test('声明长度与实际不符被拒绝', () => {
  const { file } = compress(Buffer.from('abcabc'));
  file.writeUInt32BE(999, 4);
  assert.throws(() => decompress(file), (e) => e.code === 'LENGTH_MISMATCH');
});

test('载荷被篡改：校验和不匹配', () => {
  const { file } = compress(Buffer.from('abcabcabc'));
  file[file.length - 2] ^= 0xff;
  assert.throws(() => decompress(file), (e) => e.code === 'CHECKSUM_MISMATCH' || e.code === 'BAD_PAD_BITS' || e.code === 'BAD_PAYLOAD');
});

test('输出长度上限被强制', () => {
  const { file } = compress(Buffer.alloc(1000, 0x41));
  assert.throws(() => decompress(file, { maxOutput: 100 }), (e) => e.code === 'OUTPUT_TOO_LARGE');
});

test('verify 返回结构与校验和', () => {
  const input = Buffer.from('verify me');
  const { file } = compress(input);
  const result = verify(file);
  assert.equal(result.ok, true);
  assert.equal(result.originalSize, input.length);
  assert.equal(result.inputSha256, sha256Hex(input));
  assert.equal(result.checksumMatches, true);
});

test('产物确定性：同一输入两次压缩字节完全相同', () => {
  const input = Buffer.from('deterministic'.repeat(50));
  assert.ok(compress(input).file.equals(compress(input).file));
});
