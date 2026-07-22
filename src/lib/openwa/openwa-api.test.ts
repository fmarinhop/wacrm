import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  phoneToChatId,
  chatIdToPhone,
  createSession,
  getQRCode,
  sendText,
  sendMedia,
  registerWebhook,
  OpenWAApiError,
} from './openwa-api';

// ------------------------------------------------------------
// chatId helpers — pure functions, no fetch involved.
// ------------------------------------------------------------

describe('phoneToChatId', () => {
  it('strips the + and appends @c.us', () => {
    expect(phoneToChatId('+5511999998888')).toBe('5511999998888@c.us');
  });

  it('strips every non-digit (spaces, dashes, parens)', () => {
    expect(phoneToChatId('+55 (11) 99999-8888')).toBe('5511999998888@c.us');
  });
});

describe('chatIdToPhone', () => {
  it('converts a 1:1 phone JID back to E.164', () => {
    expect(chatIdToPhone('5511999998888@c.us')).toBe('+5511999998888');
  });

  it('returns null for group JIDs', () => {
    expect(chatIdToPhone('123456789-987654@g.us')).toBeNull();
  });

  it('returns null for privacy-id (@lid) JIDs', () => {
    expect(chatIdToPhone('123456789012345@lid')).toBeNull();
  });

  it('returns null for status broadcasts and garbage', () => {
    expect(chatIdToPhone('status@broadcast')).toBeNull();
    expect(chatIdToPhone('')).toBeNull();
    expect(chatIdToPhone('not-a-jid')).toBeNull();
  });
});

// ------------------------------------------------------------
// HTTP client behaviour — mocked fetch. OPENWA_BASE_URL / OPENWA_API_KEY
// come from vitest.config.ts env.
// ------------------------------------------------------------

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openwa client requests', () => {
  it('createSession POSTs the name with the API key header', async () => {
    const fetchMock = mockFetchOnce(201, {
      id: 'sess-1',
      name: 'wacrm-acct',
      status: 'created',
    });

    const session = await createSession({ name: 'wacrm-acct' });
    expect(session.id).toBe('sess-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://openwa.test/api/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('owa_test_key');
    expect(JSON.parse(init.body)).toEqual({ name: 'wacrm-acct' });
  });

  it('sendText targets the session-scoped messages endpoint', async () => {
    const fetchMock = mockFetchOnce(201, {
      messageId: 'true_55@c.us_ABC',
      timestamp: 1700000000,
    });

    const result = await sendText({
      sessionId: 'sess-1',
      chatId: '5511999998888@c.us',
      text: 'hello',
    });
    expect(result.messageId).toBe('true_55@c.us_ABC');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://openwa.test/api/sessions/sess-1/messages/send-text');
    expect(JSON.parse(init.body)).toEqual({
      chatId: '5511999998888@c.us',
      text: 'hello',
    });
  });

  it('sendMedia routes each kind to its own endpoint and omits empty optionals', async () => {
    const fetchMock = mockFetchOnce(201, {
      messageId: 'true_55@c.us_DEF',
      timestamp: 1700000001,
    });

    await sendMedia({
      sessionId: 'sess-1',
      chatId: '5511999998888@c.us',
      kind: 'document',
      url: 'https://cdn.example/file.pdf',
      filename: 'file.pdf',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'http://openwa.test/api/sessions/sess-1/messages/send-document',
    );
    expect(JSON.parse(init.body)).toEqual({
      chatId: '5511999998888@c.us',
      url: 'https://cdn.example/file.pdf',
      filename: 'file.pdf',
    });
  });

  it('registerWebhook posts url, events and secret', async () => {
    const fetchMock = mockFetchOnce(201, { id: 'wh-1', url: 'x', events: [] });

    await registerWebhook({
      sessionId: 'sess-1',
      url: 'https://crm.example/api/openwa/webhook',
      events: ['session.qr'],
      secret: 's3cret',
      retryCount: 3,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://crm.example/api/openwa/webhook',
      events: ['session.qr'],
      secret: 's3cret',
      retryCount: 3,
    });
  });

  it('surfaces the Nest error message and status on failure', async () => {
    mockFetchOnce(409, {
      statusCode: 409,
      message: 'Session name already exists',
      error: 'Conflict',
    });

    await expect(createSession({ name: 'wacrm-acct' })).rejects.toMatchObject({
      name: 'OpenWAApiError',
      status: 409,
      message: 'Session name already exists',
    });
  });

  it('joins array-form Nest validation messages', async () => {
    mockFetchOnce(400, {
      statusCode: 400,
      message: ['name too short', 'name has invalid chars'],
    });

    await expect(createSession({ name: 'x' })).rejects.toMatchObject({
      status: 400,
      message: 'name too short; name has invalid chars',
    });
  });

  it('maps network failure to a 502 OpenWAApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(
      getQRCode({ sessionId: 'sess-1' }),
    ).rejects.toBeInstanceOf(OpenWAApiError);
    await getQRCode({ sessionId: 'sess-1' }).catch((e: OpenWAApiError) => {
      expect(e.status).toBe(502);
      expect(e.message).toMatch(/unreachable/);
    });
  });

  it('handles a non-JSON error body without throwing a parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>Bad Gateway</html>', { status: 502 }),
      ),
    );

    await expect(getQRCode({ sessionId: 'sess-1' })).rejects.toMatchObject({
      status: 502,
      message: 'OpenWA request failed with HTTP 502',
    });
  });
});
