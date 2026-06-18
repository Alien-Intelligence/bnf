-- AlterTable: add alien_user_id to user for SSO identity linking
ALTER TABLE "user" ADD COLUMN "alien_user_id" TEXT;

-- CreateTable: track which onboarding intros a user has dismissed
CREATE TABLE "user_onboarding_seen" (
    "user_id" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_onboarding_seen_pkey" PRIMARY KEY ("user_id","intro")
);

-- CreateIndex: enforce uniqueness of alien_user_id across all users
CREATE UNIQUE INDEX "user_alien_user_id_key" ON "user"("alien_user_id");

-- AddForeignKey: cascade-delete onboarding records when the user is deleted
ALTER TABLE "user_onboarding_seen" ADD CONSTRAINT "user_onboarding_seen_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
