CREATE INDEX `day_participants_player_id_idx` ON `day_participants` (`player_id`);--> statement-breakpoint
CREATE INDEX `days_date_idx` ON `days` (`date`);--> statement-breakpoint
CREATE INDEX `game_sessions_day_id_idx` ON `game_sessions` (`day_id`);--> statement-breakpoint
CREATE INDEX `hand_logs_game_session_id_idx` ON `hand_logs` (`game_session_id`);--> statement-breakpoint
CREATE INDEX `session_scores_player_id_idx` ON `session_scores` (`player_id`);--> statement-breakpoint
CREATE INDEX `yakuman_events_day_id_idx` ON `yakuman_events` (`day_id`);