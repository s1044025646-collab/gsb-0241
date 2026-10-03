import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig, LabService } from '../../dist/src/services/lab.js';
import { generateSamples } from '../../dist/src/services/samples.js';
import { createApp } from '../../dist/src/server/index.js';

const freshLab = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf1-test-'));
  return { dir, lab: new LabService(resolveConfig(dir)) };
};

test('服务层：导入 -> 压缩 -> 仅靠产物解码 -> 逐字节比较', () => {
  const { dir, lab } = freshLab();
  try {
    const source = join(dir, 'source.txt');
    writeFileSync(source, Buffer.from('你好 Huffman！'.repeat(100), 'utf8'));
    const imported = lab.importFile(source);
    const { artifactPath, stats } = lab.compressInput(imported.inputId);
    assert.ok(existsSync(artifactPath));
    const decoded = lab.decodeArtifact(0, 'out.bin', artifactPath);
    assert.equal(decoded.matches, true);
    const cmp = lab.compareHash(imported.inputId, decoded.outputPath);
    assert.equal(cmp.byteIdentical, true);
    assert.ok(stats.headerBytes > 0);
  } finally {
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('脱离数据库：把 .hf1 复制到新数据目录仍可解码', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'hf1-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'hf1-b-'));
  try {
    const labA = new LabService(resolveConfig(dirA));
    const imported = labA.importBytes(Buffer.from([0, 1, 2, 0, 0, 255]), 'test', null);
    const { artifactPath } = labA.compressInput(imported.inputId);
    labA.close();

    const copyPath = join(dirB, 'standalone.hf1');
    writeFileSync(copyPath, readFileSync(artifactPath));
    const labB = new LabService(resolveConfig(dirB));
    const decoded = labB.decodeArtifact(0, 'standalone.bin', copyPath);
    assert.deepEqual([...readFileSync(decoded.outputPath)], [0, 1, 2, 0, 0, 255]);
    labB.close();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('重启后查询：重新打开同一 SQLite，历史与输入仍在', () => {
  const { dir, lab } = freshLab();
  try {
    const imported = lab.importBytes(Buffer.from('persist me'), 'test', null);
    lab.compressInput(imported.inputId);
    lab.close();

    const reopened = new LabService(resolveConfig(dir));
    const inputs = reopened.store.listInputs();
    assert.equal(inputs.length, 1);
    const artifacts = reopened.store.listArtifacts();
    assert.equal(artifacts.length, 1);
    const ops = reopened.store.listOperations();
    assert.ok(ops.some((o) => o.op === 'import' && o.status === 'ok'));
    assert.ok(ops.some((o) => o.op === 'compress' && o.status === 'ok'));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败操作不记录为成功：验证损坏产物产生 error 历史', () => {
  const { dir, lab } = freshLab();
  try {
    const imported = lab.importBytes(Buffer.from('x'.repeat(20)), 'test', null);
    const { artifactPath } = lab.compressInput(imported.inputId);
    const brokenPath = join(dir, 'broken.hf1');
    const buf = readFileSync(artifactPath);
    buf[0] = 0x5a;
    writeFileSync(brokenPath, buf);
    assert.throws(() => lab.verifyArtifact(0, brokenPath));
    const ops = lab.store.listOperations();
    const failed = ops.filter((o) => o.status === 'error');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error_code, 'BAD_HEADER_MAGIC');
  } finally {
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('三类样例生成且可往返，压缩效果差异可观察', () => {
  const { dir, lab } = freshLab();
  try {
    const samples = generateSamples(lab.config.samplesDir);
    assert.equal(samples.length, 3);
    const results = samples.map((s) => {
      const imported = lab.importFile(s.path);
      const { stats } = lab.compressInput(imported.inputId);
      return { kind: s.kind, ratio: stats.ratioPercent };
    });
    const repeat = results.find((r) => r.kind === '重复文本');
    const single = results.find((r) => r.kind === '单字节序列');
    const uniform = results.find((r) => r.kind === '近似均匀字节分布');
    assert.ok(repeat.ratio < 100, '重复文本应变小');
    assert.ok(single.ratio < 100, '单字节应显著变小');
    assert.ok(uniform.ratio >= 100, '近似均匀分布因头部开销变大（如实报告）');
  } finally {
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP API：健康检查、导入、压缩、验证端到端', async () => {
  const { dir, lab } = freshLab();
  const server = createApp(lab);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const imported = await fetch(`${base}/inputs/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'api-http-测试'.repeat(20) }),
    }).then((r) => r.json());
    assert.equal(imported.ok, true);

    const compressed = await fetch(`${base}/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputId: imported.inputId }),
    }).then((r) => r.json());
    assert.equal(compressed.ok, true);

    const verified = await fetch(`${base}/artifacts/${compressed.artifactId}/verify`, {
      method: 'POST',
    }).then((r) => r.json());
    assert.equal(verified.ok, true);
    assert.equal(verified.checksumMatches, true);

    const bad = await fetch(`${base}/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputId: 'abc' }),
    });
    const badJson = await bad.json();
    assert.equal(bad.status, 400);
    assert.equal(badJson.error.code, 'INVALID_ARG');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
