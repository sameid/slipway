ALTER TABLE `releases` ADD `verified_at` text;--> statement-breakpoint
-- Builds before this ran type check, lint and tests themselves, so what built then counts as verified.
UPDATE `releases` SET `verified_at` = `created_at` WHERE `status` = 'ready';
