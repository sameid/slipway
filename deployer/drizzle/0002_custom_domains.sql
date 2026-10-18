CREATE TABLE `domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`env` text NOT NULL,
	`hostname` text NOT NULL,
	`status` text NOT NULL,
	`certificate_arn` text,
	`validation_name` text,
	`validation_value` text,
	`error` text,
	`job_id` integer,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`checked_at` text,
	FOREIGN KEY (`app`) REFERENCES `apps`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_hostname_unique` ON `domains` (`hostname`);--> statement-breakpoint
CREATE INDEX `domains_app_env` ON `domains` (`app`,`env`);