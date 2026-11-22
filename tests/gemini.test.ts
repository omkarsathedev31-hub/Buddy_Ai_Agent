import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-gemini-test-'));
process.env.BUDDY_DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.ADMIN_PASSCODE;

const { applyEnvFiles, normalizeApiKey, getGeminiKeyInfo, resolveEnvDirectory } = await import('../server/env.ts');
const { classifyGeminiError, generateBuddyReply } = await import('../server/ai.ts');
const { runGeminiDiagnostics } = await import('../server/ai-diagnostics.ts');
const { createApp } = await import('../server/app.ts');
const { resetDbForTests } = await import('../server/db.ts');

// ---------- Fake keys (never real) ----------
const KEY_GOOD = 'AIzaGOODKEYGOODKEYGOODKEYGOODKEYGOOD1';
const KEY_BAD = 'AIzaBADKEYBADKEYBADKEYBADKEYBADKEYBAD2';
const KEY_RESTRICTED = 'AIzaRESTRICTEDRESTRICTEDRESTRICTED3333';
const KEY_QUOTA = 'AIzaQUOTAQUOTAQUOTAQUOTAQUOTAQUOTA44';
const ALL_FAKE_KEYS = [KEY_GOOD, KEY_BAD, KEY_RESTRICTED, KEY_QUOTA];

// ---------- Mock Gemini server ----------
let missingModel = false;
const mock = http.createServer((req, res) => {
  let bodyText = '';
  req.on('data', (c) => (bodyText += c));
  req.on('end', () => handle(req, res, bodyText));
});

function handle(req: http.IncomingMessage, res: http.ServerResponse, bodyText: string) {
  const key = String(req.headers['x-goog-api-key'] ?? '');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (key === KEY_BAD) {
    return send(400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    });
  }
  if (key === KEY_RESTRICTED) {
    return send(403, {
      error: {
        code: 403,
        message: 'Requests to this API are blocked.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED' }],
      },
    });
  }
  const url = req.url ?? '';
  const isGenerate = req.method === 'POST' && url.includes(':generateContent');
  if (key === KEY_QUOTA && isGenerate) {
    return send(429, {
      error: {
        code: 429,
        message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
  }
  if (isGenerate) {
    // Echo what Gemini received, so tests can prove replies are not hardcoded and history is sent.
    let turns = 0;
    let lastText = '';
    try {
      const parsed = JSON.parse(bodyText) as { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> | string };
      if (Array.isArray(parsed.contents)) {
        turns = parsed.contents.length;
        lastText = parsed.contents[parsed.contents.length - 1]?.parts?.[0]?.text ?? '';
      }
    } catch {
      /* ignore */
    }
    return send(200, {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{ text: JSON.stringify({ reply: `ANSWER[turns=${turns}] ${lastText}`, suggestions: ['A follow-up?'] }) }],
          },
        },
      ],
    });
  }
  if (req.method === 'GET' && /\/models\/[^/?]+/.test(url.split('?')[0])) {
    if (missingModel) {
      return send(404, { error: { code: 404, message: 'models/x is not found for API version v1beta', status: 'NOT_FOUND' } });
    }
    return send(200, { name: 'models/gemini-4-hydrogen', supportedActions: ['generateContent'] });
  }
  if (req.method === 'GET' && url.split('?')[0].endsWith('/models')) {
    return send(200, { models: [{ name: 'models/gemini-4-hydrogen' }] });
  }
  return send(404, { error: { code: 404, message: 'unexpected route', status: 'NOT_FOUND' } });
}

let mockUrl = '';
let appServer: http.Server;
let baseUrl = '';
const logged: string[] = [];
const origWarn = console.warn;
const origError = console.error;
const origInfo = console.info;

test.before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  process.env.GOOGLE_GEMINI_BASE_URL = mockUrl;
  const capture = (...a: unknown[]) => logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.warn = capture;
  console.error = capture;
  console.info = capture;
  const app = createApp();
  await new Promise<void>((r) => {
    appServer = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
      r();
    });
  });
});

test.after(async () => {
  console.warn = origWarn;
  console.error = origError;
  console.info = origInfo;
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => mock.close(() => r()));
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ================= env loading =================
function envDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'env-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('env: a saved .env key beats a stale shell/OS key in development, reporting names only', () => {
  const cwd = envDir({ '.env': 'GEMINI_API_KEY="NEW_VALUE"\n' });
  const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'STALE_SHELL_VALUE' };
  const report = applyEnvFiles({ cwd, env, preferFiles: true });
  assert.equal(env.GEMINI_API_KEY, 'NEW_VALUE');
  assert.deepEqual(report.overridden, ['GEMINI_API_KEY']);
  assert.equal(report.sources.GEMINI_API_KEY, '.env');
  assert.ok(!JSON.stringify(report).includes('STALE_SHELL_VALUE') && !JSON.stringify(report).includes('NEW_VALUE'));
});

