'use client';

// Input for the recovery key, break-glass key and kill token. Shown in plain
// text so it can be checked against the saved copy, with a dash added after
// every 4 characters as you type (ABCD-EFGH-…), the same way it was shown.

import { formatSecretInput, SECRET_INPUT_MAX } from './secrets.ts';

export function SecretInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      id={id}
      type="text"
      className="secret"
      autoComplete="off"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      maxLength={SECRET_INPUT_MAX}
      placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
      value={value}
      onChange={(e) => onChange(formatSecretInput(e.target.value))}
    />
  );
}
