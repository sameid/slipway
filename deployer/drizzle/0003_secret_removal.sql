ALTER TABLE `secret_links` ADD `deploy_requested` integer;--> statement-breakpoint
ALTER TABLE `secrets` ADD `remove_requested_by` text;--> statement-breakpoint
ALTER TABLE `secrets` ADD `remove_requested_at` text;--> statement-breakpoint
ALTER TABLE `secrets` ADD `remove_job_id` integer;