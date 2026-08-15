CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "addresses_kind_check" CHECK("addresses"."kind" IN ('primary', 'alias'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_address_unique` ON `addresses` (`address`);--> statement-breakpoint
CREATE INDEX `addresses_owner_index` ON `addresses` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `mailbox_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`delivered_address_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivered_address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mailbox_entries_mailbox_check" CHECK("mailbox_entries"."mailbox" IN ('inbox', 'sent', 'draft', 'spam', 'trash'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_entries_user_message_address_unique` ON `mailbox_entries` (`user_id`,`message_id`,`delivered_address_id`);--> statement-breakpoint
CREATE INDEX `mailbox_entries_list_index` ON `mailbox_entries` (`user_id`,`mailbox`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`visibility` text NOT NULL,
	`object_key` text NOT NULL,
	CONSTRAINT "messages_visibility_check" CHECK("messages"."visibility" IN ('staging', 'visible'))
);
--> statement-breakpoint
CREATE INDEX `messages_received_index` ON `messages` (`received_at`,`id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_status_check" CHECK("users"."status" IN ('active', 'disabled', 'deletion_pending'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);