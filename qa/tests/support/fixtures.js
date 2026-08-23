// Builders for the webhook payloads Meta sends, so tests can exercise paths we
// cannot trigger by hand, such as a click to WhatsApp ad message.

export function inboundText({ from = '918766226219', name = 'Test Lead', id, body, referral } = {}) {
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

export function inboundImage({ from = '918766226219', name = 'Test Lead', id } = {}) {
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

export function statusUpdate({ id, status = 'delivered', recipient = '918766226219' } = {}) {
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
              metadata: { display_phone_number: '918860060837', phone_number_id: '1329787586874939' },
              ...value,
            },
          },
        ],
      },
    ],
  };
}
