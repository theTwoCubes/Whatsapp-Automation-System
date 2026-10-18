// The number every fixture defaults to. Exported so tests that have to look
// a contact up by wa_id use the same literal the fixtures send with, rather
// than repeating it and drifting apart.
export const DEFAULT_WA_ID = '91XXXXXX62XX';

// Builders for the webhook payloads Meta sends, so tests can exercise paths we
// cannot trigger by hand, such as a click to WhatsApp ad message.

export function inboundText({ from = DEFAULT_WA_ID, name = 'Test Lead', id, body, referral } = {}) {
  const message = {
    from,
    id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
    timestamp: `${Math.floor(Date.now() / 1000)}`,
    type: 'text',
    text: { body: body ?? 'hello' },
  };
  if (referral) message.referral = referral;

  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [message],
  });
}

export function inboundImage({ from = DEFAULT_WA_ID, name = 'Test Lead', id } = {}) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [
      {
        from,
        id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg' },
      },
    ],
  });
}

export function inboundButtonReply({ from = DEFAULT_WA_ID, name = 'Test Lead', id, text = 'Yes, interested' } = {}) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [
      {
        from,
        id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: 'button',
        button: { text, payload: text },
      },
    ],
  });
}

export function inboundInteractiveReply({ from = DEFAULT_WA_ID, name = 'Test Lead', id, title = 'Logo Design' } = {}) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [
      {
        from,
        id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'opt-1', title } },
      },
    ],
  });
}

export function inboundLocation({ from = DEFAULT_WA_ID, name = 'Test Lead', id } = {}) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [
      {
        from,
        id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: 'location',
        location: { latitude: 23.02, longitude: 72.57, name: 'Ahmedabad' },
      },
    ],
  });
}

export function inboundReaction({ from = DEFAULT_WA_ID, name = 'Test Lead', id, targetWamid, emoji = '👍' } = {}) {
  return wrap({
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [
      {
        from,
        id: id ?? `wamid.${Math.random().toString(36).slice(2)}`,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        type: 'reaction',
        reaction: { message_id: targetWamid, emoji },
      },
    ],
  });
}

export function statusUpdate({ id, status = 'delivered', recipient = DEFAULT_WA_ID } = {}) {
  return wrap({
    statuses: [
      {
        id,
        status,
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        recipient_id: recipient,
        errors: status === 'failed' ? [{ code: 131026, title: 'Message undeliverable' }] : undefined,
      },
    ],
  });
}

export const adReferral = {
  source_id: '120200000000000123',
  source_type: 'ad',
  source_url: 'https://fb.me/abc',
  headline: 'Logo design in 48 hours',
  body: 'Tap to chat with our studio',
};

function wrap(value) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '2136799610570585',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '91XXXXXXXXXX', phone_number_id: '1329787586874939' },
              ...value,
            },
          },
        ],
      },
    ],
  };
}
