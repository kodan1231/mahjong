PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_session_id` integer NOT NULL,
	`seat_index` integer NOT NULL,
	`player_id` integer NOT NULL,
	`raw_score` real,
	`is_hakoware` integer DEFAULT false NOT NULL,
	`rank` integer,
	`rank_chip` integer,
	FOREIGN KEY (`game_session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_session_scores`("id", "game_session_id", "seat_index", "player_id", "raw_score", "is_hakoware", "rank", "rank_chip") SELECT "id", "game_session_id", "seat_index", "player_id", "raw_score", "is_hakoware", "rank", "rank_chip" FROM `session_scores`;--> statement-breakpoint
DROP TABLE `session_scores`;--> statement-breakpoint
ALTER TABLE `__new_session_scores` RENAME TO `session_scores`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `session_scores_seat_unique` ON `session_scores` (`game_session_id`,`seat_index`);--> statement-breakpoint
-- raw_scoreの単位を「素点」（例: 32000）から「ポイント」（例: 32、素点÷1000）に変更したため、既存データを換算する。
UPDATE `session_scores` SET `raw_score` = `raw_score` / 1000.0 WHERE `raw_score` IS NOT NULL;