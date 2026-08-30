#!/usr/bin/env node
// One shot helper. Prints a VAPID key pair to stdout, ready to paste into
// .env. Run once per deployment and keep the private key secret.
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
process.stdout.write(
  `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=mailto:you@example.com\n`,
);
