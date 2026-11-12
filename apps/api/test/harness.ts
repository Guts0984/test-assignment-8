import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { agentCategories, users, type Db } from '@helpdesk/db';
import { hashPassword } from '../src/lib/passwords';

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export type Api = {
  port: number;
  url: string;
  pid: number;
  uploadsDir: string;
  logs: () => string;
  /** Sends the signal and resolves with the exit code once the process is gone. */
  stop: (signal?: NodeJS.Signals) => Promise<number | null>;
  exited: Promise<number | null>;
};

export const startApi = async (
  dbUrl: string,
  env: Record<string, string> = {},
  opts: { waitReady?: boolean } = {},
): Promise<Api> => {
  const port = await freePort();
  const uploadsDir = env.UPLOADS_DIR ?? mkdtempSync(path.join(tmpdir(), 'hd-uploads-'));
  const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      PORT: String(port),
      HOST: '0.0.0.0',
      LOG_LEVEL: 'warn',
      AUTO_MIGRATE: 'false',
      AUTO_SEED: 'false',
      WORKER_ENABLED: 'false', // job tests start their own worker; other suites must not have jobs mutate their fixtures
      UPLOADS_DIR: uploadsDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const api: Api = {
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid ?? -1,
    uploadsDir,
    logs: () => out,
    exited,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
  };
  if (opts.waitReady === false) return api;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`api exited early (${child.exitCode}):\n${out}`);
    try {
      const r = await request(api, { path: '/health' });
      if (r.status === 200) return api;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`api did not start:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};

export type Res = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
  ms: number;
  setCookies: string[];
};

export type ReqOpts = {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer | object;
  /** Source address to bind (127.x.y.z are all local on Linux → many distinct "clients"). */
  from?: string;
  cookie?: string;
  timeoutMs?: number;
};

export const request = (api: Pick<Api, 'port'>, o: ReqOpts = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const isJson = o.body !== undefined && typeof o.body === 'object' && !Buffer.isBuffer(o.body);
    const payload =
      o.body === undefined
        ? undefined
        : isJson
          ? Buffer.from(JSON.stringify(o.body))
          : Buffer.from(o.body as string | Buffer);
    const headers: Record<string, string | string[] | number> = { ...(o.headers ?? {}) };
    if (isJson && !headers['content-type']) headers['content-type'] = 'application/json';
    if (payload && headers['content-length'] === undefined)
      headers['content-length'] = payload.length;
    if (o.cookie) headers.cookie = o.cookie;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: api.port,
        method: o.method ?? 'GET',
        path: o.path ?? '/',
        headers,
        ...(o.from ? { localAddress: o.from } : {}),
        agent: false, // a fresh connection (and source address) per request
        timeout: o.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not json */
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            setCookies: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

/** Raw TCP: send exact bytes (malformed requests the http client refuses to build). */
export const rawRequest = (
  port: number,
  bytes: string | Buffer,
  opts: { from?: string; waitMs?: number } = {},
): Promise<string> =>
  new Promise((resolve) => {
    const sock = net.connect({
      host: '127.0.0.1',
      port,
      ...(opts.from ? { localAddress: opts.from } : {}),
    });
    let data = '';
    const done = () => {
      sock.destroy();
      resolve(data);
    };
    sock.on('data', (d) => (data += d.toString('latin1')));
    sock.on('error', done);
    sock.on('close', done);
    sock.on('connect', () => sock.write(bytes));
    setTimeout(done, opts.waitMs ?? 1_500).unref();
  });

export const statusOfRaw = (response: string): number =>
  Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1] ?? 0);

export const sessionCookie = (res: Res, name = 'hd_session'): string | undefined => {
  const line = res.setCookies.find((c) => c.startsWith(`${name}=`));
  const value = line?.split(';')[0]?.slice(name.length + 1);
  return value ? `${name}=${value}` : undefined;
};

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const PASSWORDS = {
  customer: 'Customer#test1',
  agent: 'Agent#test1',
  lead: 'Lead#test1',
} as const;

export type TestUsers = Record<
  'customer' | 'customer2' | 'agent' | 'agent2' | 'lead' | 'disabled',
  { id: string; email: string }
>;

/** A few real accounts with real argon2 hashes (the seeded 20 000 tickets are irrelevant to security tests). */
export const createUsers = async (db: Db): Promise<TestUsers> => {
  const hashes = {
    customer: await hashPassword(PASSWORDS.customer),
    agent: await hashPassword(PASSWORDS.agent),
    lead: await hashPassword(PASSWORDS.lead),
  };
  const make = async (
    email: string,
    name: string,
    role: 'customer' | 'agent' | 'lead',
    hash: string,
    disabled = false,
  ) => {
    const [row] = await db
      .insert(users)
      .values({ email, name, role, passwordHash: hash, disabled })
      .returning({ id: users.id });
    if (!row) throw new Error('user insert failed');
    return { id: row.id, email };
  };
  const agent = await make('agent@t.test', 'Agent One', 'agent', hashes.agent);
  const agent2 = await make('agent2@t.test', 'Agent Two', 'agent', hashes.agent);
  await db.insert(agentCategories).values([
    { userId: agent.id, category: 'payment' },
    { userId: agent2.id, category: 'delivery' },
  ]);
  return {
    customer: await make('customer@t.test', 'Customer One', 'customer', hashes.customer),
    customer2: await make('customer2@t.test', 'Customer Two', 'customer', hashes.customer),
    agent,
    agent2,
    lead: await make('lead@t.test', 'The Lead', 'lead', hashes.lead),
    disabled: await make('disabled@t.test', 'Gone', 'customer', hashes.customer, true),
  };
};

export const login = (
  api: Pick<Api, 'port'>,
  email: string,
  password: string,
  from?: string,
  extra: Partial<ReqOpts> = {},
) =>
  request(api, {
    method: 'POST',
    path: '/auth/login',
    body: { email, password },
    ...(from ? { from } : {}),
    ...extra,
  });

export const pct = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

/** Runs `fn(i)` for i in [0,n) with at most `concurrency` in flight. */
export const pool = async <T>(
  n: number,
  concurrency: number,
  fn: (i: number) => Promise<T>,
): Promise<T[]> => {
  const out: T[] = new Array<T>(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, n) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
};

/* ---------------------------------------------------------------- domain helpers */

export type Session = { cookie: string; user: { id: string; email: string; role: string } };

export const signIn = async (
  api: Pick<Api, 'port'>,
  email: string,
  password: string,
  from?: string,
): Promise<Session> => {
  const r = await login(api, email, password, from);
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return { cookie: sessionCookie(r)!, user: (r.json as { user: Session['user'] }).user };
};

/** `as(session).get('/tickets')` — authenticated calls with a terse API. */
export const as = (api: Pick<Api, 'port'>, s: Session, from?: string) => {
  const call = (method: string, path: string, body?: object, headers?: Record<string, string>) =>
    request(api, {
      method,
      path,
      cookie: s.cookie,
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
      ...(from ? { from } : {}),
    });
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body: object = {}) => call('POST', path, body),
    patch: (path: string, body: object) => call('PATCH', path, body),
    put: (path: string, body: object) => call('PUT', path, body),
    del: (path: string) => call('DELETE', path),
    delete: (path: string) => call('DELETE', path),
  };
};

export type TicketJson = {
  id: string;
  number: number;
  code: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  customer: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  tags: string[];
  version: number;
  linkedTicketId: string | null;
  unread: boolean;
  sla: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export const newTicketBody = (over: Record<string, unknown> = {}) => ({
  subject: 'Cannot pay by card',
  category: 'payment',
  priority: 'normal',
  body: 'Payment fails at checkout',
  attachmentIds: [] as string[],
  clientMessageId: crypto.randomUUID(),
  ...over,
});

export const createTicketAs = async (
  api: Pick<Api, 'port'>,
  s: Session,
  over: Record<string, unknown> = {},
): Promise<TicketJson> => {
  const r = await as(api, s).post('/tickets', newTicketBody(over));
  if (r.status !== 201) throw new Error(`create ticket failed: ${r.status} ${r.text}`);
  return r.json as TicketJson;
};

export const reply = (body: string, over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  body,
  ...over,
});

/** Same body for any "not there" answer: a foreign ticket and a non-existent one must be indistinguishable. */
export const errorShape = (r: Res): string => {
  const e = (r.json as { error?: Record<string, unknown> } | null)?.error ?? {};
  return JSON.stringify({ status: r.status, code: e.code, message: e.message });
};

export const createExtraAgents = async (
  db: Db,
  n: number,
  categories: string[],
): Promise<Array<{ id: string; email: string }>> => {
  const hash = await hashPassword(PASSWORDS.agent);
  const out: Array<{ id: string; email: string }> = [];
  for (let i = 0; i < n; i += 1) {
    const email = `extra-agent-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const [row] = await db
      .insert(users)
      .values({ email, name: `Extra Agent ${i}`, role: 'agent', passwordHash: hash })
      .returning({ id: users.id });
    if (!row) throw new Error('agent insert failed');
    await db
      .insert(agentCategories)
      .values(categories.map((category) => ({ userId: row.id, category })));
    out.push({ id: row.id, email });
  }
  return out;
};

