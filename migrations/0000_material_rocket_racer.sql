CREATE TABLE `app_identity` (
	`app` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `athlete_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`fields_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `capability_gaps` (
	`capability` text PRIMARY KEY NOT NULL,
	`wanted_by_json` text DEFAULT '[]' NOT NULL,
	`planned_block_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garmin_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`password` text,
	`token_json` text,
	`token_expires_at` text,
	`auth_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`discipline` text DEFAULT 'other' NOT NULL,
	`label` text NOT NULL,
	`target_date` text NOT NULL,
	`priority` integer NOT NULL,
	`success_criteria` text NOT NULL,
	`target_metrics_json` text DEFAULT '{}' NOT NULL,
	`constraints_json` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outcome_log` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text,
	`kind` text NOT NULL,
	`predicted_at` text NOT NULL,
	`prediction_json` text NOT NULL,
	`actual_json` text,
	`observed_at` text
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`connectors_json` text DEFAULT '{}' NOT NULL,
	`features_json` text DEFAULT '{}' NOT NULL,
	`blocks_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_completions` (
	`key` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`prescribed_json` text,
	`rpe` integer,
	`note` text,
	`session_id` text,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `training_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`sport` text NOT NULL,
	`source` text NOT NULL,
	`start_time` text,
	`duration_minutes` integer NOT NULL,
	`distance_km` real,
	`avg_heart_rate` integer,
	`max_heart_rate` integer,
	`avg_pace_sec_per_km` integer,
	`avg_pace_sec_per_100m` integer,
	`avg_power_watts` integer,
	`normalized_power` integer,
	`tss` real,
	`hr_zones_json` text,
	`rpe` text,
	`external_id` text
);
--> statement-breakpoint
CREATE TABLE `whoop_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` text,
	`auth_error` text,
	`updated_at` text NOT NULL
);
