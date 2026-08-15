export async function listSentEntrySenderAddresses(
  database: D1Database,
  mailboxEntryIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (mailboxEntryIds.length === 0) return result
  const placeholders = mailboxEntryIds.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await database
    .prepare(
      `SELECT operation.sent_mailbox_entry_id, address.canonical_address
       FROM send_operations operation
       JOIN email_addresses address ON address.id = operation.sender_address_id
       WHERE operation.sent_mailbox_entry_id IN (${placeholders})`,
    )
    .bind(...mailboxEntryIds)
    .all<{ sent_mailbox_entry_id: string; canonical_address: string }>()
  for (const row of rows.results) {
    result.set(row.sent_mailbox_entry_id, row.canonical_address)
  }
  return result
}
