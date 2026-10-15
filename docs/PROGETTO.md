# Progetto – Stampa 3D su commissione (su base MakerWorks)

Documento di continuità: permette di riprendere il lavoro in una nuova sessione.
Ultimo aggiornamento: Fase 1B – S1, S4, S5, S6 e S7 corrette; S2+S3 in corso, Passi 1, 2 e 3 completati e Passo 4 avviato (4.0 interventi prioritari completato) (vedi `docs/CHECKOUT-S2-S3.md` e `docs/SICUREZZA-VERIFICA.md`). Precedente: attività 1.4 (verifica sicurezza: vedi `docs/SICUREZZA-VERIFICA.md`; mappa dipendenze: `docs/MAPPA-DIPENDENZE.md`).

## Regole concordate

- Unica applicazione (Next.js + PostgreSQL). Nessun microservizio.
- `mkw2` è l'unica repository di lavoro. `3D-Printing-Quote-Engine` e `checkout-one-time-payments` sono solo riferimenti (non si modificano).
- Si lavora **solo** sul ramo `claude/stampa3d-fase1`; `main` resta intatto.
- Semplificazione progressiva: prima **disattivare**, eliminare solo dopo l'analisi delle dipendenze e l'approvazione.
- Priorità alla sicurezza: file privati, autorizzazioni, pagamenti Stripe, webhook.
- Un componente non è "funzionante" solo perché il codice esiste: va provato e lo stato va annotato.
- Shippo si integra dopo il lancio.

## Stato delle fasi

