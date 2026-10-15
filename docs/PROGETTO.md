# Progetto – Stampa 3D su commissione (su base MakerWorks)

Documento di continuità: permette di riprendere il lavoro in una nuova sessione.
Ultimo aggiornamento: Fase 1B – S1, S4, S5, S6 e S7 corrette (vedi `docs/SICUREZZA-VERIFICA.md`). Precedente: attività 1.4 (verifica sicurezza: vedi `docs/SICUREZZA-VERIFICA.md`; mappa dipendenze: `docs/MAPPA-DIPENDENZE.md`).

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
| 1 – Struttura del progetto | In corso (1.1 ramo creato, 1.2 baseline eseguita, 1.3 mappa dipendenze completata, 1.4 verifica sicurezza completata: S1–S6 confermati). **Fase 1B in corso: S1, S4, S5, S6, S7 corrette e verificate; prossime S2+S3 (in attesa di autorizzazione)** |
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

## Ambiente

- PostgreSQL 16 è installato nell'ambiente di lavoro ma spento; va avviato per i test con database.
- Variabili d'ambiente: vedi `.env.example`. Non inserire mai valori segreti in questo file.

## Da fare / problemi aperti

### Da risolvere PRIMA DEL LANCIO (registrati, non ancora corretti)

1. **Checkout amministratore: totale sempre a zero.** Quando un admin usa il checkout, qualunque metodo scelga, l'ordine è "senza addebito" (`free`) ed entra in produzione. Per un ordine a pagamento inserito da un admin oggi serve la creazione ordine (`/api/admin/orders`) con autorizzazione esplicita. Da riprogettare (probabilmente insieme a S2/S3).
2. **Errore StockWorks dopo l'aggiornamento dello stato.** `PATCH /api/admin/orders/[id]/status` verso `shipped`/`completed` risponde 400 "StockWorks is not configured" **dopo** aver salvato lo stato, perché il consumo di inventario non è opzionale. Da sistemare nella semplificazione (StockWorks verrà disattivato).
3. **Test del carrello completo con colori e materiali reali.** Non è mai stato provato il percorso aggiungi al carrello → checkout → conferma con colori/materiali reali (la tavolozza dei colori dipende da un servizio di inventario non configurato; "Save to cart" resta disattivato). Da verificare con una configurazione reale di materiali e colori (Fase 2).
4. (altri già noti) eseguire `scripts/hold-unpaid-orders.js` e `scripts/privatize-customer-models.js` in modalità prova sui dati reali; valori di prezzo predefiniti troppo bassi (Fase 3); rimborsi/contestazioni che non riportano indietro un ordine già in produzione.

- **Sicurezza (Fase 1B)**: S1, S4, S5, S6, S7 CORRETTE. Ancora aperti, con test `todo` che oggi falliscono: S2 (importo non confrontato) e S3 (pagamento senza ordine) — si risolvono insieme con la migrazione a Stripe Checkout. Dettagli in `docs/SICUREZZA-VERIFICA.md`.
- Preesistente da sistemare: il cambio stato `shipped`/`completed` risponde 400 "StockWorks is not configured" dopo aver salvato (inventario non opzionale).
- Eseguire `scripts/hold-unpaid-orders.js` (prova) sui dati reali prima del lancio.
- Rimozione dei file di scarto nella radice (`tmp.stl` 14 MB, `tmp_snip.txt`, `tmp_viewer.txt`, `.tmp/`) – da approvare.
- Valori di prezzo predefiniti molto bassi (costi di macchina/manodopera/energia a zero se non configurati): da sistemare in Fase 3.

## Decisioni tecniche

- Webhook Stripe (S4): evento e aggiornamento ordini nella stessa transazione PostgreSQL; righe d'ordine bloccate prima di leggere lo stato attuale da Stripe; `ON CONFLICT DO NOTHING` per i duplicati e la concorrenza; 2xx solo se elaborato / già elaborato / non pertinente, 500 (riprovabile) altrimenti. Nessuna coda. Modulo `lib/stripe-webhook.ts`. Riconciliazione con Stripe alla creazione dell'ordine (`lib/orders.ts`) finché l'ordine nasce dal browser (fino a S2/S3).

- Pagamenti (S5): ospiti/clienti/staff solo carta o preventivo; cash, fattura, PO, senza addebito e PayPal solo admin. Un ordine entra in produzione solo con pagamento verificato (`paid`/`free`) o autorizzazione esplicita di un admin (registrata). Regola unica in `lib/order-payment-policy.ts`, applicata a ogni transizione. Il checkout di un admin è sempre un ordine senza addebito (comportamento esistente).

- Riservatezza: il servizio è una stampa su commissione. Un modello di un cliente è sempre privato (visibile a proprietario, staff, admin); solo i modelli di account del negozio possono essere pubblici/non in elenco. Nessun consenso alla pubblicazione è implementato. Regola unica in `lib/model-access.ts`; utente della richiesta in `lib/viewer.ts`. I dati esistenti non vengono modificati; `scripts/privatize-customer-models.js` allinea il database (prova di default).
- Il caricamento senza account è disattivato finché non viene progettato un account ospite (Fase 2).

- File: tutti i file passano da `/files` con la politica `lib/file-access.ts` (negato per impostazione predefinita). Modalità CDN (`FILES_BASE_URL`) eliminata perché aggirava i controlli. Backup: solo admin.

- Base applicativa: mkw2 semplificata (approvata dall'utente).
