// A device as the PWA would behave: non-extractable keys, signed requests,
// a cookie jar, pinned VM keys, HPKE encryption of tickets and verification +
// decryption of outputs. Built only on @vesper/core, like the browser client.

import { exportPublicJwk, generateSigningKeyPair, importVerifyKey, type EcPublicJwk } from '@vesper/core/keys';
import { generateHpkeKeyPair, hpkePublicKeyFromJwk, hpkePublicKeyToJwk, HPKE_INFO, inputAad, openJson, outputAad, sealJson, type HpkeKeyPair, type Target } from '@vesper/core/envelope';
import { approvalSigningString, signRequest, verifyOutput, verifyString } from '@vesper/core/sign';
import { computeFingerprint } from '@vesper/core/fingerprint';
import { canonicalTicketBody, parseOutputPlaintext, type OutputPlaintext } from '@vesper/core/schemas';
import { randomNonce, randomUuid } from '@vesper/core/encoding';
import { hotp, totpStep } from '../../web/lib/totp.ts';
import type { Harness } from './harness.ts';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface Res {
  status: number;
  json: any;
  setCookie: string | null;
}

export interface ReqOpts {
  raw?: string;
  ts?: number;
  nonce?: string;
  signWith?: CryptoKey;
  deviceHeader?: string | null;
  noSig?: boolean;
  noCookie?: boolean;
  extraHeaders?: Record<string, string>;
  ip?: string;
}

export class SimDevice {
  id = randomUuid();
  name: string;
  ip: string;
  h: Harness;
  sign!: CryptoKeyPair;
  enc!: HpkeKeyPair;
  signJwk!: EcPublicJwk;
  encJwk!: EcPublicJwk;
  fingerprint!: string;
  cookie: string | null = null;
  vm: { signJwk: EcPublicJwk; encJwk: EcPublicJwk; fingerprint: string } | null = null;

  constructor(h: Harness, name: string, ip: string) {
    this.h = h;
    this.name = name;
    this.ip = ip;
  }

  static async create(h: Harness, name = 'iPhone', ip = '198.51.100.7'): Promise<SimDevice> {
    const d = new SimDevice(h, name, ip);
    d.sign = await generateSigningKeyPair();
    d.enc = await generateHpkeKeyPair();
    d.signJwk = await exportPublicJwk(d.sign.publicKey);
    d.encJwk = await hpkePublicKeyToJwk(d.enc.publicKey);
    d.fingerprint = await computeFingerprint(d.signJwk, d.encJwk);
    return d;
  }

  get publicKeys() {
    return { id: this.id, name: this.name, sign_public_key: this.signJwk, enc_public_key: this.encJwk };
  }

  async req(method: string, path: string, body?: unknown, o: ReqOpts = {}): Promise<Res> {
    const raw = o.raw ?? (body === undefined ? '' : JSON.stringify(body));
    const ts = o.ts ?? this.h.clock.t;
    const nonce = o.nonce ?? randomNonce();
    const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? this.ip, ...(o.extraHeaders ?? {}) };
    if (raw) headers['content-type'] = 'application/json';
    if (!o.noSig) {
      headers['x-vesper-ts'] = String(ts);
      headers['x-vesper-nonce'] = nonce;
      headers['x-vesper-sig'] = await signRequest(o.signWith ?? this.sign.privateKey, { method, path, ts, nonce, body: raw });
      if (o.deviceHeader !== null) headers['x-vesper-device'] = o.deviceHeader ?? this.id;
    }
    if (this.cookie && !o.noCookie) headers.cookie = this.cookie;
    const res = await this.h.fetch(path, { method, headers, ...(method === 'GET' ? {} : { body: raw }) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, setCookie };
  }

  totp(secretB32: string, stepOffset = 0): string {
    return hotp(base32Decode(secretB32), totpStep(this.h.clock.t) + stepOffset);
  }

  pinVm(vm: { sign_public_key: EcPublicJwk; enc_public_key: EcPublicJwk; fingerprint: string }) {
    this.vm = { signJwk: vm.sign_public_key, encJwk: vm.enc_public_key, fingerprint: vm.fingerprint };
  }

  async verifyApproval(me: { vm_approved_at: number; vm_approval_sig: string }): Promise<boolean> {
    if (!this.vm) return false;
    return verifyString(
      await importVerifyKey(this.vm.signJwk),
      approvalSigningString({ deviceId: this.id, fingerprint: this.fingerprint, approvedAt: me.vm_approved_at }),
      me.vm_approval_sig,
    );
  }

  async buildTicket(o: { type?: string; target?: Target; raw: string; id?: string; ts?: number }) {
    if (!this.vm) throw new Error('VM not pinned');
    const id = o.id ?? randomUuid();
    const ts = o.ts ?? this.h.clock.t;
    const type = o.type ?? 'general';
    const target = o.target ?? 'claude_ai';
    const envelope = await sealJson(await hpkePublicKeyFromJwk(this.vm.encJwk), { raw_input: o.raw }, { info: HPKE_INFO.in, aad: inputAad({ ticketId: id, type, target, deviceId: this.id, ts }) });
    const body = canonicalTicketBody({ id, type, target, device_id: this.id, ts, input_envelope: envelope });
    return { id, ts, body };
  }

  async createTicket(o: { type?: string; target?: Target; raw: string }): Promise<Res & { id: string }> {
    const t = await this.buildTicket(o);
    const r = await this.req('POST', '/api/tickets', undefined, { raw: t.body, ts: t.ts });
    return { ...r, id: t.id };
  }

  /** What the review page does: verify the VM output signature with the PINNED key, then decrypt our envelope. */
  async readOutput(ticket: any): Promise<{ ok: true; plain: OutputPlaintext } | { ok: false; reason: string }> {
    if (!this.vm) return { ok: false, reason: 'no_pinned_vm' };
    if (!ticket.output_envelopes || !ticket.output_sig) return { ok: false, reason: 'no_output' };
    const sigOk = await verifyOutput(await importVerifyKey(this.vm.signJwk), ticket.id, ticket.output_envelopes, ticket.output_sig);
    if (!sigOk) return { ok: false, reason: 'bad_signature' };
    const env = ticket.output_envelopes[this.id];
    if (!env) return { ok: false, reason: 'no_envelope_for_me' };
    try {
      const plain = await openJson(this.enc, env, {
        info: HPKE_INFO.out,
        aad: outputAad({ ticketId: ticket.id, type: ticket.type, target: ticket.target, recipientDeviceId: this.id, processedAt: ticket.processed_at }),
      });
      return { ok: true, plain: parseOutputPlaintext(plain) };
    } catch {
      return { ok: false, reason: 'decrypt_failed' };
    }
  }
}
