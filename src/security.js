import { createHmac, timingSafeEqual } from 'node:crypto';

// Verifies the X-Hub-Signature-256 header Meta sends with every webhook POST.
// The signature is an HMAC SHA256 of the raw request body keyed with the app
// secret, so we hash the bytes as received, before JSON parsing changes them.
export function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) {
    return false;
  }

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = header.slice('sha256='.length);

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(received, 'hex');
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}
