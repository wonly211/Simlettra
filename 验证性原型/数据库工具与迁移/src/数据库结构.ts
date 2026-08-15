import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    status: text("status", { enum: ["active", "disabled", "deletion_pending"] }).notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    check("users_status_check", sql`${table.status} IN ('active', 'disabled', 'deletion_pending')`)
  ]
);

export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: ["primary", "alias"] }).notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("addresses_address_unique").on(table.address),
    index("addresses_owner_index").on(table.ownerUserId),
    check("addresses_kind_check", sql`${table.kind} IN ('primary', 'alias')`)
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text").notNull().default(""),
    receivedAt: integer("received_at").notNull(),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
    visibility: text("visibility", { enum: ["staging", "visible"] }).notNull(),
    objectKey: text("object_key").notNull()
  },
  (table) => [
    check("messages_visibility_check", sql`${table.visibility} IN ('staging', 'visible')`),
    index("messages_received_index").on(table.receivedAt, table.id)
  ]
);

export const mailboxEntries = sqliteTable(
  "mailbox_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    messageId: text("message_id").notNull().references(() => messages.id),
    deliveredAddressId: text("delivered_address_id").notNull().references(() => addresses.id),
    mailbox: text("mailbox", { enum: ["inbox", "sent", "draft", "spam", "trash"] }).notNull(),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("mailbox_entries_user_message_address_unique").on(
      table.userId,
      table.messageId,
      table.deliveredAddressId
    ),
    index("mailbox_entries_list_index").on(table.userId, table.mailbox, table.createdAt, table.id),
    check("mailbox_entries_mailbox_check", sql`${table.mailbox} IN ('inbox', 'sent', 'draft', 'spam', 'trash')`)
  ]
);
