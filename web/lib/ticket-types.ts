// §4: Vercel keeps only each ticket type's key and Chinese display name.
// Models, templates and length limits live on the VM in ~/vesper-content/ticket-types.json.
// The keys here must match the keys there.

export interface TicketTypeInfo {
  key: string;
  label: string;
}

export const TICKET_TYPES: readonly TicketTypeInfo[] = [
  { key: 'general', label: '一般' },
  { key: 'coding', label: '程序开发' },
  { key: 'writing', label: '写作与邮件' },
  { key: 'research', label: '资料整理' },
];

export function isKnownTicketType(key: string): boolean {
  return TICKET_TYPES.some((t) => t.key === key);
}
