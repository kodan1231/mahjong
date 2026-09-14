-- 写真の保存先をR2からD1(BLOB)に変更。photo_uploadsはまだ実データがないためドロップして作り直す。
DROP TABLE `photo_uploads`;
--> statement-breakpoint
CREATE TABLE `photo_uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_session_id` integer,
	`image_data` blob NOT NULL,
	`content_type` text NOT NULL,
	`ocr_raw_json` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`game_session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