| Fase | Stato |
|---|---|
| 0 – Analisi | Completata |
| 1 – Struttura del progetto | In corso (1.1 ramo creato, 1.2 baseline eseguita, 1.3 mappa dipendenze completata, 1.4 verifica sicurezza completata: S1–S6 confermati). **Fase 1B in corso: S1, S4, S5, S6, S7 corrette e verificate; S2+S3 in corso: architettura approvata, Passi 1, 2 e 3 di 7 completati (migrazione, EUR, calcolo prezzi, imposte; ordine in attesa, sessione Stripe, endpoint quote/session, token ospite; riconoscimento del pagamento con verifica unica, permesso per ordine, effetti dopo il pagamento, vecchio checkout bloccato in produzione); il Passo 4 è in corso: 4.0 (ristampa, OrderWorks in ingresso, permesso tra processi, API ordini del cliente) completato, 4.1–4.6 attendono il via dopo il punto di controllo C0** (piano nel documento di lavoro approvato; elenco delle verifiche da fare fuori dall'ambiente di sviluppo in `docs/CHECKLIST-PRELANCIO.md`) (piano in `docs/CHECKOUT-S2-S3.md`) |
| 2 – Upload e configurazione | Da fare |
| 3 – Preventivazione | Da fare |
| 4 – Acquisto | Da fare |
| 5 – Gestione operativa | Da fare |
| 6 – Test e sicurezza | Da fare |
| 7 – Pubblicazione | Da fare |
| 8 – Evoluzione (Shippo ecc.) | Da fare |

## Baseline del progetto originale (commit `f83bee9`, prima di ogni modifica)

Ambiente: Node 22.22, npm 10.9, Linux. Valori d'ambiente finti usati solo per la build.

| Controllo | Esito |
|---|---|
| `npm ci` | OK (901 pacchetti) |
| `prisma generate` | OK |
| `npm run typecheck` | OK, 0 errori |
| `npm run lint` | OK, 0 avvisi |
| `npm run build` | OK |
| `npm test` | 203 superati, **2 falliti** (vedi sotto) |
| `npm run test:api` | OK 7/7 (database di prova locale) |
| `npm run test:contracts` | OK 14/14 (database di prova locale) |
| `npm run e2e` | **Non ancora eseguito** (serve browser) |

### Problemi già presenti nell'originale (non introdotti da noi)

1. `tests/r3dr-branding.test.ts` – "global layout includes r3Dr parent-company branding": il test cerca nel CSS una regola `.footer-shell { border-radius: 1.25rem }` che non esiste. Test non allineato al codice; non riguarda funzioni di acquisto.
2. `tests/suite-demo-seed.test.ts` – "resolveSiblingRepoPath resolves suite repos beside MakerWorks": il test usa percorsi Windows (`C:/Users/steph/...`) e non può passare su Linux.

Entrambi sono estranei a upload, prezzi, ordini e pagamenti. Si decideranno in seguito se correggerli o rimuoverli insieme alle funzioni a cui appartengono.

### Dimensioni del progetto

121 moduli in `lib/`, 156 route API, 50 pagine, 40 migrazioni Prisma.
Node_modules ≈ 965 MB.

## Ambiente di prova (sicurezza)

- Cluster PostgreSQL locale `mkwtest` su `127.0.0.1:55432`, database `mkw_sectest` (creato con `pg_createcluster 16 mkwtest -p 55432`; migrazioni applicate con `prisma migrate deploy`). Solo dati fittizi.
- Test: `SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security`. I test si rifiutano di partire su database non locali o con nome diverso da `*_sectest`.

Per le altre suite con database (`npm test`, `test:api`, `test:contracts`) usare lo stesso database di prova: `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest JWT_SECRET=<almeno 32 caratteri>`. Dopo un riavvio dell'ambiente il cluster va riacceso: `pg_ctlcluster 16 mkwtest start`. Nuove migrazioni sul database di prova: `DATABASE_URL=… npx prisma migrate deploy`.

## Ambiente

- PostgreSQL 16 è installato nell'ambiente di lavoro ma spento; va avviato per i test con database.
- Variabili d'ambiente: vedi `.env.example`. Non inserire mai valori segreti in questo file.

## Da fare / problemi aperti

### Da risolvere PRIMA DEL LANCIO (registrati, non ancora corretti)

1. **Checkout amministratore: totale sempre a zero.** Quando un admin usa il checkout, qualunque metodo scelga, l'ordine è "senza addebito" (`free`) ed entra in produzione. Per un ordine a pagamento inserito da un admin oggi serve la creazione ordine (`/api/admin/orders`) con autorizzazione esplicita. Da riprogettare (probabilmente insieme a S2/S3).
2. **Errore StockWorks dopo l'aggiornamento dello stato.** `PATCH /api/admin/orders/[id]/status` verso `shipped`/`completed` risponde 400 "StockWorks is not configured" **dopo** aver salvato lo stato, perché il consumo di inventario non è opzionale. Da sistemare nella semplificazione (StockWorks verrà disattivato).
3. **Test del carrello completo con colori e materiali reali.** Non è mai stato provato il percorso aggiungi al carrello → checkout → conferma con colori/materiali reali (la tavolozza dei colori dipende da un servizio di inventario non configurato; "Save to cart" resta disattivato). Da verificare con una configurazione reale di materiali e colori (Fase 2).
4. **Configurazione fiscale (BLOCCANTE per la vendita).** `taxCents = 0` è provvisorio. Prima di pubblicare servono: scelta del regime e dell'aliquota con il commercialista, `TAX_MODE` (`none` / `inclusive` / `exclusive`) e `TAX_RATE_PERCENT` impostati, regole di arrotondamento e di numerazione fiscale (l'`orderNumber` è interno, non fiscale). In produzione, senza configurazione valida, il checkout a pagamento verrà rifiutato (guardia applicata dal Passo 2) e il controllo ambiente admin lo segnala come richiesto.
5. **Passaggio a EUR (procedura esplicita, vedi "Cambio di valuta").** Nessun importo storico viene convertito automaticamente. Prima del lancio: impostare `CURRENCY` e `NEXT_PUBLIC_CURRENCY` a `EUR`, riconfigurare i prezzi di listino in euro (Fase 3) e verificare i totali aggregati.
6. **Totali amministrativi che sommano valute diverse.** `app/api/admin/users/[id]/route.ts`, `lib/admin/queries.ts`, `app/api/customer/organizations/[organizationId]/usage/route.ts` e `lib/project-workspaces.ts` sommano `totalCents` di tutti gli ordini senza distinguere la valuta: con ordini storici in USD accanto a ordini in EUR i totali sarebbero sbagliati. Se il database di produzione parte vuoto il problema non si pone; altrimenti raggruppare per valuta o filtrare (non corretto: fuori dal Passo 1).
7. **Deriva preesistente tra migrazioni e schema.** `prisma migrate diff` segnala che l'indice su `ModelComment(partId)` è nello schema ma non nelle migrazioni (verificato anche sul commit `268b2bd`, prima delle nostre modifiche). `migrate deploy` funziona comunque; decidere se allineare prima del lancio.
8. **Il vecchio checkout con carta NON va usato in produzione** finché il Passo 6 non lo chiude. Dal Passo 3 è **bloccato in produzione** (503 `LEGACY_CARD_CHECKOUT_DISABLED`) salvo `LEGACY_CARD_CHECKOUT_ENABLED=true`, che **deve restare spento** (il controllo ambiente admin lo segnala); anche acceso ora confronta importo e valuta, rifiuta un PaymentIntent già usato, ma crea ancora l'ordine solo dal browser (S3) e ha ancora il ripiego sull'intestazione `Host`. Resta solo per migrazione e prove.
9. **Interruttore del nuovo checkout.** In produzione `HOSTED_CHECKOUT_ENABLED=true` va impostato solo dopo il Passo 4 (pagine del cliente; il riconoscimento del pagamento c'è dal Passo 3). `BASE_URL` deve essere `https://…`, `TAX_MODE` impostato (vedi punto 4) e `SHIPPING_FLAT_RATE_CENTS` impostato se si spedisce. Sul punto di arrivo dei webhook di Stripe vanno abilitati gli eventi elencati in `docs/CHECKOUT-S2-S3.md` ("Configurazione di Stripe").
10. **Configurazione del proxy di produzione (Fase 7):** `X-Forwarded-For` (limitazione richieste) e `X-Forwarded-Proto: https` (cookie `Secure`, anche del token ospite) oppure `COOKIE_SECURE=true`. Orologio del server sincronizzato (le sessioni Stripe hanno una scadenza di 32 minuti calcolata dal nostro orologio).
11. **Ordini non pagati.** Gli ordini creati prima del pagamento e mai pagati vengono chiusi dall'evento di scadenza della sessione (Passo 3, dopo aver verificato che non ci sia pagamento) e, per quelli che l'evento non raggiunge, dallo script di riconciliazione (Passo 5); le viste di coda (`lib/production.ts` e altre) includono `awaiting_payment` e il badge cliente lo mostra come "Queued": da correggere (etichetta "In attesa di pagamento", viste di coda con `productionEligibleOrderWhere`). La numerazione `orderNumber` avrà buchi (ordini annullati).
12. **Fatturazione per organizzazione** non supportata dal nuovo checkout (le funzioni delle organizzazioni sono candidate a essere rimosse nella semplificazione). Il rapporto di producibilità PDF nel nuovo flusso è creato al pagamento verificato (effetto `report`, Passo 3; usa le righe salvate in `metadata.checkout.lines`).
13. **Residui del Passo 3 da chiudere (dettagli in `docs/CHECKOUT-S2-S3.md`, "Non verificato / limiti")**: (a) un effetto dopo il pagamento fallito (ricevuta, rapporto, notifica, PrintLab) non viene riprovato da solo finché non c'è lo script del Passo 5 (`recoverPostPaymentEffects`); (b) i pagamenti senza ordine sono registrati ed elencabili (`findUnmatchedPaymentEvents`) ma serve il comando del Passo 5; (c) `StripeEvent.payload` ora contiene anche email e indirizzo del cliente: definire la conservazione (es. 90 giorni); (d) l'aggiornamento manuale admin parte da un PaymentIntent e non trova un ordine del nuovo checkout non ancora collegato: si risolve con la riconciliazione per sessione (Passo 5); (e) `autoSubmitOrderToPrintLab` scrive i metadati senza blocco di riga (preesistente); (f) il percorso OrderWorks si fida dello stato di pagamento della scheda (non toccato); (g) due schede che creano un ordine nello stesso istante possono sovrascriversi il cookie ospite (rischio basso); (h) nessuna prova con Stripe reale né con più processi del server insieme; (i) ~~ristampa~~ **corretta nel Passo 4.0a**: ora è una richiesta di preventivo (`awaiting_review`, `quote`, nessuna eredità; gratuita solo con autorizzazione admin motivata); restano i testi in inglese della pagina ordini e le viste di produzione che mostrano `awaiting_review` come "in coda" (punto 11).
14. **OrderWorks in ingresso** (`POST /api/makerworks/jobs`): dal Passo 4.0b è spento in produzione se `ORDERWORKS_INBOUND_ENABLED` non è `true` (il controllo ambiente admin lo segnala se acceso). **Deve restare spento** salvo uso reale; il segreto `MAKERWORKS_INBOUND_SECRET` è condiviso con le rotte PrintLab/G-code (consigliati segreti distinti). L'admin può ancora segnare "pagato" una scheda (`PATCH /api/jobs/[paymentIntentId]`): azione esplicita, non registrata come autorizzazione.
15. **Verifiche fuori dall'ambiente di sviluppo**: tutte in `docs/CHECKLIST-PRELANCIO.md` (Stripe in modalità test, smartphone veri Android e iOS, sicurezza della pubblicazione, accessibilità, integrità ordini, infrastruttura…), tutte "da eseguire"; nessuna conta come superata finché non è eseguita nell'ambiente indicato.
16. (altri già noti) eseguire `scripts/hold-unpaid-orders.js` e `scripts/privatize-customer-models.js` in modalità prova sui dati reali; valori di prezzo predefiniti troppo bassi (Fase 3); rimborsi/contestazioni che non riportano indietro un ordine già in produzione.

- **Sicurezza (Fase 1B)**: S1, S4, S5, S6, S7 CORRETTE. S2 (importo non confrontato) e S3 (pagamento senza ordine): il nuovo percorso (Stripe Checkout ospitato) le chiude dal Passo 3 e il vecchio percorso è bloccato in produzione e verifica l'importo, ma restano da fare l'interfaccia (Passo 4), lo script di riconciliazione (Passo 5) e la rimozione del vecchio ramo (Passo 6): S2/S3 si dichiarano corrette solo allora. Nessun test `todo` rimasto. Dettagli in `docs/SICUREZZA-VERIFICA.md`.
- Preesistente da sistemare: il cambio stato `shipped`/`completed` risponde 400 "StockWorks is not configured" dopo aver salvato (inventario non opzionale).
- Eseguire `scripts/hold-unpaid-orders.js` (prova) sui dati reali prima del lancio.
- Rimozione dei file di scarto nella radice (`tmp.stl` 14 MB, `tmp_snip.txt`, `tmp_viewer.txt`, `.tmp/`) – da approvare.
- Valori di prezzo predefiniti molto bassi (costi di macchina/manodopera/energia a zero se non configurati): da sistemare in Fase 3.

## Cambio di valuta (EUR)

- La valuta del negozio è un'impostazione di installazione: `CURRENCY` (lato server) e `NEXT_PUBLIC_CURRENCY` (lato client). Valori supportati: USD, CAD, AUD, **EUR**. Se non impostata resta **USD** (nessun cambiamento implicito).
- **Nessuna conversione automatica.** Ogni ordine conserva la propria valuta (`PrintOrder.currency`) e le pagine ordine la usano per mostrarlo. I numeri di listino (`priceUsd`, `…Usd` di `SiteConfig`, variabili `*_USD`) non hanno una valuta: con `CURRENCY=EUR` sono letti come euro **così come sono**. Questo è già il comportamento per CAD/AUD; per EUR non esistono variabili `*_EUR`.
- Procedura per passare a EUR su un'installazione con dati:
  1. controllare quali valute esistono: `SELECT currency, count(*) FROM "PrintOrder" GROUP BY 1;`
  2. fare un backup del database;
  3. impostare `CURRENCY=EUR` e `NEXT_PUBLIC_CURRENCY=EUR` e riavviare;
  4. riconfigurare in euro i prezzi (Impostazioni sito, prezzi dei modelli, `sale`, parti) — i vecchi numeri non diventano euro per magia;
  5. verificare i totali aggregati dell'amministrazione (vedi elemento 6 dell'elenco "prima del lancio").
