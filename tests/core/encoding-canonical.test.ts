import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlDecode,
  b64urlEncode,
  concatBytes,
  equalBytes,
  fromHex,
  sha256Hex,
  toHex,
  utf8,
} from '@vesper/core/encoding';
import { canonicalJson, isCanonicalJson, joinFields, CanonicalError } from '@vesper/core/canonical';

test('base64url round-trips and matches RFC 4648 §10 vectors', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(b64urlEncode(utf8(plain)), encoded);
    assert.deepEqual(b64urlDecode(encoded), utf8(plain));
  }
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(b64urlDecode(b64urlEncode(all)), all);
  assert.equal(b64urlEncode(new Uint8Array([0xfb, 0xff])), '-_8');
});

test('base64url decoder is strict', () => {
  for (const bad of ['Zg==', 'Zm9v+', 'Zm9v/', 'Z', 'Zm 9v', 'Zh']) {
    assert.throws(() => b64urlDecode(bad), TypeError, bad);
  }
});

test('hex helpers', () => {
  assert.equal(toHex(new Uint8Array([0, 1, 254, 255])), '0001feff');
  assert.deepEqual(fromHex('0001FEff'), new Uint8Array([0, 1, 254, 255]));
  assert.throws(() => fromHex('abc'));
  assert.throws(() => fromHex('zz'));
});

test('sha256 matches FIPS 180-2 "abc" vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('equalBytes and concatBytes', () => {
  assert.equal(equalBytes(utf8('abc'), utf8('abc')), true);
  assert.equal(equalBytes(utf8('abc'), utf8('abd')), false);
  assert.equal(equalBytes(utf8('abc'), utf8('ab')), false);
  assert.deepEqual(concatBytes(utf8('a'), new Uint8Array(), utf8('bc')), utf8('abc'));
});

test('joinFields rejects separators and control characters', () => {
  assert.equal(joinFields(['vesper/in/v1', 'id', 'type', 'claude_ai', 'dev', 1700000000000]), 'vesper/in/v1|id|type|claude_ai|dev|1700000000000');
  assert.throws(() => joinFields(['a|b']), CanonicalError);
  assert.throws(() => joinFields(['a\nb']), CanonicalError);
  assert.throws(() => joinFields([1.5]), CanonicalError);
  assert.throws(() => joinFields([Number.MAX_SAFE_INTEGER + 1]), CanonicalError);
  // Without the check, ["a|b","c"] and ["a","b|c"] would both become "a|b|c".
  assert.throws(() => joinFields(['a', 'b|c']), CanonicalError);
});

test('canonicalJson sorts keys recursively and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonicalJson('é"\n'), '"é\\"\\n"');
  assert.equal(canonicalJson([]), '[]');
});

test('canonicalJson rejects values without a single portable encoding', () => {
  assert.throws(() => canonicalJson(1.5), CanonicalError);
  assert.throws(() => canonicalJson({ a: undefined }), CanonicalError);
  assert.throws(() => canonicalJson(new Date()), CanonicalError);
  assert.throws(() => canonicalJson(() => 1), CanonicalError);
  assert.throws(() => canonicalJson(10n), CanonicalError);
});

test('isCanonicalJson detects reordered keys and whitespace', () => {
  assert.equal(isCanonicalJson('{"a":1,"b":2}'), true);
  assert.equal(isCanonicalJson('{"b":2,"a":1}'), false);
  assert.equal(isCanonicalJson('{"a": 1}'), false);
  assert.equal(isCanonicalJson('not json'), false);
});
