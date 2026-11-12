import { readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import { contentDisposition, sanitizeFilename, sniffMime } from '../src/attachments/sniff';
import {
  FILES,
  PASSWORDS,
  as,
  createTicketAs,
  createUsers,
  multipart,
  rawRequest,
  reply,
  request,
  sha256,
  signIn,
  startApi,
  upload,
  type Api,
  type Session,
  type TestUsers,
  type TicketJson,
} from './harness';

describe('sniffMime / sanitizeFilename / contentDisposition (pure)', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['pdf', 'application/pdf'],
    ['text', 'text/plain'],
  ] as const)('%s is recognised by its content', (k, mime) => {
    expect(sniffMime(FILES[k])).toBe(mime);
  });
  it.each(['exe', 'elf', 'zip', 'shell'] as const)('%s is refused', (k) =>
    expect(sniffMime(FILES[k])).toBeNull(),
  );
  it('HTML and SVG are, byte for byte, valid UTF-8 text: they are accepted ONLY as inert text/plain', () => {
    expect(sniffMime(FILES.html)).toBe('text/plain');
    expect(sniffMime(FILES.svg)).toBe('text/plain');
  });
  it('refuses empty files, NUL bytes, invalid UTF-8 and control characters, accepts BOM / tabs / CRLF text', () => {
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
    expect(sniffMime(Buffer.from('ab\u0000cd'))).toBeNull();
    expect(sniffMime(Buffer.from([0xff, 0xfe, 0xfd, 0x41]))).toBeNull();
    expect(sniffMime(Buffer.from('bell\u0007'))).toBeNull();
    expect(sniffMime(Buffer.from('﻿col1\tcol2\r\nx\ty\r\n'))).toBe('text/plain');
  });
  it('a magic number must be at the START: a PNG signature later in the file does not make it a PNG', () => {
    expect(sniffMime(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(10), FILES.png]))).toBeNull();
    expect(
      sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])),
    ).toBeNull(); // RIFF but not WEBP
  });
  it('filenames: directories, control characters and bidi overrides are stripped; length bounded; never empty', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFilename('a\u0000b\r\nc.png')).toBe('abc.png');
    expect(sanitizeFilename('photo‮gnp.exe')).toBe('photognp.exe'); // RLO cannot disguise the real extension
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('   ')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('x'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename('x'.repeat(500) + '.pdf').endsWith('.pdf')).toBe(true);
    expect(sanitizeFilename('звіт №1.pdf')).toBe('звіт №1.pdf');
  });
  it('Content-Disposition cannot be broken out of (quotes, newlines, semicolons) and carries the UTF-8 name', () => {
    const d = contentDisposition('attachment', 'a";b\r\nSet-Cookie: x=1.png');
    expect(d).not.toMatch(/[\r\n]/);
    expect(d.match(/"/g)?.length).toBe(2);
    expect(contentDisposition('inline', 'звіт.png')).toContain(
      "filename*=UTF-8''%D0%B7%D0%B2%D1%96%D1%82.png",
    );
  });
});

