import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { resolveConfig, LabService } from '../services/lab.js';
import { generateSamples } from '../services/samples.js';
import { HfError } from '../core/errors.js';

interface Json {
  [key: string]: unknown;
}

function pickPort(preferred?: number): Promise<number> {
  if (preferred) {
    return new Promise((resolve, reject) => {
      const probe = createNetServer();
      probe.once('error', reject);
      probe.listen(preferred, '127.0.0.1', () => {
        probe.close(() => resolve(preferred!));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const readBody = (req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HfError('INVALID_ARG', `请求体超过 ${limit} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export function createApp(lab: LabService): Server {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  };

  const sendError = (res: ServerResponse, err: unknown): void => {
    if (err instanceof HfError) {
      send(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    send(res, 500, {
      ok: false,
      error: { code: 'IO_ERROR', message: (err as Error).message },
    });
  };

  const json = async (req: IncomingMessage): Promise<Json> => {
    const body = await readBody(req);
    if (body.length === 0) return {};
    return JSON.parse(body.toString('utf8')) as Json;
  };

  const requireId = (value: unknown, name: string): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HfError('INVALID_ARG', `${name} 必须是正整数`);
    }
    return id;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && path === '/health') {
        send(res, 200, { ok: true, service: 'hf1-huffman-lab', format: 'HF1/1' });
        return;
      }

      if (method === 'POST' && path === '/inputs/raw') {
        const body = await readBody(req);
        const result = lab.importBytes(new Uint8Array(body), 'api-raw', null);
        send(res, 201, { ...result, ok: true });
        return;
      }

      if (method === 'POST' && path === '/inputs/text') {
        const body = await json(req);
        if (typeof body.text !== 'string') {
          throw new HfError('INVALID_ARG', '字段 text 必须是字符串');
        }
        const result = lab.importBytes(Buffer.from(body.text, 'utf8'), 'api-text', null);
        send(res, 201, { ok: true, ...result });
        return;
      }

      if (method === 'POST' && path === '/inputs/import-file') {
        const body = await json(req);
        if (typeof body.path !== 'string' || body.path.length === 0) {
          throw new HfError('INVALID_ARG', '字段 path 必须是非空字符串');
        }
        const result = lab.importFile(body.path);
        send(res, 201, { ok: true, ...result });
        return;
      }

      if (method === 'GET' && path === '/inputs') {
        send(res, 200, { ok: true, items: lab.store.listInputs(Number(url.searchParams.get('limit') ?? 50)) });
        return;
      }

      const inputMatch = path.match(/^\/inputs\/(\d+)$/);
      if (method === 'GET' && inputMatch) {
        const row = lab.store.getInput(Number(inputMatch[1]));
        if (!row) throw new HfError('NOT_FOUND', '输入不存在', 404);
        send(res, 200, { ok: true, item: row });
        return;
      }

      const tableMatch = path.match(/^\/inputs\/(\d+)\/table$/);
      if (method === 'GET' && tableMatch) {
        const id = requireId(tableMatch[1], 'inputId');
        const { freq, table } = lab.getCodeTable(id);
        send(res, 200, { ok: true, frequency: freq, codeTable: table });
        return;
      }

      if (method === 'POST' && path === '/compress') {
        const body = await json(req);
        const inputId = requireId(body.inputId, 'inputId');
        const result = lab.compressInput(inputId);
        send(res, 201, { ok: true, ...result });
        return;
      }

      if (method === 'GET' && path === '/artifacts') {
        send(res, 200, { ok: true, items: lab.store.listArtifacts(Number(url.searchParams.get('limit') ?? 50)) });
        return;
      }

      const artifactMatch = path.match(/^\/artifacts\/(\d+)$/);
      if (method === 'GET' && artifactMatch) {
        const row = lab.store.getArtifact(Number(artifactMatch[1]));
        if (!row) throw new HfError('NOT_FOUND', '产物不存在', 404);
        send(res, 200, { ok: true, item: row });
        return;
      }

      const verifyMatch = path.match(/^\/artifacts\/(\d+)\/verify$/);
      if (method === 'POST' && verifyMatch) {
        const result = lab.verifyArtifact(Number(verifyMatch[1]));
        send(res, 200, { ...result, ok: true });
        return;
      }

      const decodeMatch = path.match(/^\/artifacts\/(\d+)\/decode$/);
      if (method === 'POST' && decodeMatch) {
        const body = (await json(req).catch(() => ({}))) as Partial<{ outputName: string }>;
        const result = lab.decodeArtifact(
          Number(decodeMatch[1]),
          typeof body.outputName === 'string' ? body.outputName : null,
        );
        send(res, 200, { ...result, ok: true });
        return;
      }

      if (method === 'POST' && path === '/verify-file') {
        const body = await json(req);
        if (typeof body.path !== 'string') throw new HfError('INVALID_ARG', '字段 path 必填');
        const result = lab.verifyArtifact(0, body.path);
        send(res, 200, { ...result, ok: true });
        return;
      }

      if (method === 'POST' && path === '/decode-file') {
        const body = await json(req);
        if (typeof body.path !== 'string') throw new HfError('INVALID_ARG', '字段 path 必填');
        const outputName = typeof body.outputName === 'string' ? body.outputName : null;
        const result = lab.decodeArtifact(
          0,
          outputName,
          body.path,
        );
        send(res, 200, { ...result, ok: true });
        return;
      }

      if (method === 'POST' && path === '/compare') {
        const body = await json(req);
        const inputId = requireId(body.inputId, 'inputId');
        if (typeof body.decodedPath !== 'string') throw new HfError('INVALID_ARG', '字段 decodedPath 必填');
        send(res, 200, { ok: true, ...lab.compareHash(inputId, body.decodedPath) });
        return;
      }

      if (method === 'GET' && path === '/operations') {
        send(res, 200, { ok: true, items: lab.store.listOperations(Number(url.searchParams.get('limit') ?? 50)) });
        return;
      }

      if (method === 'POST' && path === '/samples/generate') {
        send(res, 201, { ok: true, samples: generateSamples(lab.config.samplesDir) });
        return;
      }

      if (method === 'GET' && path === '/samples') {
        send(res, 200, { ok: true, samplesDir: lab.config.samplesDir, items: lab.listSamples() });
        return;
      }

      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由: ${method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let preferred: number | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) preferred = Number(args[++i]);
    if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
  }
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  preferred ??= envPort;
  const port = await pickPort(Number.isInteger(preferred) && preferred! > 0 ? preferred : undefined);
  const lab = new LabService(resolveConfig(dataDir));
  const server = createApp(lab);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[hf1] 服务已启动: http://127.0.0.1:${port}`);
    console.log(`[hf1] 数据目录: ${lab.config.dataDir}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      lab.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main as startServer };
