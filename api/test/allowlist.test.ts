/**
 * Тесты белого списка e-mail — единственной «двери» в API.
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { checkEmailAccess, isAllowedEmail, normalizeEmail, DEFAULT_ALLOWED_EMAIL } from "../src/allowlist.ts";

const allowlist = [DEFAULT_ALLOWED_EMAIL];

test("адрес из белого списка проходит", () => {
  assert.equal(isAllowedEmail("babaevafarida8@gmail.com", allowlist), true);
});

test("регистр и пробелы не влияют", () => {
  assert.equal(isAllowedEmail("  BabaevaFarida8@Gmail.COM ", allowlist), true);
  assert.equal(normalizeEmail("  Foo@BAR.ru "), "foo@bar.ru");
});

test("чужой адрес не проходит", () => {
  assert.equal(isAllowedEmail("someone.else@gmail.com", allowlist), false);
  assert.equal(isAllowedEmail("babaevafarida8@gmail.com.evil.com", allowlist), false);
  assert.equal(isAllowedEmail("", allowlist), false);
  assert.equal(isAllowedEmail(undefined, allowlist), false);
});

test("checkEmailAccess различает 401 (нет данных) и 403 (не тот адрес)", () => {
  const empty = checkEmailAccess("", allowlist);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.status, 401);

  const stranger = checkEmailAccess("other@example.com", allowlist);
  assert.equal(stranger.ok, false);
  if (!stranger.ok) assert.equal(stranger.status, 403);

  const owner = checkEmailAccess("BabaevaFarida8@gmail.com", allowlist);
  assert.deepEqual(owner, { ok: true, email: "babaevafarida8@gmail.com" });
});

test("список можно переопределить (несколько адресов)", () => {
  const custom = ["a@example.com", "B@Example.com"];
  assert.equal(isAllowedEmail("b@example.com", custom), true);
  assert.equal(isAllowedEmail("babaevafarida8@gmail.com", custom), false);
});
