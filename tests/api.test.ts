import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-elder-test-'));
const dbFile = path.join(tmpDir, 'test.db');
process.env.BUDDY_DB_PATH = dbFile;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.BUDDY_MESSAGING_NUMBER;
delete process.env.ADMIN_PASSCODE;

const { createApp } = await import('../server/app.ts');
const { resetDbForTests } = await import('../server/db.ts');

let server: http.Server;
let baseUrl: string;

test.before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(
  urlPath: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<{ status: number; data: Record<string, unknown>; setCookie?: string }> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'BuddyElderAI',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const rawCookie = res.headers.get('set-cookie');
  const cookiePair = rawCookie ? rawCookie.split(';')[0] : undefined;
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data, setCookie: cookiePair };
}

test('End-to-end auth, RBAC, permissions, safety, lessons, reminders, messaging & admin flows', async () => {
  // 1. Health & unauthenticated guard
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const unauthCheckins = await api('/api/checkins');
  assert.equal(unauthCheckins.status, 401);

  // 2. Register Senior & verify session persistence via cookie AND Bearer token (iframe fallback)
  const seniorReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Asha Deshmukh',
      email: 'asha@example.com',
      phone: '+919800000001',
      password: 'password123',
      role: 'senior',
      language: 'en',
    },
  });
  assert.equal(seniorReg.status, 201);
  assert.ok(seniorReg.setCookie);
  assert.ok(typeof seniorReg.data.token === 'string' && seniorReg.data.token.length > 10);
  const seniorCookie = seniorReg.setCookie!;
  const seniorBearer = seniorReg.data.token as string;

  // Verify PUT /api/settings works with Authorization Bearer token alone (no cookie)
  const bearerSettingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'BuddyElderAI',
      'Authorization': `Bearer ${seniorBearer}`,
    },
    body: JSON.stringify({ voice_enabled: true, voice_speed: 'normal', onboarding_completed: true }),
  });
  assert.equal(bearerSettingsRes.status, 200);

  // Reject unsafe/malformed phone numbers on register & settings; normalize formatted phone numbers
  const unsafePhoneReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Bad Phone User',
      email: 'badphone@example.com',
      phone: 'javascript:alert(1)',
      password: 'password123',
      role: 'senior',
    },
  });
  assert.equal(unsafePhoneReg.status, 400);

  const missingCodePhoneSettings = await api('/api/settings', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { phone: '9800000001' },
  });
  assert.equal(missingCodePhoneSettings.status, 400);

  const normalizedPhoneSettings = await api('/api/settings', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { phone: '+91 98000-00001' },
  });
  assert.equal(normalizedPhoneSettings.status, 200);
  assert.equal((normalizedPhoneSettings.data.user as Record<string, unknown>).phone, '+919800000001');

  const sessionCheck = await api('/api/auth/session', { cookie: seniorCookie });
  assert.equal(sessionCheck.status, 200);
  assert.equal(sessionCheck.data.authenticated, true);

  // Invalid login rejected
  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'asha@example.com', password: 'wrong' },
  });
  assert.equal(badLogin.status, 401);

  // Senior blocked from Admin routes
  const seniorAdminTry = await api('/api/admin/overview', { cookie: seniorCookie });
  assert.equal(seniorAdminTry.status, 403);

  // 3. Register Caregiver
  const cgReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Rohan Deshmukh',
      email: 'rohan@example.com',
      password: 'password123',
      role: 'caregiver',
    },
  });
  assert.equal(cgReg.status, 201);
  const cgCookie = cgReg.setCookie!;

  // 4. Missing ADMIN_PASSCODE returns explicit 503 error before claim/env config
  const missingAdminLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { passcode: 'Anything123' },
  });
  assert.equal(missingAdminLogin.status, 503);
  assert.equal(missingAdminLogin.data.code, 'ADMIN_PASSCODE_MISSING');

  // First-run Admin Claim + double-claim lock + non-admin email guard + messaging config
  const adminClaim = await api('/api/auth/admin/claim', {
    method: 'POST',
    body: { email: 'admin@example.com', name: 'Chief Admin', passcode: 'AdminPass#2026' },
  });
  assert.equal(adminClaim.status, 201);
  const adminCookie = adminClaim.setCookie!;

  const secondClaim = await api('/api/auth/admin/claim', {
    method: 'POST',
    body: { email: 'hacker@example.com', passcode: 'HackerPass123' },
  });
  assert.equal(secondClaim.status, 403);

  const nonAdminEmailAdminLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'asha@example.com', passcode: 'AdminPass#2026' },
  });
  assert.equal(nonAdminEmailAdminLogin.status, 403);

  const wrongAdminPassLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'admin@example.com', passcode: 'WrongPass' },
  });
  assert.equal(wrongAdminPassLogin.status, 401);

  const validAdminLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { email: 'admin@example.com', passcode: 'AdminPass#2026' },
  });
  assert.equal(validAdminLogin.status, 200);

  // Messaging number missing -> user_confirmed blocked with 503
  const missingMsgConfirm = await api('/api/messaging/onboarding', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { seniorPhone: '+919800000001', status: 'user_confirmed' },
  });
  assert.equal(missingMsgConfirm.status, 503);
  assert.equal(missingMsgConfirm.data.code, 'MESSAGING_NUMBER_MISSING');

  // Messaging number missing country code rejected with 400
  const badMsgNum = await api('/api/admin/messaging-config', {
    method: 'PUT',
    cookie: adminCookie,
    body: { messagingNumber: '9800000001' },
  });
  assert.equal(badMsgNum.status, 400);

  // Formatted number with country code is normalized to E.164
  const setMsgNum = await api('/api/admin/messaging-config', {
    method: 'PUT',
    cookie: adminCookie,
    body: { messagingNumber: '+1 (415) 523-8886' },
  });
  assert.equal(setMsgNum.status, 200);
  assert.equal(setMsgNum.data.configured, true);
  assert.equal(setMsgNum.data.number, '+14155238886');

  // 5. Daily Check-in + same-day duplicate handling + alert trigger
  const ci1 = await api('/api/checkins', {
    method: 'POST',
    cookie: seniorCookie,
    body: { mood: 'okay', medicationTaken: 'yes', needsHelp: false, feelsSafe: true, note: 'Morning check' },
  });
  assert.equal(ci1.status, 201);
  assert.equal(ci1.data.updated, false);

  const ci2 = await api('/api/checkins', {
    method: 'POST',
    cookie: seniorCookie,
    body: { mood: 'not_good', medicationTaken: 'yes', needsHelp: true, feelsSafe: true, note: 'Need help with phone' },
  });
  assert.equal(ci2.status, 200);
  assert.equal(ci2.data.updated, true);

  const ciHist = await api('/api/checkins', { cookie: seniorCookie });
  assert.equal((ciHist.data.history as unknown[]).length, 1);

  // 6. Permissions & Caregiver Linking (minimal hides check-in responses)
  const inviteRes = await api('/api/permissions/invite', {
    method: 'POST',
    cookie: seniorCookie,
    body: { relationship: 'Son', sharingLevel: 'minimal' },
  });
  assert.equal(inviteRes.status, 201);
  const inviteCode = inviteRes.data.inviteCode as string;
  const linkId = inviteRes.data.id as string;

  const linkRedeem = await api('/api/caregiver/link', {
    method: 'POST',
    cookie: cgCookie,
    body: { inviteCode },
  });
  assert.equal(linkRedeem.status, 200);

  const cgDashMinimal = await api('/api/caregiver/dashboard', { cookie: cgCookie });
  assert.equal(cgDashMinimal.status, 200);
  const seniorViewMin = (cgDashMinimal.data.seniors as Array<Record<string, unknown>>)[0];
  assert.equal(seniorViewMin.wellnessSummary, null);
  assert.equal((seniorViewMin.latestCheckIn as Record<string, unknown>).mood, undefined);

  // Caregiver requests Full sharing -> Senior approves -> Wellness summary visible
  const reqAccess = await api('/api/caregiver/permission-requests', {
    method: 'POST',
    cookie: cgCookie,
    body: { linkId, requestedLevel: 'full', reason: 'Help manage appointments' },
  });
  assert.equal(reqAccess.status, 201);

  const seniorApprove = await api(`/api/permissions/requests/${reqAccess.data.id}/respond`, {
    method: 'POST',
    cookie: seniorCookie,
    body: { decision: 'approved' },
  });
  assert.equal(seniorApprove.status, 200);

  const cgDashFull = await api('/api/caregiver/dashboard', { cookie: cgCookie });
  const seniorViewFull = (cgDashFull.data.seniors as Array<Record<string, unknown>>)[0];
  assert.ok(seniorViewFull.wellnessSummary);
  assert.equal((seniorViewFull.latestCheckIn as Record<string, unknown>).mood, 'not_good');

  // Verify PUT /api/permissions/links/:linkId strips arbitrary/unknown properties
  const sanitizePerms = await api(`/api/permissions/links/${linkId}`, {
    method: 'PUT',
    cookie: seniorCookie,
    body: {
      sharingLevel: 'full',
      permissions: {
        scam_alerts: true,
        injectedAdminFlag: true,
        __proto__Test: 'malicious',
      },
    },
  });
  assert.equal(sanitizePerms.status, 200);
  const returnedPerms = sanitizePerms.data.permissions as Record<string, unknown>;
  assert.equal(returnedPerms.scam_alerts, true);
  assert.equal('injectedAdminFlag' in returnedPerms, false);
  assert.equal('__proto__Test' in returnedPerms, false);

  const permListAfter = await api('/api/permissions', { cookie: seniorCookie });
  assert.equal(permListAfter.status, 200);
  const storedLinkPerms = ((permListAfter.data.links as Array<Record<string, unknown>>)[0].permissions) as Record<string, unknown>;
  assert.equal('injectedAdminFlag' in storedLinkPerms, false);

  // 7. Scam Detection (Screenshot EMAIL case, SMS, WhatsApp, URL, Phone, Safe GREEN, Empty 400 & History)
  const emptyScam = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: { inputType: 'email', content: '   ' },
  });
  assert.equal(emptyScam.status, 400);
  assert.equal(emptyScam.data.success, false);
  assert.equal(emptyScam.data.code, 'INVALID_INPUT');

  const scamScreenshotEmail = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: {
      inputType: 'email',
      content: 'Your bank account will be blocked today.\nClick this link immediately to update your KYC.',
    },
  });
  assert.equal(scamScreenshotEmail.status, 200);
  assert.equal(scamScreenshotEmail.data.success, true);
  assert.equal(scamScreenshotEmail.data.riskLevel, 'RED');
  assert.equal(scamScreenshotEmail.data.risk_level, 'RED');
  assert.equal(scamScreenshotEmail.data.requiresPause, true);
  assert.equal(scamScreenshotEmail.data.persisted, true);
  assert.equal((scamScreenshotEmail.data.assessment as Record<string, unknown>).risk_level, 'RED');
  assert.ok(Array.isArray(scamScreenshotEmail.data.actions) && scamScreenshotEmail.data.actions.length > 0);
  assert.ok(String(scamScreenshotEmail.data.explanation).includes('EMAIL'));

  const scamRed = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: {
      inputType: 'sms',
      content: 'URGENT: Your bank KYC expired. Download AnyDesk and share your OTP immediately at bit.ly/kyc-now',
    },
  });
  assert.equal(scamRed.status, 200);
  assert.equal(scamRed.data.riskLevel, 'RED');
  assert.equal(scamRed.data.requiresPause, true);

  const scamWhatsapp = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: {
      inputType: 'whatsapp',
      content: 'Hi Mom, I lost my phone. Urgent transfer needed today, send money right now.',
    },
  });
  assert.equal(scamWhatsapp.status, 200);
  assert.equal(scamWhatsapp.data.riskLevel, 'RED');

  const scamUrl = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: {
      inputType: 'url',
      content: 'https://bank-kyc-verify-now.xyz/login',
    },
  });
  assert.equal(scamUrl.status, 200);
  assert.ok(scamUrl.data.riskLevel === 'YELLOW' || scamUrl.data.riskLevel === 'RED');

  const scamPhone = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: {
      inputType: 'phone',
      content: '+44 7911 123456',
    },
  });
  assert.equal(scamPhone.status, 200);
  assert.equal(scamPhone.data.riskLevel, 'YELLOW');

  const scamGreen = await api('/api/scam/analyze', {
    method: 'POST',
    cookie: seniorCookie,
    body: { inputType: 'sms', content: 'Hi Mom, coming over for tea at 5 PM!' },
  });
  assert.equal(scamGreen.status, 200);
  assert.equal(scamGreen.data.riskLevel, 'GREEN');
  assert.notEqual(scamGreen.data.explanation, scamScreenshotEmail.data.explanation);

  const scamHistory = await api('/api/scam/history', { cookie: seniorCookie });
  assert.equal(scamHistory.status, 200);
  assert.equal(scamHistory.data.success, true);
  assert.equal((scamHistory.data.assessments as unknown[]).length, 6);

  // 8. AI Buddy honest unconfigured 503 check + conversation list + unmatched /api 404 JSON check
  const unknownApi = await api('/api/nonexistent-endpoint');
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.data.error, 'API endpoint not found.');

  const convCreate = await api('/api/ai/conversations', {
    method: 'POST',
    cookie: seniorCookie,
    body: { language: 'en' },
  });
  assert.equal(convCreate.status, 201);
  const convObj = convCreate.data.conversation as Record<string, unknown>;
  const convId = convObj.id as string;
  assert.ok(typeof convObj.updated_at === 'string' && convObj.updated_at.length > 0);

  const convList = await api('/api/ai/conversations', { cookie: seniorCookie });
  assert.equal(convList.status, 200);
  assert.equal((convList.data.conversations as unknown[]).length, 1);

  const emptyAiSend = await api(`/api/ai/conversations/${convId}/messages`, {
    method: 'POST',
    cookie: seniorCookie,
    body: { message: '   ' },
  });
  assert.equal(emptyAiSend.status, 400);
  assert.equal(emptyAiSend.data.success, false);
  assert.equal(emptyAiSend.data.code, 'INVALID_INPUT');
  assert.equal((emptyAiSend.data.error as Record<string, unknown>).code, 'INVALID_INPUT');

  const missingConvSend = await api(`/api/ai/conversations/non-existent-conv-id/messages`, {
    method: 'POST',
    cookie: seniorCookie,
    body: { message: 'How do I connect Wi-Fi?' },
  });
  assert.equal(missingConvSend.status, 404);
  assert.equal(missingConvSend.data.success, false);
  assert.equal(missingConvSend.data.code, 'CONVERSATION_NOT_FOUND');

  const aiSend = await api(`/api/ai/conversations/${convId}/messages`, {
    method: 'POST',
    cookie: seniorCookie,
    body: { message: 'How do I send a photo on WhatsApp?' },
  });
  assert.equal(aiSend.status, 503);
  assert.equal(aiSend.data.success, false);
  assert.equal(aiSend.data.code, 'MISSING_API_KEY');
  assert.equal((aiSend.data.error as Record<string, unknown>).code, 'MISSING_API_KEY');

  // 9. Lessons Progress Persistence
  const lesSave = await api('/api/lessons/smartphone-basics/progress', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { completedSteps: [1, 2, 3], lastStep: 3, isCompleted: true },
  });
  assert.equal(lesSave.status, 200);
  assert.equal(lesSave.data.isCompleted, true);

  const lesGet = await api('/api/lessons', { cookie: seniorCookie });
  assert.equal(lesGet.data.completedCount, 1);

  // 10. Reminders create, fail + retry, acknowledge
  const seniorId = (seniorReg.data.user as Record<string, unknown>).id as string;
  const remCreate = await api('/api/reminders', {
    method: 'POST',
    cookie: cgCookie,
    body: {
      seniorId,
      category: 'water',
      title: 'Drink water',
      scheduledFor: new Date(Date.now() + 60000).toISOString(),
    },
  });
  assert.equal(remCreate.status, 201);
  const remId = (remCreate.data.reminder as Record<string, unknown>).id as string;

  const remFail = await api(`/api/reminders/${remId}/deliver`, {
    method: 'POST',
    cookie: cgCookie,
    body: { simulateFailure: true },
  });
  assert.equal((remFail.data.reminder as Record<string, unknown>).delivery_status, 'failed');
  assert.equal((remFail.data.reminder as Record<string, unknown>).retry_count, 1);

  const remRetry = await api(`/api/reminders/${remId}/deliver`, {
    method: 'POST',
    cookie: cgCookie,
    body: { simulateFailure: false },
  });
  assert.equal((remRetry.data.reminder as Record<string, unknown>).delivery_status, 'sent');

  const remAck = await api(`/api/reminders/${remId}/acknowledge`, {
    method: 'POST',
    cookie: seniorCookie,
  });
  assert.equal(remAck.status, 200);

  // 11. Messaging Onboarding strict senior-owned phone & CLI verification
  const spoofVerify = await api('/api/messaging/onboarding', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { status: 'backend_verified' },
  });
  assert.equal(spoofVerify.status, 403);

  const userConfirm = await api('/api/messaging/onboarding', {
    method: 'PUT',
    cookie: seniorCookie,
    body: { setupMode: 'caregiver_assisted', seniorPhone: '+919800000001', status: 'user_confirmed' },
  });
  assert.equal(userConfirm.status, 200);

  execFileSync('npx', ['tsx', 'scripts/messaging-cli.ts', 'verify-hello', '+919800000001'], {
    env: { ...process.env, BUDDY_DB_PATH: dbFile },
  });

  const msgAfterCli = await api('/api/messaging/onboarding', { cookie: seniorCookie });
  assert.equal((msgAfterCli.data.onboarding as Record<string, unknown>).status, 'backend_verified');

  // 12. Revoke caregiver access immediately blocks caregiver visibility
  const revokeRes = await api(`/api/permissions/links/${linkId}/revoke`, {
    method: 'POST',
    cookie: seniorCookie,
  });
  assert.equal(revokeRes.status, 200);

  const cgAfterRevoke = await api('/api/caregiver/dashboard', { cookie: cgCookie });
  assert.equal((cgAfterRevoke.data.seniors as unknown[]).length, 0);

  // 13. Logout invalidates session
  const logoutRes = await api('/api/auth/logout', { method: 'POST', cookie: seniorCookie });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await api('/api/auth/session', { cookie: seniorCookie });
  assert.equal(afterLogout.data.authenticated, false);

  // 14. Environment variable overrides for ADMIN_PASSCODE and BUDDY_MESSAGING_NUMBER
  process.env.ADMIN_PASSCODE = 'ServerEnvAdmin#99';
  process.env.BUDDY_MESSAGING_NUMBER = '+44 20 7946 0999';
  try {
    const envHealth = await api('/api/health');
    assert.equal(envHealth.status, 200);
    assert.equal((envHealth.data.messaging as Record<string, unknown>).configured, true);
    assert.equal((envHealth.data.messaging as Record<string, unknown>).number, '+442079460999');
    assert.equal((envHealth.data.adminSetup as Record<string, unknown>).hasEnvPasscode, true);

    const envAdminLogin = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: 'admin@example.com', passcode: 'ServerEnvAdmin#99' },
    });
    assert.equal(envAdminLogin.status, 200);

    // Invalid env messaging number yields explicit configuration error instead of crashing
    process.env.BUDDY_MESSAGING_NUMBER = 'not-a-phone';
    const invalidEnvHealth = await api('/api/health');
    assert.equal(invalidEnvHealth.status, 200);
    assert.equal((invalidEnvHealth.data.messaging as Record<string, unknown>).configured, false);
    assert.ok(String((invalidEnvHealth.data.messaging as Record<string, unknown>).error).includes('BUDDY_MESSAGING_NUMBER'));
  } finally {
    delete process.env.ADMIN_PASSCODE;
    delete process.env.BUDDY_MESSAGING_NUMBER;
  }

  // 15. Strict Origin-Allowlist CORS headers & preflight verification
  process.env.ALLOWED_ORIGINS = 'https://buddy-elder-ui.vercel.app';
  try {
    const allowedPreflight = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://buddy-elder-ui.vercel.app' },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://buddy-elder-ui.vercel.app');
    assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), 'true');

    const unlistedCors = await fetch(`${baseUrl}/api/health`, {
      method: 'GET',
      headers: { Origin: 'https://untrusted.example.net' },
    });
    assert.equal(unlistedCors.status, 200);
    assert.equal(unlistedCors.headers.get('access-control-allow-origin'), null);
  } finally {
    delete process.env.ALLOWED_ORIGINS;
  }

  // 16. Malformed JSON returns JSON 400 & database durability status reported cleanly
  const badJsonRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'BuddyElderAI',
    },
    body: '{invalid-json',
  });
  assert.equal(badJsonRes.status, 400);
  const badJsonData = (await badJsonRes.json()) as Record<string, unknown>;
  assert.equal(badJsonData.error, 'Invalid JSON request body.');

  const dbStatusHealth = await api('/api/health');
  assert.equal((dbStatusHealth.data.database as Record<string, unknown>).engine, 'sqlite');
  assert.equal((dbStatusHealth.data.database as Record<string, unknown>).durable, true);
});

