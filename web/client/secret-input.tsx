'use client';

// Input for the recovery key, break-glass key and kill token. Dashes are added
// automatically every 4 characters. Hidden by default; "显示" reveals it so the
// grouping can be checked against the saved copy.

import { useState } from 'react';
import { formatSecretInput, SECRET_INPUT_MAX } from './secrets.ts';

export function SecretInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="row">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        className="secret"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={SECRET_INPUT_MAX}
        placeholder="ABCD-EFGH-…"
        value={value}
        onChange={(e) => onChange(formatSecretInput(e.target.value))}
      />
      <button type="button" className="secondary" aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? '隐藏' : '显示'}
      </button>
    </div>
  );
}
