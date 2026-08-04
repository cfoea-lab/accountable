// webpush.js — minimal Web Push (RFC 8291/8292) sender in pure Node crypto.
// Zero dependencies: VAPID ES256 JWTs + aes128gcm payload encryption by hand.
'use strict';
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// One-time server identity. Stored in the database config table on first boot.
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const uncompressed = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ]);
  return { publicKey: b64u(uncompressed), privateKey: priv.d };
}

// VAPID Authorization header (RFC 8292): ES256 JWT over {aud, exp, sub}.
function vapidAuth(endpoint, publicKey, privateKey, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const pubBuf = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pubBuf.subarray(1, 33)), y: b64u(pubBuf.subarray(33, 65)), d: privateKey },
    format: 'jwk',
  });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${publicKey}`;
}

// Payload encryption (RFC 8291, aes128gcm content coding).
function encrypt(payload, p256dh, auth) {
  const clientPub = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPub);

  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, serverPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last-record delimiter
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([serverPub.length]), serverPub, ct]);
}

// Send one push. Returns HTTP status from the push service (201 = accepted).
async function sendPush(sub, payloadObj, vapid) {
  const body = encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}

module.exports = { generateVapidKeys, sendPush };