test('Vercel serverless handler (api/index.ts) serves JSON without binding a port and never returns HTML for /api routes', async () => {
  const { default: vercelHandler } = await import('../api/index.ts');
  assert.equal(typeof vercelHandler, 'function');

  await new Promise<void>((resolve, reject) => {
    const tempServer = http.createServer((req, res) => {
      void vercelHandler(req as never, res as never);
    });
    tempServer.listen(0, '127.0.0.1', async () => {
      try {
        const addr = tempServer.address();
        const url = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';

        const healthRes = await fetch(`${url}/api/health`);
        assert.equal(healthRes.status, 200);
        assert.ok((healthRes.headers.get('content-type') || '').includes('application/json'));
        const healthBody = (await healthRes.json()) as Record<string, unknown>;
        assert.equal(healthBody.ok, true);

        const rootApiRes = await fetch(`${url}/api`);
        assert.equal(rootApiRes.status, 404);
        assert.ok((rootApiRes.headers.get('content-type') || '').includes('application/json'));
        const rootApiBody = (await rootApiRes.json()) as Record<string, unknown>;
        assert.equal(rootApiBody.code, 'NOT_FOUND');

        const missingApiRes = await fetch(`${url}/api/does-not-exist`);
        assert.equal(missingApiRes.status, 404);
        assert.ok((missingApiRes.headers.get('content-type') || '').includes('application/json'));
        const missingApiBody = (await missingApiRes.json()) as Record<string, unknown>;
        assert.equal(missingApiBody.code, 'NOT_FOUND');

        resolve();
      } catch (err) {
        reject(err);
      } finally {
        tempServer.close();
      }
    });
  });
});

