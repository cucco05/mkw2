# Progetto – Stampa 3D su commissione (su base MakerWorks)

Documento di continuità: permette di riprendere il lavoro in una nuova sessione.
Ultimo aggiornamento: Fase 1, attività 1.3 (analisi dipendenze: vedi `docs/MAPPA-DIPENDENZE.md`).

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
| 1 – Struttura del progetto | In corso (1.1 ramo creato, 1.2 baseline eseguita, 1.3 mappa dipendenze completata; in attesa di approvazione per il seguito) |
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
| `npm run test:api`, `test:contracts`, `e2e` | **Non ancora eseguiti** (servono database e/o browser) |

### Problemi già presenti nell'originale (non introdotti da noi)

1. `tests/r3dr-branding.test.ts` – "global layout includes r3Dr parent-company branding": il test cerca nel CSS una regola `.footer-shell { border-radius: 1.25rem }` che non esiste. Test non allineato al codice; non riguarda funzioni di acquisto.
2. `tests/suite-demo-seed.test.ts` – "resolveSiblingRepoPath resolves suite repos beside MakerWorks": il test usa percorsi Windows (`C:/Users/steph/...`) e non può passare su Linux.

Entrambi sono estranei a upload, prezzi, ordini e pagamenti. Si decideranno in seguito se correggerli o rimuoverli insieme alle funzioni a cui appartengono.

### Dimensioni del progetto

121 moduli in `lib/`, 156 route API, 50 pagine, 40 migrazioni Prisma.
Node_modules ≈ 965 MB.

## Ambiente

- PostgreSQL 16 è installato nell'ambiente di lavoro ma spento; va avviato per i test con database.
- Variabili d'ambiente: vedi `.env.example`. Non inserire mai valori segreti in questo file.

## Da fare / problemi aperti

- **Sicurezza (da riprodurre con test prima di correggere)**: S1 `/files` senza autenticazione; S2 checkout senza confronto dell'importo pagato; S3 ordine creato solo dal browser; S5 metodi senza pagamento; S6 upload pubblici di default. Dettagli in `docs/MAPPA-DIPENDENZE.md`, sezione 6.
- Rimozione dei file di scarto nella radice (`tmp.stl` 14 MB, `tmp_snip.txt`, `tmp_viewer.txt`, `.tmp/`) – da approvare.
- Eseguire `test:api` e `test:contracts` con un database di prova.
- Verificare l'accesso ai file privati (`/files/[...path]`) e le autorizzazioni di upload.
- Verificare il webhook Stripe: l'evento viene registrato prima dell'elaborazione; se l'elaborazione fallisce, il nuovo tentativo di Stripe viene scartato come duplicato (da riprodurre con un test e correggere in Fase 4).

## Decisioni tecniche

- Base applicativa: mkw2 semplificata (approvata dall'utente).