describe('attachments (real server, real PostgreSQL, real disk)', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, customer2: Session, agent: Session, agent2: Session, lead: Session;
  const filesOnDisk = () => readdirSync(api.uploadsDir).filter((n) => !n.startsWith('.tmp-'));
  const allOnDisk = () => readdirSync(api.uploadsDir);
  const rows = async () =>
    Number(
      (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM attachments`)).rows[0]?.n,
    );

  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '1000000',
      RATE_LIMIT_USER_PER_MIN: '1000000',
      UPLOAD_PER_MIN: '10000',
      UPLOAD_MAX_PENDING: '1000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
    [customer, customer2, agent, agent2, lead] = await Promise.all([
      signIn(api, u.customer.email, PASSWORDS.customer),
      signIn(api, u.customer2.email, PASSWORDS.customer),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.agent2.email, PASSWORDS.agent),
      signIn(api, u.lead.email, PASSWORDS.lead),
    ]);
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });

  describe('what may be uploaded (acceptance #14)', () => {
    it.each([
      ['png', 'image/png', 'a.png'],
      ['jpeg', 'image/jpeg', 'b.jpg'],
      ['gif', 'image/gif', 'c.gif'],
      ['webp', 'image/webp', 'd.webp'],
      ['pdf', 'application/pdf', 'e.pdf'],
      ['text', 'text/plain', 'f.txt'],
    ] as const)('%s → stored as %s', async (k, mime, name) => {
      const r = await upload(api, customer, { name, data: FILES[k] });
      expect(r.status, r.text).toBe(201);
      expect(r.json).toMatchObject({ name, mime, sizeBytes: FILES[k].length });
    });
    it('the type comes from the CONTENT and the name must agree: an .exe named .png is refused, a PNG named .exe is refused too', async () => {
      const bad = await upload(api, customer, {
        name: 'totally-not.exe',
        data: FILES.png,
        contentType: 'application/x-msdownload',
      });
      expect(bad.status).toBe(415);
      const before = await rows();
      const bad2 = await upload(api, customer, {
        name: 'holiday.png',
        data: FILES.exe,
        contentType: 'image/png',
      });
      expect(bad2.status).toBe(415);
      expect(bad2.json).toMatchObject({ error: { code: 'unsupported_media_type' } });
      expect(await rows()).toBe(before);
      expect(allOnDisk().length).toBe(filesOnDisk().length); // and nothing half-written is left behind
    });
    it('a valid signature glued to executable bytes is refused: PNG header + PE, %PDF- prefix + PE, PNG with a payload after IEND', async () => {
      const pe = FILES.exe;
      const cases: Array<[string, string, Buffer]> = [
        ['png+pe', 'x.png', Buffer.concat([FILES.png.subarray(0, 8), pe])],
        ['pdf+pe', 'x.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), pe])],
        ['png+trailer', 'x.png', Buffer.concat([FILES.png, pe])],
        ['gif header only', 'x.gif', Buffer.concat([Buffer.from('GIF89a'), pe])],
        ['jpeg header + pe', 'x.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pe])],
      ];
      const before = await rows();
      for (const [label, name, data] of cases) {
        const r = await upload(api, customer, { name, data });
        expect(r.status, label).toBe(415);
      }
      expect(await rows()).toBe(before);
    });
    it('the name must agree with the content: run.bat / a.html / evil.exe are refused, a name without extension gets one', async () => {
      for (const name of ['run.bat', 'a.html', 'evil.exe', 'x.png']) {
        const r = await upload(api, customer, { name, data: Buffer.from('echo hello\n') });
        expect(r.status, name).toBe(415);
      }
      const noExt = await upload(api, customer, { name: 'screenshot', data: FILES.png });
      expect(noExt.status).toBe(201);
      expect((noExt.json as { name: string }).name).toBe('screenshot.png');
      const upper = await upload(api, customer, { name: 'PHOTO.JPG', data: FILES.jpeg });
      expect(upper.status).toBe(201);
    });
    it.each(['elf', 'zip', 'shell'] as const)(
      '%s is refused even with a friendly name and content type',
      async (k) => {
        const r = await upload(api, customer, {
          name: 'cute.png',
          data: FILES[k],
          contentType: 'image/png',
        });
        expect(r.status).toBe(415);
      },
    );
    it('named .html/.svg they are refused; as .txt, HTML/SVG is stored as text/plain and served as an inert download', async () => {
      for (const [name, data] of [
        ['page.html', FILES.html],
        ['pic.svg', FILES.svg],
      ] as const) {
        expect((await upload(api, customer, { name, data })).status, name).toBe(415);
      }
      for (const [name, data] of [
        ['page.txt', FILES.html],
        ['pic.txt', FILES.svg],
      ] as const) {
        const up = await upload(api, customer, { name, data, contentType: 'text/html' });
        expect(up.status).toBe(201);
        expect(up.json).toMatchObject({ mime: 'text/plain' });
        const dl = await request(api, {
          path: `/attachments/${(up.json as { id: string }).id}`,
          cookie: customer.cookie,
        });
        expect(dl.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
        expect(dl.headers['x-content-type-options']).toBe('nosniff');
        expect(dl.headers['content-security-policy']).toContain('sandbox');
      }
    });
    it('empty files → 400', async () => {
      expect((await upload(api, customer, { name: 'e.txt', data: Buffer.alloc(0) })).status).toBe(
        400,
      );
    });
    it('size limit: exactly 10 MB is accepted, 10 MB + 1 byte is 413 and leaves nothing on disk or in the database (acceptance #14)', async () => {
      const ten = Buffer.alloc(10 * 1024 * 1024, 0x61);
      const ok = await upload(api, customer, { name: 'big.txt', data: ten });
      expect(ok.status, ok.text.slice(0, 200)).toBe(201);
      const before = { rows: await rows(), files: allOnDisk().length };
      const tooBig = await upload(api, customer, {
        name: 'bigger.txt',
        data: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      });
      expect(tooBig.status).toBe(413);
      const eleven = await upload(api, customer, {
        name: '11mb.png',
        data: Buffer.concat([FILES.png, Buffer.alloc(11 * 1024 * 1024)]),
      });
      expect(eleven.status).toBe(413);
      expect({ rows: await rows(), files: allOnDisk().length }).toEqual(before);
    }, 60_000);
    it('a body of 200 MB without a Content-Length (chunked) is cut off after the limit — never buffered, never stored', async () => {
      const before = { rows: await rows(), files: allOnDisk().length };
      const status = await new Promise<number>((resolve) => {
        // Node's own chunked encoder: no Content-Length, a valid multipart opening, then an endless file body
        const req = http.request(
          {
            host: '127.0.0.1',
            port: api.port,
            method: 'POST',
            path: '/attachments',
            agent: false,
            headers: {
              cookie: customer.cookie,
              'content-type': 'multipart/form-data; boundary=zz',
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', () => resolve(0));
        req.write(
          '--zz\r\nContent-Disposition: form-data; name="file"; filename="huge.txt"\r\n\r\n',
        );
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 200 && !req.destroyed) {
            sent += 1;
            if (!req.write(chunk)) return void req.once('drain', pump);
          }
          req.end();
        };
        pump();
        setTimeout(() => resolve(-1), 20_000).unref();
      });
      expect([0, 413]).toContain(status); // 413, or the server closed the connection on us (never 201, never 5xx)
      expect({ rows: await rows(), files: allOnDisk().length }).toEqual(before);
      expect((await request(api, { path: '/ready' })).status).toBe(200);
    }, 60_000);
  });

  describe('malformed / abusive multipart → 4xx, no files, no rows', () => {
    const post = (body: Buffer | string, contentType: string, s = customer) =>
      request(api, {
        method: 'POST',
        path: '/attachments',
        body,
        headers: { 'content-type': contentType },
        cookie: s.cookie,
      });
    it('rejects non-multipart content types and a missing boundary', async () => {
      for (const ct of [
        'application/json',
        'text/plain',
        'multipart/form-data',
        'multipart/form-data; boundary=',
        'application/x-www-form-urlencoded',
      ]) {
        const r = await post('{"file":"x"}', ct);
        expect([400, 415], ct).toContain(r.status);
      }
    });
    it('rejects: two files, an extra text field, a wrong field name, a text value instead of a file, garbage, truncated body', async () => {
      const cases: Array<[string, Buffer, string]> = [];
      let m = multipart([
        { name: 'file', filename: 'a.png', data: FILES.png },
        { name: 'file', filename: 'b.png', data: FILES.png },
      ]);
      cases.push(['two files', m.body, m.contentType]);
      m = multipart([
        { name: 'file', filename: 'a.png', data: FILES.png },
        { name: 'note', data: 'hello' },
      ]);
      cases.push(['extra field', m.body, m.contentType]);
      m = multipart([{ name: 'upload', filename: 'a.png', data: FILES.png }]);
      cases.push(['wrong field name', m.body, m.contentType]);
      m = multipart([{ name: 'file', data: 'just text, no filename' }]);
      cases.push(['text instead of file', m.body, m.contentType]);
      m = multipart([]);
      cases.push(['no parts', m.body, m.contentType]);
      cases.push([
        'garbage',
        Buffer.from('this is not multipart at all'),
        'multipart/form-data; boundary=xBoUnDaRyx',
      ]);
      const full = multipart([{ name: 'file', filename: 'a.png', data: FILES.png }]);
      cases.push(['truncated', full.body.subarray(0, 60), full.contentType]);
      cases.push([
        '1000 tiny parts',
        multipart(Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, data: 'x' }))).body,
        full.contentType,
      ]);
      const before = { rows: await rows(), files: allOnDisk().length };
      for (const [name, body, ct] of cases) {
        const r = await post(body, ct);
        expect(r.status, `${name}: ${r.text.slice(0, 120)}`).toBeGreaterThanOrEqual(400);
        expect(r.status, name).toBeLessThan(500);
      }
      expect({ rows: await rows(), files: allOnDisk().length }).toEqual(before);
    });
    it('a client that aborts mid-upload leaves nothing behind', async () => {
      const before = { rows: await rows(), files: allOnDisk().length };
      await rawRequest(
        api.port,
        `POST /attachments HTTP/1.1\r\nHost: x\r\nCookie: ${customer.cookie}\r\nContent-Type: multipart/form-data; boundary=xBoUnDaRyx\r\nContent-Length: 5000000\r\n\r\n--xBoUnDaRyx\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n${FILES.png.toString('latin1')}`,
        { waitMs: 400 },
      );
      await new Promise((r) => setTimeout(r, 300));
      expect({ rows: await rows(), files: allOnDisk().length }).toEqual(before);
    });
    it('anonymous uploads are refused', async () => {
      const m = multipart([{ name: 'file', filename: 'a.png', data: FILES.png }]);
      expect(
        (
          await request(api, {
            method: 'POST',
            path: '/attachments',
            body: m.body,
            headers: { 'content-type': m.contentType },
          })
        ).status,
      ).toBe(401);
    });
  });

  describe('file names cannot touch the disk', () => {
    it.each([
      '../../../../tmp/pwn.png',
      '..\\..\\pwn.png',
      '/etc/passwd',
      'a\u0000.png',
      'x'.repeat(400) + '.png',
      '.htaccess',
      'con.png',
      '‮gnp.png', // RLO cannot disguise the real extension
    ])('%j', async (name) => {
      const before = new Set(allOnDisk());
      const r = await upload(api, customer, { name, data: FILES.png });
      expect(r.status, r.text).toBe(201);
      const created = allOnDisk().filter((n) => !before.has(n));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^[0-9a-f-]{36}$/); // a random key, never derived from the name
      const stored = (r.json as { name: string }).name;
      // eslint-disable-next-line no-control-regex -- asserting no control characters survive
      expect(stored).not.toMatch(/[\\/\u0000‮]/);
      expect(statSyncSize(api.uploadsDir, created[0]!)).toBe(FILES.png.length);
    });
  });

  describe('access control on download (acceptance #4 and #5)', () => {
    let ticket: TicketJson; // customer's, payment → agent sees it, agent2 does not
    let publicAtt: string, noteAtt: string, unsent: string;
    const get = (s: Session | null, id: string) =>
      request(api, { path: `/attachments/${id}`, ...(s ? { cookie: s.cookie } : {}) });
    const up = async (s: Session, data: Buffer, name: string) =>
      ((await upload(api, s, { name, data })).json as { id: string }).id;

    beforeAll(async () => {
      ticket = await createTicketAs(api, customer, { category: 'payment', subject: 'files' });
      const a = await up(customer, FILES.png, 'customer-photo.png');
      expect(
        (
          await as(api, customer).post(
            `/tickets/${ticket.id}/messages`,
            reply('see attached', { attachmentIds: [a] }),
          )
        ).status,
      ).toBe(201);
      publicAtt = await up(agent, FILES.pdf, 'invoice.pdf');
      expect(
        (
          await as(api, agent).post(
            `/tickets/${ticket.id}/messages`,
            reply('here is the invoice', { attachmentIds: [publicAtt] }),
          )
        ).status,
      ).toBe(201);
      noteAtt = await up(agent, FILES.text, 'internal-log.txt');
      expect(
        (
          await as(api, agent).post(
            `/tickets/${ticket.id}/messages`,
            reply('INTERNAL: see log', { kind: 'internal', attachmentIds: [noteAtt] }),
          )
        ).status,
      ).toBe(201);
      unsent = await up(customer, FILES.text, 'draft.txt');
    });

    it('the ticket owner, an agent of the category and the lead can download a PUBLIC attachment; the bytes are identical', async () => {
      for (const s of [customer, agent, lead]) {
        const r = await get(s, publicAtt);
        expect(r.status, s.user.role).toBe(200);
        expect(sha256(r.text.length ? r.text : '')).toBeDefined();
      }
      const raw = await new Promise<Buffer>((resolve, reject) => {
        void import('node:http').then((http) =>
          http.get(
            {
              host: '127.0.0.1',
              port: api.port,
              path: `/attachments/${publicAtt}`,
              headers: { cookie: customer.cookie },
              agent: false,
            },
            (res) => {
              const c: Buffer[] = [];
              res.on('data', (d: Buffer) => c.push(d));
              res.on('end', () => resolve(Buffer.concat(c)));
              res.on('error', reject);
            },
          ),
        );
      });
      expect(raw.equals(FILES.pdf)).toBe(true);
    });

    it('another customer and an agent of ANOTHER category get 404 — identical to a non-existent id', async () => {
      const missing = await get(customer2, crypto.randomUUID());
      for (const s of [customer2, agent2]) {
        for (const id of [publicAtt, noteAtt]) {
          const r = await get(s, id);
          expect(r.status, `${s.user.role} ${id}`).toBe(404);
          expect(r.text.replace(/"requestId":"[^"]+"/, '')).toBe(
            missing.text.replace(/"requestId":"[^"]+"/, ''),
          );
        }
      }
    });

    it('the attachment of an INTERNAL NOTE is invisible to the customer — direct request included — but staff can fetch it', async () => {
      expect((await get(customer, noteAtt)).status).toBe(404);
      expect((await get(agent, noteAtt)).status).toBe(200);
      expect((await get(lead, noteAtt)).status).toBe(200);
      const detail = await as(api, customer).get(`/tickets/${ticket.id}`);
      expect(detail.text).not.toContain(noteAtt);
      expect(detail.text).not.toContain('internal-log.txt');
    });

    it('an unsent upload can be fetched by its uploader only — not even by the lead', async () => {
      expect((await get(customer, unsent)).status).toBe(200);
      for (const s of [customer2, agent, lead])
        expect((await get(s, unsent)).status, s.user.role).toBe(404);
    });

    it('anonymous requests are 401; malformed ids are 400/404, never 5xx', async () => {
      expect((await get(null, publicAtt)).status).toBe(401);
      for (const bad of ['nope', '..%2f..%2fetc%2fpasswd', "1'%20OR%20'1", 'a'.repeat(3000)]) {
        const r = await request(api, { path: `/attachments/${bad}`, cookie: customer.cookie });
        expect(r.status, bad.slice(0, 30)).toBeLessThan(500);
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
    });

    it("moving the ticket out of an agent's reach also removes their access to its files", async () => {
      const t2 = await createTicketAs(api, customer, { category: 'payment', subject: 'moves' });
      const id = await up(customer, FILES.png, 'x.png');
      await as(api, customer).post(
        `/tickets/${t2.id}/messages`,
        reply('pic', { attachmentIds: [id] }),
      );
      expect((await get(agent, id)).status).toBe(200);
      await as(api, lead).patch(`/tickets/${t2.id}`, { version: t2.version, category: 'delivery' });
      expect((await get(agent, id)).status).toBe(404);
      expect((await get(agent2, id)).status).toBe(200);
    });

    it('response headers make the file inert: nosniff, exact type, forced download for PDF/text, sandbox CSP, no caching', async () => {
      const png = await get(customer, (await customerAttachments())[0]!);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.headers['content-disposition']).toMatch(/^inline;/);
      const pdf = await get(customer, publicAtt);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toMatch(/^attachment; filename="invoice.pdf"/);
      const txt = await get(customer, unsent);
      expect(txt.headers['content-type']).toBe('text/plain; charset=utf-8');
      for (const r of [png, pdf, txt]) {
        expect(r.headers['x-content-type-options']).toBe('nosniff');
        expect(r.headers['content-security-policy']).toContain('sandbox');
        expect(r.headers['cache-control']).toContain('no-store');
      }
    });
    const customerAttachments = async () =>
      (
        await t.db.execute<{ id: string }>(
          sql`SELECT id FROM attachments WHERE original_name = 'customer-photo.png'`,
        )
      ).rows.map((r) => r.id);
  });

  describe('attaching files to messages', () => {
    it('only your own, unsent files; each file goes on exactly one message; at most 5 per message', async () => {
      const tk = await createTicketAs(api, customer);
      const mine = (
        (await upload(api, customer, { name: 'm.png', data: FILES.png })).json as { id: string }
      ).id;
      const theirs = (
        (await upload(api, customer2, { name: 't.png', data: FILES.png })).json as { id: string }
      ).id;
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('x', { attachmentIds: [theirs] }),
          )
        ).status,
      ).toBe(400); // someone else's
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('x', { attachmentIds: [crypto.randomUUID()] }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('ok', { attachmentIds: [mine] }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('again', { attachmentIds: [mine] }),
          )
        ).status,
      ).toBe(400); // already used
      const six = await Promise.all(
        Array.from(
          { length: 6 },
          async () =>
            (
              (await upload(api, customer, { name: 's.png', data: FILES.png })).json as {
                id: string;
              }
            ).id,
        ),
      );
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('six', { attachmentIds: six }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('five', { attachmentIds: six.slice(0, 5) }),
          )
        ).status,
      ).toBe(201);
      // a failed send must not consume the files: the 6th is still free
      expect(
        (
          await as(api, customer).post(
            `/tickets/${tk.id}/messages`,
            reply('last', { attachmentIds: [six[5]!] }),
          )
        ).status,
      ).toBe(201);
    });
    it('an attachment can be sent with a new ticket (create) and shows up in the conversation', async () => {
      const id = (
        (await upload(api, customer, { name: 'first.png', data: FILES.png })).json as { id: string }
      ).id;
      const tk = await createTicketAs(api, customer, { attachmentIds: [id] });
      const d = (await as(api, customer).get(`/tickets/${tk.id}`)).json as {
        messages: Array<{ attachments: Array<{ id: string; name: string }> }>;
      };
      expect(d.messages[0]?.attachments).toMatchObject([{ id, name: 'first.png' }]);
    });
    it('the same attachment id raced onto two messages attaches to exactly one', async () => {
      const a = await createTicketAs(api, customer);
      const b = await createTicketAs(api, customer);
      const id = (
        (await upload(api, customer, { name: 'race.png', data: FILES.png })).json as { id: string }
      ).id;
      const rs = await Promise.all([
        as(api, customer).post(`/tickets/${a.id}/messages`, reply('a', { attachmentIds: [id] })),
        as(api, customer).post(`/tickets/${b.id}/messages`, reply('b', { attachmentIds: [id] })),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
    });
  });

  describe('upload abuse limits', () => {
    it('per-user upload rate and the number of unsent files are capped', async () => {
      const limited = await startApi(t.url, {
        UPLOAD_PER_MIN: '5',
        UPLOAD_MAX_PENDING: '4',
        RATE_LIMIT_API_PER_MIN: '100000',
        RATE_LIMIT_USER_PER_MIN: '100000',
        LOGIN_IP_MAX_FAILURES: '10000',
        LOGIN_PAIR_MAX_FAILURES: '1000',
      });
      try {
        const s = await signIn(limited, u.customer2.email, PASSWORDS.customer);
        await t.db.execute(sql`DELETE FROM attachments WHERE uploader_id = ${u.customer2.id}`);
        const statuses: number[] = [];
        for (let i = 0; i < 7; i += 1)
          statuses.push((await upload(limited, s, { name: `f${i}.png`, data: FILES.png })).status);
        expect(statuses).toEqual([201, 201, 201, 201, 429, 429, 429]); // pending cap (4) hit before the rate cap (5)
        expect(
          (
            await upload(limited, await signIn(limited, u.lead.email, PASSWORDS.lead), {
              name: 'other.png',
              data: FILES.png,
            })
          ).status,
        ).toBe(201); // others unaffected
      } finally {
        await limited.stop();
      }
    });
  });
});

const statSyncSize = (dir: string, name: string): number => statSync(`${dir}/${name}`).size;
