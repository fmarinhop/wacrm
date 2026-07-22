import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Unofficial-channel dispatch (conversation.channel === 'openwa').
//
// A minimal chainable Supabase stub: every query-builder method returns
// the chain; the terminators (.single/.maybeSingle) and `await chain`
// resolve canned per-table results. The OpenWA HTTP hop is a stubbed
// global fetch — these tests assert the send core routes by channel,
// not the gateway client internals (openwa-api.test.ts owns those).
// ============================================================

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => makeFakeDb({}),
}));

interface FakeTableResults {
  single?: { data: unknown; error: unknown };
  maybeSingle?: { data: unknown; error: unknown };
  insertSingle?: { data: unknown; error: unknown };
}

function makeFakeDb(tables: Record<string, FakeTableResults>) {
  return {
    from(table: string) {
      const results = tables[table] ?? {};
      let inserting = false;
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update']) {
        chain[m] = self;
      }
      chain.insert = () => {
        inserting = true;
        return chain;
      };
      chain.single = () =>
        Promise.resolve(
          (inserting ? results.insertSingle : results.single) ?? {
            data: null,
            error: { message: `no stub for ${table}.single` },
          }
        );
      chain.maybeSingle = () =>
        Promise.resolve(
          results.maybeSingle ?? { data: null, error: null }
        );
      // Awaiting the bare chain (update/insert without .select()).
      chain.then = (
        resolve: (v: { data: null; error: null }) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return chain;
    },
  } as unknown as SupabaseClient;
}

const OPENWA_CONVERSATION = {
  id: 'cv-1',
  account_id: 'acct-1',
  channel: 'openwa',
  unread_count: 0,
  contact: { id: 'ct-1', phone: '+5511999998888' },
};

describe('sendMessageToConversation — openwa channel dispatch', () => {
  it('rejects template sends with a clear channel error', async () => {
    const db = makeFakeDb({
      conversations: { single: { data: OPENWA_CONVERSATION, error: null } },
    });

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'welcome',
      })
    ).rejects.toMatchObject({
      code: 'channel_unsupported',
      status: 400,
    });
  });

  it('rejects interactive sends on the unofficial channel', async () => {
    const db = makeFakeDb({
      conversations: { single: { data: OPENWA_CONVERSATION, error: null } },
    });

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'A' }],
        },
      })
    ).rejects.toMatchObject({ code: 'channel_unsupported', status: 400 });
  });

  it('refuses to send when the channel is not connected', async () => {
    const db = makeFakeDb({
      conversations: { single: { data: OPENWA_CONVERSATION, error: null } },
      openwa_config: {
        maybeSingle: {
          data: { session_id: 'sess-1', status: 'disconnected' },
          error: null,
        },
      },
    });

    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toMatchObject({ code: 'openwa_not_connected', status: 409 });
  });

  it('sends text through the gateway and persists the message', async () => {
    const db = makeFakeDb({
      conversations: { single: { data: OPENWA_CONVERSATION, error: null } },
      openwa_config: {
        maybeSingle: {
          data: { session_id: 'sess-1', status: 'connected' },
          error: null,
        },
      },
      messages: {
        insertSingle: { data: { id: 'msg-row-1' }, error: null },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ messageId: 'true_55@c.us_XYZ', timestamp: 1700000000 }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hello there',
      });

      expect(result).toEqual({
        messageId: 'msg-row-1',
        whatsappMessageId: 'true_55@c.us_XYZ',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'http://openwa.test/api/sessions/sess-1/messages/send-text'
      );
      expect(JSON.parse(init.body)).toEqual({
        chatId: '5511999998888@c.us',
        text: 'hello there',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a gateway failure to a 502 openwa_error', async () => {
    const db = makeFakeDb({
      conversations: { single: { data: OPENWA_CONVERSATION, error: null } },
      openwa_config: {
        maybeSingle: {
          data: { session_id: 'sess-1', status: 'connected' },
          error: null,
        },
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    );
    try {
      await expect(
        sendMessageToConversation(db, 'acct-1', {
          conversationId: 'cv-1',
          messageType: 'text',
          contentText: 'hi',
        })
      ).rejects.toMatchObject({ code: 'openwa_error', status: 502 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
