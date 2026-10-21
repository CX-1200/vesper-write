// Deterministic serialization used wherever two parties must hash or sign
// "the same bytes" without sharing the original message: AAD strings,
// signature payloads and the ticket request body.
export const FIELD_SEPARATOR = '|';
export class CanonicalError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CanonicalError';
    }
}
/**
 * Join fields with "|". A field containing "|" (or a control character) is
 * rejected instead of escaped, so two different field lists can never produce
 * the same string.
 */
export function joinFields(fields) {
    return fields
        .map((f, i) => {
        if (typeof f === 'number') {
            if (!Number.isSafeInteger(f))
                throw new CanonicalError(`field ${i} is not a safe integer`);
            return String(f);
        }
        if (typeof f !== 'string')
            throw new CanonicalError(`field ${i} has an unsupported type`);
        // eslint-disable-next-line no-control-regex
        if (f.includes(FIELD_SEPARATOR) || /[\u0000-\u001f\u007f]/.test(f)) {
            throw new CanonicalError(`field ${i} contains a forbidden character`);
        }
        return f;
    })
        .join(FIELD_SEPARATOR);
}
/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, only
 * strings, safe integers, booleans, null, arrays and plain objects.
 * Floats are rejected because their text form is not portable enough to sign.
 */
export function canonicalJson(value) {
    if (value === null)
        return 'null';
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isSafeInteger(value))
                throw new CanonicalError('non-integer number in canonical JSON');
            return String(value);
        case 'object': {
            if (Array.isArray(value))
                return `[${value.map(canonicalJson).join(',')}]`;
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null)
                throw new CanonicalError('non-plain object in canonical JSON');
            const entries = Object.entries(value);
            for (const [, v] of entries) {
                if (v === undefined)
                    throw new CanonicalError('undefined value in canonical JSON');
            }
            entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
        }
        default:
            throw new CanonicalError(`unsupported type ${typeof value} in canonical JSON`);
    }
}
/** True when `text` is exactly the canonical serialization of its own parse result. */
export function isCanonicalJson(text) {
    try {
        return canonicalJson(JSON.parse(text)) === text;
    }
    catch {
        return false;
    }
}
