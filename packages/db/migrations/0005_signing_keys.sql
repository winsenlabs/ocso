CREATE TABLE "signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"alg" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_ref" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retiring_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_active_uq" ON "signing_keys" USING btree ("purpose") WHERE "signing_keys"."status" = 'ACTIVE';