test('env: production/host environment keeps its own value and only flags the conflict', () => {
  const cwd = envDir({ '.env': 'GEMINI_API_KEY=FILE_VALUE\n' });
  const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'HOST_VALUE' };
  const report = applyEnvFiles({ cwd, env, preferFiles: false });
  assert.equal(env.GEMINI_API_KEY, 'HOST_VALUE');
  assert.deepEqual(report.conflicts, ['GEMINI_API_KEY']);
});

test('env: .env.local beats .env, but a placeholder in .env.local never masks a real .env key', () => {
  let cwd = envDir({ '.env': 'GEMINI_API_KEY=FROM_ENV\n', '.env.local': 'GEMINI_API_KEY=FROM_LOCAL\n' });
  let env: NodeJS.ProcessEnv = {};
  applyEnvFiles({ cwd, env, preferFiles: true });
  assert.equal(env.GEMINI_API_KEY, 'FROM_LOCAL');

  cwd = envDir({ '.env': 'GEMINI_API_KEY=FROM_ENV\n', '.env.local': 'GEMINI_API_KEY="your-gemini-api-key"\n' });
  env = {};
  applyEnvFiles({ cwd, env, preferFiles: true });
  assert.equal(env.GEMINI_API_KEY, 'FROM_ENV');
});

test('env: ordinary variables keep shell precedence; empty/placeholder inherited values never block files; BOM tolerated', () => {
  const cwd = envDir({ '.env': '\uFEFFGEMINI_API_KEY=REAL\nPORT=3000\nADMIN_PASSCODE=from-file\n' });
  const env: NodeJS.ProcessEnv = { PORT: '4000', GEMINI_API_KEY: '', ADMIN_PASSCODE: 'change-me' };
  applyEnvFiles({ cwd, env, preferFiles: true });
  assert.equal(env.PORT, '4000');
  assert.equal(env.GEMINI_API_KEY, 'REAL');
  assert.equal(env.ADMIN_PASSCODE, 'from-file');
});

test('env: pasted keys are normalized (quotes, prefix, whitespace, zero-width chars) and key info never exposes the key', () => {
  assert.equal(normalizeApiKey(`  "${KEY_GOOD}"\n`), KEY_GOOD);
  assert.equal(normalizeApiKey(`GEMINI_API_KEY=${KEY_GOOD}`), KEY_GOOD);
  assert.equal(normalizeApiKey(`Bearer ${KEY_GOOD}`), KEY_GOOD);
  assert.equal(normalizeApiKey(`\u200B${KEY_GOOD}\uFEFF`), KEY_GOOD);
  process.env.GEMINI_API_KEY = `"${KEY_GOOD}"`;
  const info = getGeminiKeyInfo();
  assert.equal(info.configured, true);
  assert.equal(info.formatIssue, null);
  assert.equal(info.length, KEY_GOOD.length);
  assert.ok(!JSON.stringify(info).includes(KEY_GOOD));
  process.env.GEMINI_API_KEY = 'AIzaPART1 AIzaPART2PADPADPADPADPAD';
  assert.match(getGeminiKeyInfo().formatIssue ?? '', /whitespace/);
  delete process.env.GEMINI_API_KEY;
});

test('env: .env is found from the project root even when the server is launched from another folder', () => {
  const root = envDir({ '.env': 'GEMINI_API_KEY=ROOT_VALUE\n' });
  const elsewhere = envDir({});
  assert.equal(resolveEnvDirectory([root, elsewhere]), root);
  // falls back to the launch folder only when the project root has no env file
  const emptyRoot = envDir({});
  const launch = envDir({ '.env': 'GEMINI_API_KEY=LAUNCH_VALUE\n' });
  assert.equal(resolveEnvDirectory([emptyRoot, launch]), launch);
  const env: NodeJS.ProcessEnv = {};
  applyEnvFiles({ cwd: resolveEnvDirectory([root, elsewhere]), env, preferFiles: true });
  assert.equal(env.GEMINI_API_KEY, 'ROOT_VALUE');
});

