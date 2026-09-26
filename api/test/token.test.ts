/** Ключи доступа: подпись, срок жизни, чужой секрет. */
import test from "node:test";
import assert from "node:assert/strict";

import { apiKeyForEmail, isExpired, issueToken, parseToken, verifySignature } from "../src/token.ts";

const secret = "test-secret";
const email = "babaevafarida8@gmail.com";

test("выпущенный ключ проверяется тем же секретом", () => {
  const { token } = issueToken(email, secret);
  assert.ok(token.startsWith("hk1."));
  assert.equal(verifySignature(token, secret), true);
});

test("e-mail восстанавливается из ключа в нормализованном виде", () => {
  const { token } = issueToken("  BabaevaFarida8@Gmail.com ", secret);
  const parsed = parseToken(token);
  assert.equal(parsed.kind, "derived");
  if (parsed.kind === "derived") assert.equal(parsed.email, email);
});

test("чужой секрет не проходит", () => {
  const { token } = issueToken(email, secret);
  assert.equal(verifySignature(token, "other-secret"), false);
});

test("подмена e-mail в ключе ломает подпись", () => {
  const { token } = issueToken(email, secret);
  const forged = token.replace(
    Buffer.from(email).toString("base64url"),
    Buffer.from("hacker@example.com").toString("base64url"),
  );
  assert.notEqual(forged, token);
  assert.equal(verifySignature(forged, secret), false);
});

test("срок жизни: истёкший ключ определяется, бессрочный — нет", () => {
  const now = Math.floor(Date.now() / 1000);

  // Ключ выпущен «в прошлом» на 60 секунд → уже истёк.
  const short = issueToken(email, secret, 30, now - 90);
  assert.ok(short.expiresAt !== null && isExpired(short.expiresAt));

  const forever = issueToken(email, secret, 0);
  assert.equal(forever.expiresAt, null);
  assert.equal(isExpired(forever.expiresAt), false);

  const parsed = parseToken(short.token);
  assert.equal(parsed.kind, "derived");
  if (parsed.kind === "derived") {
    assert.equal(parsed.expiresAt, short.expiresAt);
    assert.equal(isExpired(parsed.expiresAt), true);
  }

  // Живой ключ на час — не истёк.
  const fresh = issueToken(email, secret, 3600);
  assert.ok(fresh.expiresAt !== null && !isExpired(fresh.expiresAt));
});

test("строка без префикса считается непрозрачным токеном", () => {
  const parsed = parseToken("some-random-string");
  assert.equal(parsed.kind, "opaque");
});

test("apiKeyForEmail предпочитает статический ключ из env", () => {
  assert.equal(apiKeyForEmail(email, secret, "static-key"), "static-key");
  assert.ok(apiKeyForEmail(email, secret).startsWith("hk1."));
});