test('AI Buddy model payload parsing and Gemini error classification handle edge cases', async () => {
  const { parseBuddyModelPayload, classifyGeminiError, getConfiguredGeminiModel, normalizeGeminiModelName, getAiStatus } =
    await import('../server/ai.ts');

  assert.equal(getConfiguredGeminiModel(), 'gemini-4-hydrogen');

  // Invalid GEMINI_MODEL overrides (e.g. mistakenly pasted token or placeholder) fall back safely
  assert.deepEqual(normalizeGeminiModelName('AQ.SampleInvalidPastedTokenValue123'), {
    model: 'gemini-4-hydrogen',
    invalidOverride: true,
  });
  assert.deepEqual(normalizeGeminiModelName('AIzaSyFakeKeyPastedIntoModelVar'), {
    model: 'gemini-4-hydrogen',
    invalidOverride: true,
  });
  assert.deepEqual(normalizeGeminiModelName('models/gemini-4-hydrogen'), {
    model: 'gemini-4-hydrogen',
    invalidOverride: false,
  });
  assert.deepEqual(normalizeGeminiModelName('gemini-2.5-flash'), {
    model: 'gemini-2.5-flash',
    invalidOverride: false,
  });

  const prevModelEnv = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'AQ.MistakenTokenString';
  try {
    assert.equal(getConfiguredGeminiModel(), 'gemini-4-hydrogen');
    const aiStatus = getAiStatus();
    assert.equal(aiStatus.model, 'gemini-4-hydrogen');
    assert.ok(aiStatus.modelWarning && !aiStatus.modelWarning.includes('AQ.MistakenTokenString'));
  } finally {
    if (prevModelEnv === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModelEnv;
  }

  // Structured JSON responses for sample elder-care questions
  const whatsappParsed = parseBuddyModelPayload(
    JSON.stringify({
      reply: '1. Open WhatsApp.\n2. Tap the paperclip icon.\n3. Choose Gallery and tap Send.',
      suggestions: ['How do I zoom in on a photo?', 'How do I save a photo?'],
    })
  );
  assert.ok(whatsappParsed.reply.includes('paperclip'));
  assert.equal(whatsappParsed.suggestions.length, 2);

  // Markdown-fenced JSON from Gemini
  const fencedParsed = parseBuddyModelPayload(
    '```json\n{"reply": "Press the top volume-up button on the side of your phone.", "suggestions": ["How do I mute ringtone?"]}\n```'
  );
  assert.ok(fencedParsed.reply.includes('volume-up'));
  assert.equal(fencedParsed.suggestions[0], 'How do I mute ringtone?');

  // Clean plain-text fallback when model returns prose instead of JSON wrapper
  const plainTextParsed = parseBuddyModelPayload(
    'Hang up immediately if anyone asks for your OTP or bank PIN. Call the official number on the back of your card.'
  );
  assert.ok(plainTextParsed.reply.includes('OTP'));
  assert.deepEqual(plainTextParsed.suggestions, []);

  // Empty response throws AI_EMPTY_RESPONSE instead of SyntaxError
  assert.throws(() => parseBuddyModelPayload('   '), (err: unknown) => {
    return err instanceof Error && (err as { code?: string }).code === 'AI_EMPTY_RESPONSE';
  });

  // Error classifications (preserving JSON code/status even when message text omits them)
  assert.equal(classifyGeminiError(new Error('{"error":{"code":404,"message":"models/bad is not found"}}')).code, 'AI_MODEL_ERROR');
  assert.equal(
    classifyGeminiError(
      new Error('{"error":{"code":400,"message":"* GenerateContentRequest.model: unexpected model name format\\n","status":"INVALID_ARGUMENT"}}')
    ).code,
    'AI_MODEL_ERROR'
  );
  assert.equal(classifyGeminiError(new Error('{"error":{"code":429,"message":"Too many requests","status":"RESOURCE_EXHAUSTED"}}')).code, 'AI_RATE_LIMIT');
  assert.equal(classifyGeminiError(new Error('{"error":{"code":403,"message":"Forbidden","status":"PERMISSION_DENIED"}}')).code, 'AI_AUTH_ERROR');
  assert.equal(classifyGeminiError(new Error('{"error":{"code":503,"message":"Service overloaded","status":"UNAVAILABLE"}}')).statusCode, 503);
  assert.equal(classifyGeminiError(new Error('ETIMEDOUT: AI service took too long')).code, 'AI_TIMEOUT');
  assert.equal(classifyGeminiError(new Error('API_KEY_INVALID: bad key')).code, 'AI_AUTH_ERROR');
  assert.equal(classifyGeminiError(new Error('TypeError: fetch failed')).code, 'AI_NETWORK_ERROR');
});

test('Frontend apiRequest diagnoses HTML SPA fallbacks and extracts standardized JSON payloads', async () => {
  const { apiRequest, ApiError } = await import('../src/lib/api.ts');
  const originalFetch = globalThis.fetch;

  try {
    // 1. HTML returned with HTTP 200 (proxy/SPA fallback scenario)
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html><body>SPA</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;

    await assert.rejects(
      () => apiRequest('/api/ai/conversations/1/messages', { method: 'POST', body: { message: 'Wi-Fi?' } }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === 'INVALID_RESPONSE' &&
        err.message.includes('HTML page instead of JSON')
    );

    // 2. Standardized backend error { success: false, error: { code, message } }
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          code: 'MISSING_API_KEY',
          error: { code: 'MISSING_API_KEY', message: 'Add GEMINI_API_KEY in Settings.' },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    await assert.rejects(
      () => apiRequest('/api/ai/conversations/1/messages', { method: 'POST', body: { message: 'Internet?' } }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === 'MISSING_API_KEY' &&
        err.message === 'Add GEMINI_API_KEY in Settings.'
    );

    // 3. Standardized success response { success: true, response, conversationId }
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          response: 'Open Settings and tap Wi-Fi to connect.',
          conversationId: 'conv-1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const ok = await apiRequest<{ success: boolean; response: string; conversationId: string }>(
      '/api/ai/conversations/1/messages',
      { method: 'POST', body: { message: 'How do I connect to Wi-Fi?' } }
    );
    assert.equal(ok.success, true);
    assert.ok(ok.response.includes('Wi-Fi'));
    assert.equal(ok.conversationId, 'conv-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Scam detection falls back cleanly to heuristic_fallback when Gemini fails at runtime', async () => {
  const { analyzeScamContent } = await import('../server/ai.ts');
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaSyFakeInvalidKeyForFallbackUnitTestOnly';
  try {
    const res = await analyzeScamContent({
      content: 'Your bank account will be blocked today. Click this link immediately to update your KYC.',
      inputType: 'email',
      language: 'en',
    });
    assert.equal(res.riskLevel, 'RED');
    assert.equal(res.source, 'heuristic_fallback');
    assert.ok(res.fallbackReason);
    assert.equal(res.requiresPause, true);
    assert.ok(res.indicators.length >= 2);
    assert.ok(res.recommendedActions.length >= 3);
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('resolveApiBase prevents localhost calls from production sites and apiRequest classifies connection errors accurately', async () => {
  const { resolveApiBase, apiRequest, ApiError } = await import('../src/lib/api.ts');
  const prodLoc = {
    protocol: 'https:',
    hostname: 'buddy-elder.vercel.app',
    origin: 'https://buddy-elder.vercel.app',
  };

  assert.equal(resolveApiBase('undefined', prodLoc).baseUrl, '');
  assert.equal(resolveApiBase('http://localhost:3000', prodLoc).baseUrl, '');
  assert.equal(resolveApiBase('https://api.buddyelder.com/api/', prodLoc).baseUrl, 'https://api.buddyelder.com');
  assert.ok(resolveApiBase('not-a-url', prodLoc).configError);
  assert.ok(resolveApiBase('http://api.buddyelder.com', prodLoc).configError);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    await assert.rejects(
      () => apiRequest('/api/health'),
      (err: unknown) => err instanceof ApiError && err.code === 'BACKEND_UNAVAILABLE' && err.status === 0
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'API endpoint not found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    await assert.rejects(
      () => apiRequest('/api/missing-route'),
      (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND' && err.status === 404
    );

    // 429 rate-limit metadata extraction (body + Retry-After header)
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          code: 'AI_RATE_LIMIT',
          rateLimitSource: 'gemini_provider',
          quotaExhausted: false,
          error: {
            code: 'AI_RATE_LIMIT',
            message: 'Buddy is helping many people right now. Please wait 14 seconds before trying again.',
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '14',
          },
        }
      )) as typeof fetch;

    await assert.rejects(
      () => apiRequest('/api/ai/conversations/1/messages', { method: 'POST', body: { message: 'WhatsApp?' } }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 429 &&
        err.code === 'AI_RATE_LIMIT' &&
        err.retryAfterSeconds === 14 &&
        err.rateLimitSource === 'gemini_provider' &&
        err.quotaExhausted === false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini 429 classification distinguishes transient rate limit vs daily quota exhaustion and respects GEMINI_MODEL', async () => {
  const { classifyGeminiError, getRetryDelayMs, getConfiguredGeminiModel } = await import('../server/ai.ts');

  // Configured GEMINI_MODEL must always be respected verbatim (never silently substituted)
  const prevModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  try {
    assert.equal(getConfiguredGeminiModel(), 'gemini-2.5-flash');
  } finally {
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }

  // Transient 429 with retryDelay: 12s -> AI_RATE_LIMIT, wait hint = 12s, skips auto-retry (>5s)
  const transient429Err = new Error(
    JSON.stringify({
      error: {
        code: 429,
        message: 'Resource exhausted. Please retry in 12s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
      },
    })
  );
  const transientClassified = classifyGeminiError(transient429Err, 'gemini-4-hydrogen', 0);
  assert.equal(transientClassified.code, 'AI_RATE_LIMIT');
  assert.equal(transientClassified.statusCode, 429);
  assert.equal(transientClassified.retryAfterSeconds, 12);
  assert.equal(transientClassified.quotaExhausted, false);
  assert.equal(transientClassified.rateLimitSource, 'gemini_provider');
  assert.ok(transientClassified.message.includes('12 seconds'));
  assert.equal(getRetryDelayMs(transient429Err, 1), null);

  // Transient 429 with short retryDelay: 2s -> bounded retry allowed once
  const short429Err = new Error(
    JSON.stringify({
      error: {
        code: 429,
        message: 'Too many requests',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }],
      },
    })
  );
  const shortDelay = getRetryDelayMs(short429Err, 1);
  assert.ok(typeof shortDelay === 'number' && shortDelay >= 2000 && shortDelay <= 2300);

  // Daily quota exhaustion (RequestsPerDay / limit: 0) -> AI_QUOTA_EXHAUSTED, never retried
  const dailyQuotaErr = new Error(
    JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaMetric: 'requests_per_day' }],
          },
        ],
      },
    })
  );
  const dailyClassified = classifyGeminiError(dailyQuotaErr, 'gemini-4-hydrogen', 0);
  assert.equal(dailyClassified.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(dailyClassified.statusCode, 429);
  assert.equal(dailyClassified.quotaExhausted, true);
  assert.equal(dailyClassified.rateLimitSource, 'gemini_provider');
  assert.ok(dailyClassified.message.includes('gemini-4-hydrogen'));
  assert.ok(dailyClassified.message.includes('Is This Safe?'));
  assert.equal(getRetryDelayMs(dailyQuotaErr, 1), null);
});

