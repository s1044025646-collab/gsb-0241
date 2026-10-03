/** CLI：import / compress / freq / codes / verify / decode / summary / history / serve / sample */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';
import * as svc from './service';
import { startServer } from './api';

const dataDir = process.env.DATA_DIR ?? 'data';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function makeSamples(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const rep = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(200), 'utf8');
  fs.writeFileSync(path.join(dir, 'repeated-text.txt'), rep);
  fs.writeFileSync(path.join(dir, 'single-byte.bin'), Buffer.alloc(4096, 0x41));
  const uniform = Buffer.alloc(256 * 16);
  for (let i = 0; i < uniform.length; i++) uniform[i] = i % 256;
  fs.writeFileSync(path.join(dir, 'uniform-bytes.bin'), uniform);
  return ['repeated-text.txt', 'single-byte.bin', 'uniform-bytes.bin'].map(n => path.join(dir, n));
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const ctx = openDb(dataDir);
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  switch (cmd) {
    case 'import': {
      const file = rest[0];
      if (!file) throw new Error('用法: cli import <文件> [名称]');
      out(svc.importInput(ctx, fs.readFileSync(file), rest[1] ?? path.basename(file)));
      break;
    }
    case 'compress': out(svc.compressInput(ctx, Number(rest[0]))); break;
    case 'freq': out(svc.frequencyTable(ctx, Number(rest[0]))); break;
    case 'codes': out(svc.codeTable(ctx, Number(rest[0]))); break;
    case 'verify': out(svc.verifyArtifact(ctx, Number(rest[0]))); break;
    case 'decode': out(svc.decodeArtifact(ctx, Number(rest[0]), arg('--out'), arg('--max-len') ? Number(arg('--max-len')) : undefined)); break;
    case 'summary': out(svc.artifactSummary(ctx, Number(rest[0]))); break;
    case 'history': out(svc.history(ctx)); break;
    case 'inputs': out(svc.listInputs(ctx)); break;
    case 'artifacts': out(svc.listArtifacts(ctx)); break;
    case 'sample': {
      const files = makeSamples(path.join(dataDir, 'samples'));
      for (const f of files) {
        const imp = svc.importInput(ctx, fs.readFileSync(f), path.basename(f));
        const art = svc.compressInput(ctx, imp.id);
        const ver = svc.verifyArtifact(ctx, art.id);
        const dec = svc.decodeArtifact(ctx, art.id);
        console.log(`${imp.name}: ${art.origSize}B -> ${art.fileSize}B (比率 ${art.ratio.toFixed(3)}${art.expanded ? ', 变大' : ''}) 往返一致=${ver.ok} 解码文件=${dec.outPath}`);
      }
      break;
    }
    case 'serve': {
      const port = arg('--port') ? Number(arg('--port')) : 0;
      startServer(dataDir, port);
      break;
    }
    default:
      console.log('命令: import <文件> [名称] | compress <输入ID> | freq <输入ID> | codes <产物ID> | verify <产物ID> | decode <产物ID> [--out 文件] [--max-len N] | summary <产物ID> | history | inputs | artifacts | sample | serve [--port N]');
  }
}

if (require.main === module) main();
export { makeSamples };
