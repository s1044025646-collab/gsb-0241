import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SampleInfo {
  name: string;
  path: string;
  size: number;
  kind: string;
}

export function generateSamples(samplesDir: string): SampleInfo[] {
  mkdirSync(samplesDir, { recursive: true });
  const samples: SampleInfo[] = [];

  const paragraph =
    'Huffman coding assigns shorter codes to frequent bytes. 压缩实验：重复文本高频字节集中。\n';
  const repeated = Buffer.alloc(4096);
  for (let i = 0; i < repeated.length; i++) {
    repeated[i] = paragraph.charCodeAt(i % paragraph.length) & 0xff;
  }
  const p1 = join(samplesDir, 'sample-repeat-text.bin');
  writeFileSync(p1, repeated);
  samples.push({ name: 'sample-repeat-text.bin', path: p1, size: repeated.length, kind: '重复文本' });

  const single = Buffer.alloc(2048, 0x41);
  const p2 = join(samplesDir, 'sample-single-byte.bin');
  writeFileSync(p2, single);
  samples.push({ name: 'sample-single-byte.bin', path: p2, size: single.length, kind: '单字节序列' });

  const uniform = Buffer.alloc(256 * 16);
  for (let i = 0; i < uniform.length; i++) {
    uniform[i] = i & 0xff;
  }
  const p3 = join(samplesDir, 'sample-near-uniform.bin');
  writeFileSync(p3, uniform);
  samples.push({ name: 'sample-near-uniform.bin', path: p3, size: uniform.length, kind: '近似均匀字节分布' });

  return samples;
}
