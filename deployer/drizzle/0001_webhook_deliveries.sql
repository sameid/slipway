CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` text,
	`event` text NOT NULL,
	`action` text,
	`repo` text,
	`app` text,
	`summary` text,
	`outcome` text NOT NULL,
	`detail` text,
	`job_id` integer,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_app` ON `webhook_deliveries` (`app`,`id`);