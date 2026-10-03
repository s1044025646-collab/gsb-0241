import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { Store } from '../db/index.js';
import {
  compress,
  decompress,
  verify,
  sha256Hex,
  DEFAULT_MAX_OUTPUT,
} from '../core/container.js';
import { countFrequencies } from '../core/huffman.js';
import { HfError } from '../core/errors.js';

export interface LabConfig {
  dataDir: string;
  dbPath: string;
  inputsDir: string;
  artifactsDir: string;
  outputsDir: string;
  samplesDir: string;
  maxOutput: number;
}

export function resolveConfig(dataDir?: string, maxOutput?: number): LabConfig {
  const root = dataDir ? resolve(dataDir) : resolve(process.cwd(), 'data');
  return {
    dataDir: root,
    dbPath: join(root, 'hf1.db'),
    inputsDir: join(root, 'inputs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    samplesDir: join(root, 'samples'),
    maxOutput: maxOutput ?? DEFAULT_MAX_OUTPUT,
  };
}

export class LabService {
  readonly config: LabConfig;
  readonly store: Store;

  constructor(config: LabConfig) {
    this.config = config;
    for (const d of [config.dataDir, config.inputsDir, config.artifactsDir, config.outputsDir]) {
      mkdirSync(d, { recursive: true });
    }
    this.store = new Store(config.dbPath);
  }

  close(): void {
    this.store.close();
  }

  importBytes(data: Uint8Array, sourceType: string, sourcePath: string | null): { inputId: number; sha256: string; size: number } {
    const hash = sha256Hex(data);
    const inputId = this.store.upsertInput(hash, data.length, sourceType, sourcePath);
    const storedPath = join(this.config.inputsDir, `${hash}.bin`);
    if (!existsSync(storedPath)) {
      writeFileSync(storedPath, Buffer.from(data));
    }
    this.store.logOperation({
      op: 'import',
      status: 'ok',
      inputId,
      detail: `导入 ${data.length} 字节，来源 ${sourceType}`,
    });
    return { inputId, sha256: hash, size: data.length };
  }

  importFile(path: string): { inputId: number; sha256: string; size: number } {
    const abs = resolve(path);
    if (!existsSync(abs)) throw new HfError('NOT_FOUND', `文件不存在: ${abs}`, 404);
    const data = readFileSync(abs);
    return this.importBytes(data, 'file', abs);
  }

  private readInput(inputId: number): { data: Uint8Array; path: string } {
    const row = this.store.getInput(inputId);
    if (!row) throw new HfError('NOT_FOUND', `输入记录不存在: ${inputId}`, 404);
    const path = join(this.config.inputsDir, `${row.sha256}.bin`);
    if (!existsSync(path)) throw new HfError('NOT_FOUND', `输入副本缺失: ${path}`, 404);
    return { data: readFileSync(path), path };
  }

  compressInput(inputId: number): {
    artifactId: number;
    artifactPath: string;
    table: ReturnType<typeof compress>['table'];
    stats: ReturnType<typeof compress>['stats'];
  } {
    const { data } = this.readInput(inputId);
    const { file, table, stats } = compress(data);
    const hash = stats.inputSha256;
    const artifactPath = join(this.config.artifactsDir, `${hash}.hf1`);
    let artifactId: number;
    try {
      writeFileSync(artifactPath, file);
      artifactId = this.upsertArtifact(inputId, artifactPath, stats);
    } catch (err) {
      this.store.logOperation({
        op: 'compress',
        status: 'error',
        inputId,
        detail: `写出压缩产物失败: ${(err as Error).message}`,
        errorCode: 'IO_ERROR',
      });
      throw err;
    }
    this.store.logOperation({
      op: 'compress',
      status: 'ok',
      inputId,
      artifactId,
      detail: `压缩 ${stats.originalSize} -> ${stats.fileSize} 字节（载荷 ${stats.payloadBits} 位，头部 ${stats.headerBytes} 字节）`,
    });
    return { artifactId, artifactPath, table, stats };
  }

  private upsertArtifact(
    inputId: number,
    path: string,
    stats: ReturnType<typeof compress>['stats'],
  ): number {
    const existing = this.store.db
      .prepare('SELECT id FROM artifacts WHERE path = ?')
      .get(path) as { id: number } | undefined;
    if (existing) return existing.id;
    return this.store.insertArtifact({
      input_id: inputId,
      path,
      file_size: stats.fileSize,
      payload_bits: stats.payloadBits,
      header_bytes: stats.headerBytes,
      pad_bits: stats.padBits,
      symbol_count: stats.symbolCount,
      input_sha256: stats.inputSha256,
    });
  }

  getCodeTable(inputId: number): { freq: ReturnType<typeof countFrequencies>; table: ReturnType<typeof compress>['table'] } {
    const { data } = this.readInput(inputId);
    const freq = countFrequencies(data);
    const { table } = compress(data);
    return { freq, table };
  }

  readArtifactBytes(artifactId: number, pathOverride?: string): { bytes: Uint8Array; path: string } {
    let path = pathOverride ? resolve(pathOverride) : null;
    if (!path) {
      const row = this.store.getArtifact(artifactId);
      if (!row) throw new HfError('NOT_FOUND', `产物记录不存在: ${artifactId}`, 404);
      path = row.path;
    }
    if (!existsSync(path)) throw new HfError('NOT_FOUND', `产物文件缺失: ${path}`, 404);
    return { bytes: readFileSync(path), path };
  }

  verifyArtifact(artifactId: number, pathOverride?: string) {
    const { bytes, path } = this.readArtifactBytes(artifactId, pathOverride);
    try {
      const result = verify(bytes, { maxOutput: this.config.maxOutput });
      this.store.logOperation({
        op: 'verify',
        status: 'ok',
        artifactId: pathOverride ? null : artifactId,
        detail: `验证通过: ${path}，原始 ${result.originalSize} 字节，校验和匹配`,
      });
      return { ...result, path };
    } catch (err) {
      this.store.logOperation({
        op: 'verify',
        status: 'error',
        artifactId: pathOverride ? null : artifactId,
        detail: `验证失败: ${path} - ${(err as Error).message}`,
        errorCode: err instanceof HfError ? err.code : 'IO_ERROR',
      });
      throw err;
    }
  }

  decodeArtifact(
    artifactId: number,
    outputName: string | null,
    pathOverride?: string,
  ): { outputPath: string; sha256: string; size: number; matches: boolean; inputId: number | null } {
    const { bytes, path: artifactPath } = this.readArtifactBytes(artifactId, pathOverride);
    let result;
    try {
      result = decompress(bytes, { maxOutput: this.config.maxOutput });
    } catch (err) {
      this.store.logOperation({
        op: 'decode',
        status: 'error',
        artifactId: pathOverride ? null : artifactId,
        detail: `解码失败: ${artifactPath} - ${(err as Error).message}`,
        errorCode: err instanceof HfError ? err.code : 'IO_ERROR',
      });
      throw err;
    }
    const safeName = (outputName ?? basename(artifactPath).replace(/\.hf1$/, '') + '.decoded.bin')
      .replace(/[\\/]/g, '_');
    const outputPath = join(this.config.outputsDir, safeName);
    try {
      writeFileSync(outputPath, Buffer.from(result.data));
    } catch (err) {
      this.store.logOperation({
        op: 'decode',
        status: 'error',
        detail: `写出解码文件失败: ${(err as Error).message}`,
        errorCode: 'IO_ERROR',
      });
      throw err;
    }
    const hash = sha256Hex(result.data);
    const inputRow = this.store.db
      .prepare('SELECT id FROM inputs WHERE sha256 = ?')
      .get(hash) as { id: number } | undefined;
    this.store.logOperation({
      op: 'decode',
      status: 'ok',
      artifactId: pathOverride ? null : artifactId,
      inputId: inputRow?.id ?? null,
      detail: `解码 ${result.data.length} 字节 -> ${outputPath}`,
    });
    return {
      outputPath,
      sha256: hash,
      size: result.data.length,
      matches: hash === result.header.sha256,
      inputId: inputRow?.id ?? null,
    };
  }

  compareHash(inputId: number, decodedPath: string) {
    const { data } = this.readInput(inputId);
    const decoded = readFileSync(resolve(decodedPath));
    let equal = data.length === decoded.length;
    if (equal) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== decoded[i]) {
          equal = false;
          break;
        }
      }
    }
    const result = {
      inputSha256: sha256Hex(data),
      decodedSha256: sha256Hex(decoded),
      inputSize: data.length,
      decodedSize: decoded.length,
      byteIdentical: equal,
    };
    this.store.logOperation({
      op: 'compare',
      status: 'ok',
      inputId,
      detail: `逐字节比较: ${equal ? '完全一致' : '不一致'}（${data.length} 字节）`,
    });
    return result;
  }

  listSamples(): string[] {
    if (!existsSync(this.config.samplesDir)) return [];
    return readdirSync(this.config.samplesDir)
      .filter((f) => f.endsWith('.bin') || f.endsWith('.txt'))
      .sort();
  }
}
