# DR-13 — migrazioni, dati legacy, verifica e rollback (Fase 6)

Una sola pagina Stripe pagabile per ordine (DR-13) si regge su **due migrazioni additive**. Questo documento dice che cosa fanno, come arrivano sul database, che cosa è stato **provato** (e dove), che cosa fare dei dati lasciati dal codice precedente e come tornare indietro **senza toccare un solo dato**.

**Stato:** tutto provato su database temporanei del cluster di prova locale (nomi che finiscono in `_sectest`, creati e distrutti dal test). **Nessuna migrazione è stata applicata a un database condiviso o di produzione.** DR-13 non è chiusa: l'audit indipendente, la prova su Stripe in modalità test (a cura del titolare) e le prove su dispositivi veri restano da fare (`docs/CHECKLIST-PRELANCIO.md`).

## 1. Le due migrazioni

| Migrazione | SQL | Effetto | Rollback |
|---|---|---|---|
| `20261104120000_dr13_request_hash` | `ALTER TABLE "PaymentAttempt" ADD COLUMN "requestHash" TEXT;` | colonna **nullabile**, nessun valore predefinito, nessuna riga riscritta. Contiene l'impronta della richiesta di creazione della pagina (serve a non rispedire mai una richiesta non dimostrabilmente identica). Il codice precedente non la conosce e la ignora. | **nessuno necessario**: la colonna può restare. Toglierla perderebbe le impronte e non serve a tornare al codice precedente. |
| `20261104130000_dr13_single_live_page` | `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAttempt_orderId_live_page_key" ON "PaymentAttempt" ("orderId") WHERE "status" IN ('creating', 'open');` | rete di sicurezza fisica: due tentativi vivi (`creating` / `open`) per lo stesso ordine sono impossibili. Nessun dato letto o spostato. | `DROP INDEX "PaymentAttempt_orderId_live_page_key";` — nessun dato perso (§5). |

Tempi e blocchi **[D: comportamento documentato di PostgreSQL, non misurato qui]**: l'aggiunta di una colonna nullabile senza valore predefinito prende un blocco esclusivo brevissimo (solo metadati); `CREATE UNIQUE INDEX` senza `CONCURRENTLY` blocca le scritture su `PaymentAttempt` per il tempo della costruzione (la tabella è piccola). Entrambe le cose vanno fatte con il checkout sospeso (§2).

Prisma **non modella** l'indice parziale: `prisma/schema.prisma` non lo contiene e `prisma migrate diff` non segnala deriva né con l'indice né senza (provato, §3).

## 2. Come arrivano sul database — e perché il controllo va fatto PRIMA dell'avvio

`scripts/start-production.js` esegue **`npx prisma migrate deploy` a ogni avvio del contenitore** (`restore` → `migrate deploy` → `bootstrap-admin` → server). Una nuova immagine con DR-13 applica quindi **entrambe** le migrazioni, in ordine, nello stesso avvio: prima la colonna, poi l'indice. Non esiste un punto intermedio in cui «prima il codice, poi l'indice» con una sola immagine.

Se un ordine ha due tentativi vivi, **l'indice non si può creare**. Osservato su un database temporaneo (messaggi di Prisma, senza dati riservati):

1. primo avvio: `Error: P3018 … Migration name: 20261104130000_dr13_single_live_page … ERROR: could not create unique index "PaymentAttempt_orderId_live_page_key" DETAIL: Key ("orderId")=(<ordine>) is duplicated.` La colonna della migrazione precedente **è già applicata**; l'indice **non** esiste; nessuna riga è cambiata (la migrazione è un'unica istruzione in una transazione).
2. ogni avvio successivo, di **qualsiasi** immagine, compreso il codice precedente: `Error: P3009 migrate found failed migrations in the target database, new migrations will not be applied.` Il contenitore esce con errore e non parte finché la migrazione fallita non è risolta (`prisma migrate resolve --rolled-back 20261104130000_dr13_single_live_page`: scrive solo nella tabella `_prisma_migrations`, non nei dati del negozio; è comunque una scrittura sul database e **va approvata dal titolare**).

Conseguenza: **il controllo si fa prima di avviare l'immagine nuova**, sul database di destinazione, con il rapporto di sola lettura `scripts/checkout-pages-check.sql`. Il rapporto **gira anche sullo schema precedente** (la colonna `requestHash` è letta con `to_jsonb`, proprio per questo; provato, §3). Procedura completa: `docs/RILASCIO-PRODUZIONE.md` §19 e `docs/RUNBOOK-PAGINE-STRIPE.md`.