/* ---------------------------------------------------------------- uploads */

export type Part = { name: string; filename?: string; contentType?: string; data: Buffer | string };

export const multipart = (
  parts: Part[],
  boundary = 'xBoUnDaRyx',
): { body: Buffer; contentType: string } => {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `Content-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n${disp}\r\n${p.contentType ? `Content-Type: ${p.contentType}\r\n` : ''}\r\n`,
      ),
      Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
};

export const upload = (
  api: Pick<Api, 'port'>,
  s: Session,
  file: { name: string; data: Buffer | string; contentType?: string },
  from?: string,
) => {
  const m = multipart([
    {
      name: 'file',
      filename: file.name,
      contentType: file.contentType ?? 'application/octet-stream',
      data: file.data,
    },
  ]);
  return request(api, {
    method: 'POST',
    path: '/attachments',
    body: m.body,
    headers: { 'content-type': m.contentType },
    cookie: s.cookie,
    ...(from ? { from } : {}),
  });
};

/** A small but structurally valid PDF: header, two objects, a classic xref table whose offsets are exact, trailer. */
export const makePdf = (extra = ''): Buffer => {
  const header = '%PDF-1.7\n';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [] /Count 0 ${extra}>>\nendobj\n`,
  ];
  let body = header;
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xrefAt = body.length;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${pad(o, 10)} 00000 n \n`).join('');
  return Buffer.from(
    `${body}${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'latin1',
  );
};

export const FILES = {
  // minimal but REAL files: uploads are decoded and re-encoded (images) / parsed (PDF), so fakes are refused
  png: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4ISeHFTEMLQkAkL9BAbKfPiIAAAAASUVORK5CYII=',
    'base64',
  ),
  jpeg: Buffer.from(
    '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAAHlhf//Z',
    'base64',
  ),
  gif: Buffer.from('R0lGODlhCAAIAIAAAExpccgeHiH5BAUAAAAALAAAAAAIAAgAAAIHjI+py+1dAAA7', 'base64'),
  webp: Buffer.from(
    'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAgAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA',
    'base64',
  ),
  pdf: makePdf(),
  text: Buffer.from('Hello, звіт №1 — plain text\nline two\n'),
  exe: Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(62),
    Buffer.from('PE\0\0 This program cannot be run in DOS mode.'),
  ]),
  elf: Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(40, 1)]),
  zip: Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4]), Buffer.alloc(40)]),
  html: Buffer.from('<html><script>alert(1)</script></html>'),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  shell: Buffer.from('#!/bin/sh\nrm -rf /\n\u0000'),
} as const;

/** A tiny SSE client: collects frames; `waitFor` resolves when a matching event arrives. */
export type SseFrame = { id: string | null; event: string; data: Record<string, unknown> };
export const openEvents = (
  api: Pick<Api, 'port'>,
  s: Session,
  opts: { from?: string; lastEventId?: string; cookie?: string; path?: string } = {},
) =>
  new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    frames: SseFrame[];
    raw: () => string;
    close: () => void;
    ended: Promise<void>;
    waitFor: (pred: (f: SseFrame) => boolean, ms?: number) => Promise<SseFrame>;
  }>((resolve, reject) => {
    const frames: SseFrame[] = [];
    let raw = '';
    const waiters: Array<{ pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];
    const req = http.request(
      {
        host: '127.0.0.1',
        port: api.port,
        path: opts.path ?? '/events',
        method: 'GET',
        agent: false,
        ...(opts.from ? { localAddress: opts.from } : {}),
        headers: {
          cookie: opts.cookie ?? s.cookie,
          accept: 'text/event-stream',
          ...(opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {}),
        },
      },
      (res) => {
        let buf = '';
        const ended = new Promise<void>((r) => {
          res.on('close', () => r());
          res.on('end', () => r());
        });
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const lines = block.split('\n');
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
            const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
            if (!event || !data) continue;
            const f: SseFrame = {
              id: lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null,
              event,
              data: JSON.parse(data) as Record<string, unknown>,
            };
            frames.push(f);
            for (const w of [...waiters])
              if (w.pred(f)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(f);
              }
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          frames,
          raw: () => raw,
          ended,
          close: () => req.destroy(),
          waitFor: (pred, ms = 5_000) =>
            new Promise<SseFrame>((res2, rej) => {
              const hit = frames.find(pred);
              if (hit) return res2(hit);
              const t = setTimeout(
                () =>
                  rej(
                    new Error(
                      `no matching SSE event within ${ms} ms; got: ${JSON.stringify(frames.map((f) => f.event))}`,
                    ),
                  ),
                ms,
              );
              waiters.push({
                pred,
                resolve: (f) => {
                  clearTimeout(t);
                  res2(f);
                },
              });
            }),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
