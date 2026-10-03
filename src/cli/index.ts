#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveConfig, LabService } from '../services/lab.js';
import { generateSamples } from '../services/samples.js';
import { HfError } from '../core/errors.js';

const out = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

const usage = `HF1 Huffman 压缩实验 CLI

用法: hf1 <命令> [参数] [--data-dir <目录>]

命令:
  samples                       生成三类样例到 data/samples
  import <文件路径>             导入本地文件（不修改原文件）
  text <UTF-8文本>              导入内联文本
  inputs                        列出输入记录
  table <inputId>               查看频率表与 Huffman 码字
  compress <inputId>            压缩并写出 .hf1 产物
  artifacts                     列出压缩产物
  verify <file.hf1|artifactId>  验证容器结构、填充位与校验和
  decode <file.hf1|artifactId> [输出名]
                                仅依赖容器解码并导出到 data/outputs
  compare <inputId> <解码文件>  逐字节比较输入与解码文件
  history                       查询操作历史
  serve [--port 端口]           启动 HTTP API（默认空闲端口）
`;

function createLab(args: string[]): { lab: LabService; rest: string[] } {
  const rest: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) {
      dataDir = args[++i]!;
    } else {
      rest.push(args[i]!);
    }
  }
  return { lab: new LabService(resolveConfig(dataDir)), rest };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(usage);
    return 0;
  }
  if (cmd === 'serve') {
    const { startServer } = await import('../server/index.js');
    process.argv = [process.argv[0]!, 'serve', ...argv.slice(1)];
    await startServer();
    await new Promise(() => {});
    return 0;
  }

  const { lab, rest } = createLab(argv.slice(1));
  try {
    switch (cmd) {
      case 'samples': {
        out({ ok: true, samples: generateSamples(lab.config.samplesDir) });
        break;
      }
      case 'import': {
        const file = rest[0];
        if (!file) throw new HfError('INVALID_ARG', '需要提供文件路径');
        out({ ok: true, ...lab.importFile(file) });
        break;
      }
      case 'text': {
        const text = rest.join(' ');
        if (text.length === 0) throw new HfError('INVALID_ARG', '需要提供文本内容');
        out({ ok: true, ...lab.importBytes(Buffer.from(text, 'utf8'), 'cli-text', null) });
        break;
      }
      case 'inputs': {
        out({ ok: true, items: lab.store.listInputs() });
        break;
      }
      case 'table': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) throw new HfError('INVALID_ARG', '需要 inputId');
        const { freq, table } = lab.getCodeTable(id);
        out({ ok: true, inputId: id, frequency: freq, codeTable: table });
        break;
      }
      case 'compress': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) throw new HfError('INVALID_ARG', '需要 inputId');
        out({ ok: true, ...lab.compressInput(id) });
        break;
      }
      case 'artifacts': {
        out({ ok: true, items: lab.store.listArtifacts() });
        break;
      }
      case 'verify': {
        const arg = rest[0];
        if (!arg) throw new HfError('INVALID_ARG', '需要 artifactId 或 .hf1 文件路径');
        if (existsSync(resolve(arg)) && arg.endsWith('.hf1')) {
          out({ ...lab.verifyArtifact(0, resolve(arg)), ok: true });
        } else {
          out({ ...lab.verifyArtifact(Number(arg)), ok: true });
        }
        break;
      }
      case 'decode': {
        const arg = rest[0];
        if (!arg) throw new HfError('INVALID_ARG', '需要 artifactId 或 .hf1 文件路径');
        const outputName = rest[1] ?? null;
        if (existsSync(resolve(arg)) && arg.endsWith('.hf1')) {
          out({ ok: true, ...lab.decodeArtifact(0, outputName, resolve(arg)) });
        } else {
          out({ ok: true, ...lab.decodeArtifact(Number(arg), outputName) });
        }
        break;
      }
      case 'compare': {
        const id = Number(rest[0]);
        const decodedPath = rest[1];
        if (!Number.isInteger(id) || !decodedPath) {
          throw new HfError('INVALID_ARG', '用法: compare <inputId> <解码文件路径>');
        }
        out({ ok: true, ...lab.compareHash(id, decodedPath) });
        break;
      }
      case 'history': {
        out({ ok: true, items: lab.store.listOperations() });
        break;
      }
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(usage);
        return 2;
    }
  } catch (err) {
    if (err instanceof HfError) {
      console.error(JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }, null, 2));
      return 1;
    }
    throw err;
  } finally {
    lab.close();
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
