/** HTTP API（node:http，无外部依赖）。默认端口 0 = 自动选择空闲端口。 */
import http from 'node:http';
import fs from 'node:fs';
import { openDb } from './db';
import * as svc from './service';

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createServer(dataDir: string) {
  const ctx = openDb(dataDir);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    try {
      if (m === 'POST' && p === '/api/inputs') {
        const body = await readBody(req);
        const name = url.searchParams.get('name') ?? 'unnamed';
        return send(res, 201, svc.importInput(ctx, body, name));
      }
      if (m === 'GET' && p === '/api/inputs') return send(res, 200, svc.listInputs(ctx));
      if (m === 'GET' && p === '/api/artifacts') return send(res, 200, svc.listArtifacts(ctx));
      if (m === 'POST' && p === '/api/compress') {
        const { inputId } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (!Number.isInteger(inputId)) throw new svc.ApiError('BAD_PARAM', 'inputId 必须为整数');
        return send(res, 201, svc.compressInput(ctx, inputId));
      }
      let match: RegExpMatchArray | null;
      if ((match = p.match(/^\/api\/inputs\/(\d+)\/freq$/)) && m === 'GET')
        return send(res, 200, svc.frequencyTable(ctx, Number(match[1])));
      if ((match = p.match(/^\/api\/artifacts\/(\d+)\/codes$/)) && m === 'GET')
        return send(res, 200, svc.codeTable(ctx, Number(match[1])));
      if ((match = p.match(/^\/api\/artifacts\/(\d+)\/verify$/)) && m === 'POST')
        return send(res, 200, svc.verifyArtifact(ctx, Number(match[1])));
      if ((match = p.match(/^\/api\/artifacts\/(\d+)\/decode$/)) && m === 'POST') {
        const raw = (await readBody(req)).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        return send(res, 200, svc.decodeArtifact(ctx, Number(match[1]), body.outPath, body.maxLen));
      }
      if ((match = p.match(/^\/api\/artifacts\/(\d+)\/summary$/)) && m === 'GET')
        return send(res, 200, svc.artifactSummary(ctx, Number(match[1])));
      if (m === 'GET' && p === '/api/history') return send(res, 200, svc.history(ctx));
      throw new svc.ApiError('NOT_FOUND', `${m} ${p} 不存在`);
    } catch (e: any) {
      if (e instanceof svc.ApiError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'BAD_PARAM' ? 400 : 422;
        return send(res, status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: e.message } });
    }
  });
}

export function startServer(dataDir: string, port: number): Promise<number> {
  return new Promise(resolve => {
    const server = createServer(dataDir);
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual} (数据目录: ${dataDir})`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  startServer(process.env.DATA_DIR ?? 'data', port);
}
