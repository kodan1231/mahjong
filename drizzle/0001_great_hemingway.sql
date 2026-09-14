CREATE TABLE `yakuman_event_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`yakuman_event_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	FOREIGN KEY (`yakuman_event_id`) REFERENCES `yakuman_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yakuman_event_targets_unique` ON `yakuman_event_targets` (`yakuman_event_id`,`player_id`);