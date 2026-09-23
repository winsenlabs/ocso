-- ADR-025: OCSO's hand-built sessions are replaced by auth_sessions (Better Auth); password hashes now live in
-- auth_accounts (moved by 0014). Existing sessions cannot be carried over, so everyone signs in again once.
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";
