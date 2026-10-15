-- Step 4.2-ter (A4/A8): what the machines can make, as DATA (not code), so that another machine can be added without changing the program.
-- Additive only: one new table and one row. The shop's first machine is a Bambu Lab A1 mini (180 x 180 x 180 mm, 0.4 mm nozzle).

-- CreateTable
CREATE TABLE "PrinterMachine" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "buildXmm" DOUBLE PRECISION NOT NULL,
    "buildYmm" DOUBLE PRECISION NOT NULL,
    "buildZmm" DOUBLE PRECISION NOT NULL,
    "marginXYmm" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "marginZmm" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "supportMarginXYmm" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "nozzleDiameterMm" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "minFeatureMm" DOUBLE PRECISION,
    "maxSupportRatio" DOUBLE PRECISION,
    "allowedMaterials" TEXT[],
    "allowedFinishes" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrinterMachine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrinterMachine_key_key" ON "PrinterMachine"("key");

-- CreateIndex
CREATE INDEX "PrinterMachine_isActive_idx" ON "PrinterMachine"("isActive");

-- The first machine. The margins and the material list are conservative starting values to be CONFIRMED by whoever runs the printer
-- (docs/CHECKLIST-PRELANCIO.md): they can be changed from the admin area without touching the code. Materials: what the manufacturer lists for an
-- open-frame A1 mini (PLA, PETG, TPU); the others (ABS, ASA, PA, PC, resin) are NOT offered automatically until someone adds them here.
INSERT INTO "PrinterMachine" ("id", "key", "label", "isActive", "buildXmm", "buildYmm", "buildZmm", "marginXYmm", "marginZmm", "supportMarginXYmm", "nozzleDiameterMm", "minFeatureMm", "maxSupportRatio", "allowedMaterials", "allowedFinishes", "notes", "updatedAt")
VALUES (
    'machine_bambu_a1_mini', 'bambu-a1-mini', 'Bambu Lab A1 mini', true, 180, 180, 180, 3, 2, 3, 0.4, NULL, NULL,
    ARRAY['PLA', 'PETG', 'TPU'],
    ARRAY['standard', 'matte', 'gloss', 'polished', 'textured'],
    'Initial machine. Nominal 180 x 180 x 180 mm, 0.4 mm nozzle. Margins and materials are starting values to confirm.',
    CURRENT_TIMESTAMP
) ON CONFLICT ("key") DO NOTHING;