- Gli ordini storici in USD non vengono modificati. Una conversione con tasso di cambio, se mai servisse, sarà uno script a parte, in prova di default e con approvazione.

## Decisioni tecniche

- Checkout con Stripe ospitato (S2/S3): ordine creato **prima** del pagamento con totale congelato, sessione Stripe legata all'ordine (`PaymentAttempt`), conferma solo da dati verificati con Stripe (importo, valuta, ordine), produzione una sola volta. Solo carta e wallet nella prima versione (nessun metodo asincrono). Solo spedizioni in Italia con tariffa configurabile. Riconciliazione manuale con uno script documentato, senza pagina admin. Dettagli, precisazioni dell'utente e piano a passi in `docs/CHECKOUT-S2-S3.md`.
- Nuovo checkout (Passo 2): ordine creato prima del pagamento con totale congelato (`lib/checkout-orders.ts`), sessione Stripe con prenotazione del tentativo prima della chiamata e chiave di idempotenza (`lib/checkout-sessions.ts`), nessuna transazione aperta durante le chiamate a Stripe; solo carta e wallet; spedizione solo Italia con tariffa unica `SHIPPING_FLAT_RATE_CENTS` (mai gratuita per dimenticanza); guardie in produzione (`lib/checkout-guards.ts`: interruttore, Stripe, IVA, spedizione); token ospite derivato (HMAC) in cookie `HttpOnly`, nel database solo l'hash con scadenza (`lib/guest-order-access.ts`). Il browser invia solo carrello, consegna, chiave e il totale mostrato (solo per confronto).
- Calcolo prezzi: un unico modulo `lib/checkout-quote.ts` (tre passi: contesto, righe, totali), usato dal checkout attuale e dai percorsi nuovi; imposte in `lib/tax.ts`; importi sempre in centesimi interi. Il test di riferimento `tests/security/checkout-golden.sec.ts` (snapshot `tests/fixtures/checkout-golden.json`, 72 scenari registrati dal codice precedente) protegge i prezzi: si aggiorna solo di proposito (`UPDATE_GOLDEN=1`), per esempio quando in Fase 3 cambiano i prezzi.

