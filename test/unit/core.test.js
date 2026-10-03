import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countFrequencies,
  buildCodeTable,
  canonicalCodes,
  codeLengths,
} from '../../dist/src/core/huffman.js';

test('频率统计：手写短字节串', () => {
  const data = Buffer.from('aabbbc', 'ascii');
  const freq = countFrequencies(data);
  const map = new Map(freq.map((f) => [f.byte, f.freq]));
  assert.equal(map.get(97), 2);
  assert.equal(map.get(98), 3);
  assert.equal(map.get(99), 1);
  assert.deepEqual(
    freq.map((f) => f.byte),
    [97, 98, 99],
  );
});

test('确定性平局：同频率按字节序，两次构造码表完全一致', () => {
  const data = Buffer.from([0, 1, 2, 3, 0, 1, 2, 3]);
  const t1 = buildCodeTable(countFrequencies(data));
  const t2 = buildCodeTable(countFrequencies(Buffer.from([3, 2, 1, 0, 3, 2, 1, 0])));
  assert.deepEqual(t1, t2);
  const lengths = t1.map((e) => e.length);
  assert.ok(lengths.every((l) => l === 2), `4 个等频符号应等长 2，实际 ${lengths}`);
  assert.deepEqual(
    t1.map((e) => e.codeText),
    ['00', '01', '10', '11'],
  );
});

test('经典权重合并：高频符号码长不大于低频符号', () => {
  const data = Buffer.from('aaaaaaaabbccdef', 'ascii');
  const table = buildCodeTable(countFrequencies(data));
  const by = new Map(table.map((e) => [e.byte, e.length]));
  assert.ok(by.get(97) <= by.get(98));
  assert.ok(by.get(98) <= by.get(100));
});

test('空输入与单符号', () => {
  assert.deepEqual(codeLengths([]), new Map());
  const single = codeLengths([{ byte: 65, freq: 10 }]);
  assert.equal(single.get(65), 1);
});

test('规范码分配：长度升序、同长度按字节序、code 连续', () => {
  const codes = canonicalCodes(
    new Map([
      [10, 2],
      [20, 2],
      [30, 3],
      [40, 3],
      [50, 3],
      [60, 3],
    ]),
  );
  assert.deepEqual(
    codes.map((c) => [c.byte, c.code.toString(2).padStart(c.length, '0')]),
    [
      [10, '00'],
      [20, '01'],
      [30, '100'],
      [40, '101'],
      [50, '110'],
      [60, '111'],
    ],
  );
});

test('零字节被当作普通字节统计', () => {
  const freq = countFrequencies(Buffer.from([0, 0, 0, 1]));
  assert.deepEqual(freq, [
    { byte: 0, freq: 3 },
    { byte: 1, freq: 1 },
  ]);
});
