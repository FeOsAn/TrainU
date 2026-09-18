CREATE TABLE `conditions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`body_part` text,
	`severity` integer NOT NULL,
	`restrictions_json` text DEFAULT '[]' NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_check_ins` (
	`date` text PRIMARY KEY NOT NULL,
	`sleep_quality` integer NOT NULL,
	`soreness` integer NOT NULL,
	`energy` integer NOT NULL,
	`resting_hr_bpm` integer,
	`note` text,
	`adjustments_json` text DEFAULT '[]' NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `physique_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`weight_kg` real,
	`body_fat_percent` real,
	`waist_cm` real,
	`note` text,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `physique_entries_date_unique` ON `physique_entries` (`date`);--> statement-breakpoint
ALTER TABLE `session_completions` ADD `reason` text;