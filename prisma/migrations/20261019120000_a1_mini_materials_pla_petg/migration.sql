-- Step 4.4 (decision of the shop owner): the first machine, the Bambu Lab A1 mini, offers PLA and PETG. TPU (and any other material) is enabled only
-- after the owner confirms it, from Admin -> Printer machines, without touching the code.
--
-- DATA ONLY and careful not to overwrite anything a person chose: the row is changed ONLY while its material list is still EXACTLY the starting list
-- inserted by 20261018120000_printer_machines (PLA, PETG, TPU). If an administrator has already edited the list in any way (added or removed any
-- material, changed the order), the row is left alone. Running this again changes nothing. The volume (180 x 180 x 180 mm) and every other column are untouched.
UPDATE "PrinterMachine"
SET "allowedMaterials" = ARRAY['PLA', 'PETG']::TEXT[],
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'bambu-a1-mini'
  AND "allowedMaterials" = ARRAY['PLA', 'PETG', 'TPU']::TEXT[];