test('env: a shell-provided PLACEHOLDER or EMPTY key (e.g. injected by an IDE) never hides the real key in .env', () => {
  const cwd = envDir({ '.env': 'GEMINI_API_KEY=REAL_VALUE\n' });
  for (const inherited of ['MY_GEMINI_API_KEY', '', '   ', 'your-gemini-api-key']) {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: inherited };
    applyEnvFiles({ cwd, env, preferFiles: false });
    assert.equal(env.GEMINI_API_KEY, 'REAL_VALUE', `inherited=${JSON.stringify(inherited)}`);
  }
});

// ================= error classification =================
function apiErr(status: number, message: string, gStatus: string, reason?: string) {
  const err = new Error(
    JSON.stringify({
      error: {
        code: status,
        message,
        status: gStatus,
        details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : undefined,
      },
    })
  ) as Error & { status: number };
  err.name = 'ApiError';
  err.status = status;
  return err;
}

test('classification: distinct real-world Google failures get distinct, accurate results', () => {
  const m = 'gemini-4-hydrogen';
  const c = (e: Error) => classifyGeminiError(e, m);
  assert.equal(c(apiErr(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')).upstreamType, 'auth_error');
  assert.equal(c(apiErr(400, 'API key expired. Please renew the API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')).upstreamType, 'key_expired');
  assert.equal(c(apiErr(403, 'Your API key was reported as leaked.', 'PERMISSION_DENIED')).upstreamType, 'key_leaked');
  // project number containing "429" must NOT look like a rate limit
  const disabled = c(apiErr(403, 'Generative Language API has not been used in project 429123456 before or it is disabled.', 'PERMISSION_DENIED', 'SERVICE_DISABLED'));
  assert.equal(disabled.code, 'AI_PERMISSION_ERROR');
  assert.equal(disabled.upstreamType, 'service_disabled');
  assert.equal(c(apiErr(403, 'blocked', 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED')).upstreamType, 'key_restricted');
  assert.equal(c(apiErr(403, 'Permission denied: no access to model gemini-4-hydrogen.', 'PERMISSION_DENIED')).code, 'AI_MODEL_ERROR');
  assert.equal(c(apiErr(404, 'models/x is not found', 'NOT_FOUND')).code, 'AI_MODEL_ERROR');
  assert.equal(c(apiErr(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION')).upstreamType, 'location_unsupported');
  assert.equal(c(apiErr(400, 'Thinking level is not supported for this model.', 'INVALID_ARGUMENT')).code, 'AI_BAD_REQUEST');
  assert.equal(c(apiErr(429, 'Quota exceeded, limit: 0', 'RESOURCE_EXHAUSTED')).code, 'AI_QUOTA_EXHAUSTED');
  const withDetail = c(apiErr(403, 'x', 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED'));
  assert.equal(withDetail.upstreamStatus, 403);
  assert.equal(withDetail.geminiErrorCode, 'API_KEY_SERVICE_BLOCKED');
});

// ================= diagnostics against mock Gemini =================
test('diagnostic: healthy key passes every step and never contains the key', async () => {
  process.env.GEMINI_API_KEY = KEY_GOOD;
  const report = await runGeminiDiagnostics({ includeFingerprint: true });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(report.steps.map((s) => s.category), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(!JSON.stringify(report).includes(KEY_GOOD));
});

test('diagnostic: separates invalid key, restricted key, missing model and exhausted quota', async () => {
  process.env.GEMINI_API_KEY = KEY_BAD;
  let r = await runGeminiDiagnostics();
  assert.equal(r.steps.find((s) => s.id === 'auth')?.category, 'AI_AUTH_ERROR');
  assert.equal(r.steps.find((s) => s.id === 'model')?.category, 'skipped');

  process.env.GEMINI_API_KEY = KEY_RESTRICTED;
  r = await runGeminiDiagnostics();
  assert.equal(r.steps.find((s) => s.id === 'auth')?.category, 'AI_PERMISSION_ERROR');

  process.env.GEMINI_API_KEY = KEY_GOOD;
  missingModel = true;
  r = await runGeminiDiagnostics();
  missingModel = false;
  assert.equal(r.steps.find((s) => s.id === 'auth')?.ok, true);
  assert.equal(r.steps.find((s) => s.id === 'model')?.category, 'AI_MODEL_ERROR');

  process.env.GEMINI_API_KEY = KEY_QUOTA;
  r = await runGeminiDiagnostics();
  assert.equal(r.steps.find((s) => s.id === 'auth')?.ok, true);
  assert.equal(r.steps.find((s) => s.id === 'generate')?.category, 'AI_QUOTA_EXHAUSTED');

  delete process.env.GEMINI_API_KEY;
  r = await runGeminiDiagnostics();
  assert.equal(r.steps[0].category, 'MISSING_API_KEY');
  assert.ok(!JSON.stringify(r).includes('AIza'));
});

// ================= full login -> chat flow =================
async function api(urlPath: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'X-Requested-With': 'BuddyElderAI' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const raw = await res.text();
  return { status: res.status, raw, data: JSON.parse(raw) as Record<string, any>, cookie };
}

test('login, session and AI chat work end-to-end with a valid key; failures are precise and secret-free', async () => {
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Test Senior', email: 'gem@example.com', phone: '+919800000099', password: 'password123', role: 'senior', language: 'en' },
  });
  assert.equal(reg.status, 201);
  const cookie = reg.cookie!;
  assert.equal((await api('/api/auth/session', { cookie })).data.authenticated, true);

  const conv = await api('/api/ai/conversations', { method: 'POST', cookie, body: { title: 'Gemini test' } });
  const convId = conv.data.conversation.id as string;
  const send = () => api(`/api/ai/conversations/${convId}/messages`, { method: 'POST', cookie, body: { message: 'How do I restart my phone?', language: 'en' } });

  process.env.GEMINI_API_KEY = KEY_GOOD;
  let r = await send();
  assert.equal(r.status, 200, r.raw);
  assert.match(String(r.data.response), /^ANSWER\[turns=\d+\] How do I restart my phone\?/);

  // a DIFFERENT question gets a DIFFERENT answer (not hardcoded)
  const q2 = await api(`/api/ai/conversations/${convId}/messages`, { method: 'POST', cookie, body: { message: 'Is this SMS from my bank safe?', language: 'en' } });
  assert.equal(q2.status, 200, q2.raw);
  assert.notEqual(q2.data.response, r.data.response);
  assert.match(String(q2.data.response), /Is this SMS from my bank safe\?/);

  // a follow-up carries earlier turns to Gemini (context is kept)
  const turnsOf = (resp: unknown) => Number(/turns=(\d+)/.exec(String(resp))?.[1]);
  assert.ok(turnsOf(q2.data.response) > turnsOf(r.data.response), 'follow-up must include prior conversation history');

  // conversation is saved and can be reloaded (persistence)
  const saved = await api(`/api/ai/conversations/${convId}/messages`, { cookie });
  assert.equal(saved.status, 200);
  assert.ok((saved.data.messages as unknown[]).length >= 4);

  // a replaced (now invalid) key is reported as an auth problem with upstream detail, no secret
  process.env.GEMINI_API_KEY = KEY_BAD;
  r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'AI_AUTH_ERROR');
  assert.equal(r.data.upstreamStatus, 400);
  assert.equal(r.data.geminiErrorCode, 'API_KEY_INVALID');

  process.env.GEMINI_API_KEY = KEY_RESTRICTED;
  r = await send();
  assert.equal(r.data.code, 'AI_PERMISSION_ERROR');

  // swapping back to the good key works immediately (no stale client/key cached)
  process.env.GEMINI_API_KEY = KEY_GOOD;
  r = await send();
  assert.equal(r.status, 200);

  // diagnostic endpoint is admin-only
  assert.equal((await api('/api/ai/diagnose', { cookie })).status, 403);
  assert.equal((await api('/api/ai/diagnose')).status, 401);

  // no response body or server log line ever contains any key
  const everything = logged.join('\n') + r.raw;
  for (const k of ALL_FAKE_KEYS) assert.ok(!everything.includes(k), 'API key leaked');
});

test('scam checker still degrades to heuristics when Gemini rejects the key', async () => {
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Scam Tester', email: 'scam@example.com', phone: '+919800000098', password: 'password123', role: 'senior', language: 'en' },
  });
  process.env.GEMINI_API_KEY = KEY_BAD;
  const r = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: reg.cookie,
    body: { content: 'Your KYC will be blocked. Share OTP now', inputType: 'message', language: 'en' },
  });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.result?.source ?? r.data.source, 'heuristic_fallback');
  delete process.env.GEMINI_API_KEY;
});

test('generateBuddyReply uses the key currently in the environment on every call', async () => {
  process.env.GEMINI_API_KEY = KEY_BAD;
  await assert.rejects(() => generateBuddyReply({ history: [], userMessage: 'hi', language: 'en', userName: 'A' }), (e: any) => e.code === 'AI_AUTH_ERROR');
  process.env.GEMINI_API_KEY = KEY_GOOD;
  const ok = await generateBuddyReply({ history: [], userMessage: 'hi', language: 'en', userName: 'A' });
  assert.match(ok.reply, /^ANSWER\[turns=\d+\] hi/);
  delete process.env.GEMINI_API_KEY;
});