```bash
# sola lettura, contro il database di destinazione, PRIMA di avviare l'immagine nuova
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on" -f scripts/checkout-pages-check.sql
```

**Se Q1 restituisce righe: STOP.** Non si avvia l'immagine con l'indice. Non si «puliscono» righe a mano (nessun `UPDATE`/`DELETE`). Le pagine gemelle si chiudono solo con la prova del provider, dall'applicazione; se questo richiede il codice nuovo, la strada è rilasciare **prima** una versione senza la migrazione dell'indice (spostarla al rilascio successivo) — è una scelta di rilascio del titolare, non un intervento sui dati.

## 3. Che cosa è stato provato (e da quale test)

Tutto in `tests/security/dr13-migration.sec.ts` (5 prove, database temporanei `mkw_dr13mig_*_sectest`, distrutti alla fine; lo script rifiuta qualunque database non locale).

| Richiesta | Prova | Esito |
|---|---|---|
| Applicazione dallo schema precedente | `DATA made by the old code`: le migrazioni di prima (tutte tranne le due), dati nella forma lasciata dal codice precedente, poi `migrate deploy` | applicate; **nessun tentativo cambia** (impronta md5 di tutte le colonne); indice presente |
| `requestHash` nullabile | stessa prova: `information_schema` → `text`, `is_nullable = YES`; nessuna riga con valore; una riga inserita come la inseriva il codice precedente (senza la colonna) è accettata e resta `NULL` | confermato |
| Indice univoco parziale | definizione letta da `pg_indexes`: `… USING btree ("orderId") WHERE (status = ANY (ARRAY['creating'::text, 'open'::text]))`; un secondo tentativo vivo → `23505` sulla chiave `("orderId")` | confermato |
| Rapporto Q1–Q6 | le sei interrogazioni girano in una transazione **`READ ONLY`** (una scrittura sarebbe rifiutata dal database), **prima** delle migrazioni (schema precedente) e **dopo**; l'impronta delle righe è identica prima e dopo | confermato; Q1 vuota, Q2 una riserva senza richiesta salvata, Q3/Q4 vuote, Q5/Q6 vedi §4 |
| Gemelli prima dell'indice | `TWO live attempts`: Q1 sul database **precedente** elenca esattamente l'ordine e i due tentativi; `migrate deploy` **fallisce**, a database invariato, con la colonna già applicata; un secondo `deploy` è rifiutato (`P3009`); dopo la correzione dei dati e `migrate resolve --rolled-back` si riapplica | confermato |
| Assenza di deriva Prisma | `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --exit-code` su database vuoto, **e** dopo `DROP INDEX`; più il confronto migrazioni ↔ schema su un database ombra | 0 differenze in tutti e tre i casi |
| Rollback senza operazioni distruttive | `DROP INDEX` → le righe sono identiche (impronta); la migrazione resta registrata come applicata; un nuovo `deploy` risponde «No pending migrations» e **non** ricrea l'indice; l'istruzione si riapplica (anche due volte: `IF NOT EXISTS`); con l'indice di nuovo presente un secondo tentativo vivo è rifiutato | confermato |

Due **mutanti** hanno dimostrato che la prova non è decorativa: (A) Q2 che torna a leggere `"requestHash"` direttamente → il rapporto non gira più sullo schema precedente → 2 prove rosse; (B) Q5 che torna a escludere `session_mismatch:` → la prova sui dati legacy diventa rossa. Il file è stato ripristinato e il ripristino verificato per hash.

## 4. Dati legacy, compreso `session_mismatch` non provato

Il codice **pubblicato** (`457df91`, `reopenAttempt`) scriveva `failureReason = 'session_mismatch:<problema>'` quando Stripe mostrava aperta una pagina che non corrispondeva più all'ordine: chiudeva la **riga** (`failed`, con l'identificativo della sessione) e **non chiedeva mai a Stripe di chiudere la pagina**, che restava aperta e pagabile. `createSessionForAttempt` scriveva la stessa causa su una riga **senza** identificativo. Quindi `session_mismatch:` **non è una prova di chiusura**: è soltanto una causa. Le prove sono `closed_by_us:` e `provider_status:expired` e devono stare **all'inizio** del motivo (`lib/checkout-session-plan.ts`).

Le migrazioni **non toccano** queste righe (impronta identica). Che cosa succede:

| Riga lasciata dal codice precedente | Rapporto | Che cosa fa l'applicazione |
|---|---|---|
| `failed` + identificativo + `session_mismatch:…`, ordine ancora `awaiting_payment` | Q5 (non Q6) | al prossimo ritorno del cliente il pianificatore la tratta come «chiusa senza prova» (`prove`): chiede a Stripe, scrive la prova **davanti** alla causa (`closed_by_us:<motivo> (was session_mismatch:…)` se l'abbiamo scaduta noi, `provider_status:expired (was session_mismatch:…)` se Stripe la mostra già scaduta; la causa non va persa), e **fino ad allora non apre nessuna pagina nuova** |
| come sopra, ma l'ordine è stato nel frattempo annullato/pagato/in revisione | Q5 **e** Q6 | la pagina va chiusa a prova; il prossimo segno di vita dell'ordine (evento di pagamento, pagina di conferma, ripresa del cliente) ritenta; fino ad allora resta elencata |
| `failed` + `session_mismatch:…` **senza** identificativo | Q5 | non si sa se una pagina esista: serve una persona (riconciliazione con prova positiva, `docs/RUNBOOK-PAGINE-STRIPE.md`); nessun rilascio per assenza o per tempo |
| righe `stale_reservation`, `expired`/`failed` con identificativo senza prova | Q5 (e Q6 se l'ordine non è pagabile) | stessa logica: la prova si ottiene dal provider, mai dal tempo né da un identificativo |

Dove è provato il comportamento dell'applicazione: `tests/security/dr13-legacy-mismatch.sec.ts` (19 prove sul vecchio `reopenAttempt` testuale, `tests/security/_legacy-checkout.ts`), `tests/security/dr13-closed-open.sec.ts`, `tests/security/dr13-orchestrator.sec.ts`. Questa verifica di migrazione prova l'altra metà: **i dati arrivano intatti e il rapporto li elenca per quello che sono**.

## 5. Rollback documentato — nessuna operazione distruttiva sui dati

| Situazione | Che cosa si fa | Che cosa NON si fa |
|---|---|---|
| Tornare al codice precedente | 1) **sospendere il checkout** (`HOSTED_CHECKOUT_ENABLED` diverso da `true`: `POST /api/checkout/quote` e `/session` rispondono 503 `CHECKOUT_DISABLED`; in produzione è spento di serie); 2) se il codice precedente deve poter creare una seconda pagina viva per un ordine (può farlo: è il difetto), `DROP INDEX "PaymentAttempt_orderId_live_page_key"`; 3) avviare l'immagine precedente; 4) riabilitare solo dopo la sonda 503 e la verifica. | Con l'indice presente il codice precedente non crea la seconda pagina: riceve una violazione di unicità (fallisce chiuso, rumorosamente). Non si toglie la colonna. Non si cancella né si «ripara» alcuna riga. |
| Togliere l'indice | `DROP INDEX "PaymentAttempt_orderId_live_page_key";` — le righe restano **identiche** (provato). Prisma continua a considerare la migrazione applicata e un `deploy` non lo ricrea: per rimetterlo si rilancia l'istruzione della migrazione (idempotente) dopo aver controllato che Q1 sia vuota. | `DROP TABLE`, `DELETE`, `UPDATE` su `PaymentAttempt`. |
| Migrazione dell'indice fallita (P3018 poi P3009) | il database non ha perso nulla. Si decide col titolare: correggere i dati **con il codice** (chiusura a prova) e poi `prisma migrate resolve --rolled-back 20261104130000_dr13_single_live_page` seguito da `migrate deploy`; oppure rilasciare senza quella migrazione. | Nessuna riga si chiude, si cancella o si «sistema» a mano per far passare l'indice. |
| Ripristino da backup | come in `docs/RILASCIO-PRODUZIONE.md` §16: copia verificata, ripristino su un database di prova, confronto dei conteggi. Si fa solo per un guasto che il rollback sopra non copre. | — |

## 6. Come ripetere la verifica (nessun segreto)

```bash
# cluster di prova locale isolato (127.0.0.1:55432); lo script rifiuta database non locali o non *_sectest
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest \
  node --test --test-concurrency=1 --import tsx tests/security/dr13-migration.sec.ts
```

## 7. Limiti

* Provato su PostgreSQL 16 locale con dati **costruiti** nella forma del codice precedente, non su una copia di dati reali (prima del lancio non ce ne sono; se esistono, va ripetuta la sola Q1–Q6 e il confronto sulla copia).
* I tempi di blocco sono quelli documentati da PostgreSQL, non misurati su carico reale.
* Nessuna prova con Stripe reale né in modalità test: il comportamento del provider resta quello del simulatore (`docs/RUNBOOK-PAGINE-STRIPE.md` «Limiti delle garanzie del simulatore»).
