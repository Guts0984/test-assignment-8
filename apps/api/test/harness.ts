import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
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
