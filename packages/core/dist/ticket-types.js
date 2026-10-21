// The ticket types (§4). Vercel keeps only each type's key and Chinese display
// name; models, templates and length limits live on the VM in
// ~/vesper-content/ticket-types.json, whose keys must match these
// (`vesper content check` verifies that on the VM).
export const TICKET_TYPES = [
    { key: 'general', label: '一般' },
    { key: 'coding', label: '程序开发' },
    { key: 'writing', label: '写作与邮件' },
    { key: 'research', label: '资料整理' },
];
export function isKnownTicketType(key) {
    return TICKET_TYPES.some((t) => t.key === key);
}
