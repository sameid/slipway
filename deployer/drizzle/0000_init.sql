CREATE TABLE `apps` (
	`name` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`auto_merge` integer DEFAULT true NOT NULL,
	`staging_release_id` integer,
	`prod_release_id` integer,
	`staging_url` text,
	`prod_url` text,
	`error` text,
	`failed_job_id` integer,
	`destroy_requested_by` text,
	`destroy_requested_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`env` text NOT NULL,
	`kind` text NOT NULL,
	`release_id` integer,
	`pr_number` integer,
	`commit_sha` text,
	`status` text NOT NULL,
	`after_job_id` integer,
	`run_id` text,
	`requested_by` text NOT NULL,
	`failed_step` text,
	`error` text,
	`exported` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_app` ON `jobs` (`app`,`id`);--> statement-breakpoint
CREATE TABLE `login_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_failures_key` ON `login_failures` (`key`,`at`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`app` text NOT NULL,
	`number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`check_job_id` integer,
	`merged_sha` text,
	`note` text,
	`last_comment_key` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app`, `number`),
	FOREIGN KEY (`app`) REFERENCES `apps`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`commit_sha` text NOT NULL,
	`image_digest` text,
	`web_artifact` text,
	`status` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app`) REFERENCES `apps`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `releases_app_commit` ON `releases` (`app`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `secret_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`app` text NOT NULL,
	`env` text NOT NULL,
	`key` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`redeploy_job_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_links_id_unique` ON `secret_links` (`id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`app` text NOT NULL,
	`env` text NOT NULL,
	`key` text NOT NULL,
	`last_set_by` text,
	`last_set_at` text,
	PRIMARY KEY(`app`, `env`, `key`),
	FOREIGN KEY (`app`) REFERENCES `apps`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`sess` text NOT NULL,
	`expire` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_by` integer,
	`created_at` text NOT NULL,
	`last_login_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);