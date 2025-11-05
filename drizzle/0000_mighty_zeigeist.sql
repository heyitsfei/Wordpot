CREATE TABLE `deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`sender` text NOT NULL,
	`token` text NOT NULL,
	`amount` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `eligible_players` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `game_number_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`state` text NOT NULL,
	`target_word` text NOT NULL,
	`winner_user_id` text,
	`created_at` integer NOT NULL,
	`won_at` integer,
	`game_number` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guesses` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	`guess` text NOT NULL,
	`feedback` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`token` text NOT NULL,
	`amount` text NOT NULL,
	`tx_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pools` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`token` text NOT NULL,
	`tracked_balance` text NOT NULL,
	`last_updated` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
