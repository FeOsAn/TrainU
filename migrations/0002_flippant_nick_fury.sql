CREATE TABLE `app_build` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_at` text,
	`answers_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