test('Express createRateLimiter isolates user buckets, keeps AI Buddy & Scam Checker independent, and emits Retry-After', async () => {
  const expressMod = await import('express');
  const { createRateLimiter } = await import('../server/app.ts');

  const miniApp = expressMod.default();
  const chatLimiter = createRateLimiter(60_000, 2, { limiterName: 'chat_test', keyByUser: true });
  const scamLimiter = createRateLimiter(60_000, 2, { limiterName: 'scam_test', keyByUser: true });

  miniApp.use((req, _res, next) => {
    const uid = req.headers['x-test-user'];
    if (typeof uid === 'string') {
      (req as { user?: { id: string } }).user = { id: uid };
    }
    next();
  });

  miniApp.post('/chat', chatLimiter, (_req, res) => res.json({ ok: true }));
  miniApp.post('/scam', scamLimiter, (_req, res) => res.json({ ok: true }));

  await new Promise<void>((resolve, reject) => {
    const srv = miniApp.listen(0, '127.0.0.1', async () => {
      try {
        const addr = srv.address();
        const url = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';

        // User A makes 2 chat requests (ok), 3rd triggers Express 429 with Retry-After
        assert.equal((await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-test-user': 'user-a' } })).status, 200);
        assert.equal((await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-test-user': 'user-a' } })).status, 200);

        const limited = await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-test-user': 'user-a' } });
        assert.equal(limited.status, 429);
        const retryHeader = Number(limited.headers.get('retry-after'));
        assert.ok(Number.isFinite(retryHeader) && retryHeader >= 1);
        const limitedJson = (await limited.json()) as Record<string, unknown>;
        assert.equal(limitedJson.code, 'BACKEND_RATE_LIMIT');
        assert.equal(limitedJson.rateLimitSource, 'express_limiter');

        // User B on the same IP is NOT blocked by User A's chat limit
        const userBOk = await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-test-user': 'user-b' } });
        assert.equal(userBOk.status, 200);

        // User A's Scam Checker limiter is independent of User A's Chat limiter
        const scamOk = await fetch(`${url}/scam`, { method: 'POST', headers: { 'x-test-user': 'user-a' } });
        assert.equal(scamOk.status, 200);

        resolve();
      } catch (err) {
        reject(err);
      } finally {
        srv.close();
      }
    });
  });
});