- Webhook Stripe (S4, rivisto al Passo 3): l'evento è solo un indizio, lo stato si rilegge sempre da Stripe **fuori** da ogni transazione; per ordine c'è un permesso temporaneo (45 s) che impedisce a due cicli di leggere-e-applicare insieme (nessuna ipotesi che gli stati di Stripe vadano solo avanti); evento registrato e risultato scritti nella stessa transazione breve; duplicati e concorrenza gestiti con `createMany skipDuplicates`; 2xx solo se elaborato / già elaborato / non pertinente, 500 (riprovabile) altrimenti. Nessuna coda. Moduli `lib/payment-sync.ts`, `lib/payment-verification.ts`, `lib/stripe-webhook.ts`. Riconciliazione con Stripe alla creazione dell'ordine (`lib/orders.ts`) finché esiste il vecchio flusso.

- Pagamenti (S5): ospiti/clienti/staff solo carta o preventivo; cash, fattura, PO, senza addebito e PayPal solo admin. Un ordine entra in produzione solo con pagamento verificato (`paid`/`free`) o autorizzazione esplicita di un admin (registrata). Regola unica in `lib/order-payment-policy.ts`, applicata a ogni transizione. Il checkout di un admin è sempre un ordine senza addebito (comportamento esistente).

- Riservatezza: il servizio è una stampa su commissione. Un modello di un cliente è sempre privato (visibile a proprietario, staff, admin); solo i modelli di account del negozio possono essere pubblici/non in elenco. Nessun consenso alla pubblicazione è implementato. Regola unica in `lib/model-access.ts`; utente della richiesta in `lib/viewer.ts`. I dati esistenti non vengono modificati; `scripts/privatize-customer-models.js` allinea il database (prova di default).
- Il caricamento senza account è disattivato finché non viene progettato un account ospite (Fase 2).

- File: tutti i file passano da `/files` con la politica `lib/file-access.ts` (negato per impostazione predefinita). Modalità CDN (`FILES_BASE_URL`) eliminata perché aggirava i controlli. Backup: solo admin.

- Base applicativa: mkw2 semplificata (approvata dall'utente).
