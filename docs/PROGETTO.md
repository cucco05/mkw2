# Progetto – Stampa 3D su commissione (su base MakerWorks)

Documento di continuità: permette di riprendere il lavoro in una nuova sessione.
Ultimo aggiornamento: Fase 1B – S1, S4, S5, S6 e S7 corrette; S2+S3 in corso, Passi 1, 2 e 3 completati e Passo 4 avviato (4.0 interventi prioritari, 4.1 endpoint di stato e 4.2 checkout nuovo completati; verifica 4.2-bis carrello/preventivo/Stripe eseguita e in attesa di decisioni, vedi `docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md`; 4.3 attende il via) (vedi `docs/CHECKOUT-S2-S3.md` e `docs/SICUREZZA-VERIFICA.md`). Precedente: attività 1.4 (verifica sicurezza: vedi `docs/SICUREZZA-VERIFICA.md`; mappa dipendenze: `docs/MAPPA-DIPENDENZE.md`).

## Regole concordate

- Unica applicazione (Next.js + PostgreSQL). Nessun microservizio.
- `mkw2` è l'unica repository di lavoro. `3D-Printing-Quote-Engine` e `checkout-one-time-payments` sono solo riferimenti (non si modificano).
- Si lavora **solo** sul ramo `claude/stampa3d-fase1`; `main` resta intatto.
- Semplificazione progressiva: prima **disattivare**, eliminare solo dopo l'analisi delle dipendenze e l'approvazione.
- Priorità alla sicurezza: file privati, autorizzazioni, pagamenti Stripe, webhook.
- Un componente non è "funzionante" solo perché il codice esiste: va provato e lo stato va annotato.
- Shippo si integra dopo il lancio.

## Requisito permanente: responsive e mobile-first (vale per ogni fase, senza eccezioni)

MATERIALIZE 3D è **un'unica applicazione responsive**, progettata mobile-first, che funziona sia su computer sia su smartphone (iOS e Android). Niente versioni separate. Vale per **tutte** le funzioni: landing page, upload STL/3MF, visualizzatore 3D, configuratore, preventivi, carrello, pagamenti, area cliente, gestione degli ordini.

Cosa si garantisce (e si controlla in ogni nuova funzione, prima di dirla finita):

1. Interfaccia che si adatta a schermi piccoli e grandi; navigazione intuitiva con mouse **e** tocco.
2. Pulsanti e campi usabili con il pollice: bersagli di almeno 44 px di altezza; campi di testo con carattere di almeno 16 px (altrimenti iOS ingrandisce la pagina al tocco) e con `type`/`inputMode`/`autocomplete` giusti; la tastiera del telefono non deve coprire il campo in uso né il pulsante di conferma.
3. **Nessuno scorrimento orizzontale** indesiderato: nessun elemento più largo dello schermo (nomi lunghi che vanno a capo, tabelle che scorrono nel proprio riquadro).
4. Prestazioni: niente codice caricato inutilmente (es. Stripe.js solo dove serve), niente richieste duplicate, immagini e visualizzatore 3D caricati quando servono.
5. Visualizzatore 3D utilizzabile con i gesti del tocco (ruotare con un dito, zoom e spostamento con due dita) senza bloccare lo scorrimento della pagina.
6. Checkout semplice e completo su entrambi i dispositivi.

Come si verifica:

- **Test automatici su almeno due formati**: desktop e smartphone. In `playwright.config.ts` i progetti `chromium` (desktop), `mobile` (393×727, tocco) e `mobile-small` (360×640); ogni funzione nuova ha un file `tests/e2e/<nome>.responsive.spec.ts` che gira su tutti e tre (assenza di scorrimento orizzontale, bersagli ≥ 44 px, uso da tastiera sul desktop, stati di errore). Si lanciano con `E2E_BASE_URL=… E2E_CHROMIUM_PATH=… npx playwright test`. Prova di mutazione: rompere di proposito il layout deve far fallire il test.
- **Questi test usano Chromium con emulazione** (dimensione, tocco, agente utente). **Non sono Safari e non sono un telefono vero**: non dimostrano il comportamento di iOS/Safari (barra degli indirizzi che si ritrae, tastiera, tasto Indietro, cookie con la prevenzione del tracciamento, gesti) né di Android reale. Per questo le prove su **iPhone (Safari), Android (Chrome) reali** sono **verifiche obbligatorie prima del lancio** (`docs/CHECKLIST-PRELANCIO.md`, 1.3, 1.4 e 1.16) e **non si dichiarano superate** sulla base della sola emulazione.
- Le schermate di verifica del telefono si fanno con la finestra normale, **non** con `fullPage`: la cattura a pagina intera ridimensiona la finestra e fa comparire la barra laterale del computer (artefatto della cattura, non un difetto del sito).

## Requisito tecnico permanente: stampante iniziale e limiti di stampa (vale per ogni fase, senza eccezioni)

La stampante iniziale è una **Bambu Lab A1 mini**: volume nominale di stampa **180 × 180 × 180 mm**, ugello **0,4 mm**. Il configuratore, il controllo di stampabilità e il preventivatore devono rispettare questi limiti, tenendo conto di **orientamento, supporti e margini tecnici** (il volume utile è inferiore a quello nominale: pulizia/«purge», bordo di adesione o «brim», distanza dai bordi, spazio dei supporti).

Regole:

1. **Nessun modello fuori volume viene accettato automaticamente**: se in nessun orientamento ammesso (assi allineati, con supporti e margini) la parte sta nel volume utile della macchina, l'ordine **non** segue il percorso automatico di preventivo-e-pagamento ma una **valutazione manuale** (stesso schema della richiesta di preventivo: stato non produttivo, nessun addebito automatico, decisione di una persona).
2. **Nessun ridimensionamento senza consenso del cliente**: un modello troppo grande non viene mai scalato in silenzio (né dal sito né in produzione); la proposta di ridurlo è del cliente o va confermata da lui.
3. **Suddivisione in più parti**: non automatica; si prevede una **valutazione manuale** (il negozio propone la divisione, il cliente accetta, si preventivano le parti).
4. **Parametri della macchina configurabili, non scritti nel codice**: per ciascuna macchina (oggi una, in futuro più) si configurano almeno chiave e nome, volume di stampa X/Y/Z, diametro dell'ugello, **margini tecnici** (per lato e in altezza), velocità volumetrica, potenza, materiali e finiture ammessi (la A1 mini è aperta, senza camera chiusa: materiali che deformano, come ABS/ASA/PC/nylon, da valutare), e quale macchina è attiva. Aggiungere una macchina deve richiedere solo dati (database/impostazioni del sito), **non** modifiche al codice. Gli stessi dati alimentano configuratore, controllo di stampabilità, preventivo, checkout e rapporto di producibilità: una sola fonte.
5. **Un solo punto di decisione nel server**: la verifica «sta nella macchina?» si fa sul server, sulle dimensioni risultanti dalla scala convalidata (mai su dimensioni dichiarate dal browser), e il browser mostra l'esito; stessa logica per carrello, quote e sessione di pagamento.

**Stato misurato (verifica 4.2-bis, nulla di tutto questo è ancora implementato):** nessun controllo del volume in configuratore, controllo di stampabilità, preventivo o checkout (un «Vaso» di 83 × 61 × 48 mm a scala 5, cioè 417 × 306 × 240 mm, viene preventivato e messo in vendita); i profili macchina sono costanti nel codice (`lib/printerProfiles.ts`: velocità e potenza, **senza volume**, nessun profilo A1 mini, predefinito X1 Carbon); `lib/feasibility-scorecard.ts` usa un 180 mm fisso solo per abbassare un punteggio; `SiteConfig.printerProfileKey/printerProfileOverrides` permettono di cambiare solo velocità/potenza di un profilo già nel codice. Il test `a part larger than the printer can build…` (`tests/security/checkout-consistency.sec.ts`, stato `todo`) fissa il comportamento atteso. **Da realizzare nelle fasi 2 (upload e configurazione) e 3 (preventivazione)**; verifica fisica sulla macchina vera in `docs/CHECKLIST-PRELANCIO.md` (1.19).

## Stato delle fasi

| Fase | Stato |
|---|---|
| 0 – Analisi | Completata |
| 1 – Struttura del progetto | In corso (1.1 ramo creato, 1.2 baseline eseguita, 1.3 mappa dipendenze completata, 1.4 verifica sicurezza completata: S1–S6 confermati). **Fase 1B in corso: S1, S4, S5, S6, S7 corrette e verificate; S2+S3 in corso: architettura approvata, Passi 1, 2 e 3 di 7 completati (migrazione, EUR, calcolo prezzi, imposte; ordine in attesa, sessione Stripe, endpoint quote/session, token ospite; riconoscimento del pagamento con verifica unica, permesso per ordine, effetti dopo il pagamento, vecchio checkout bloccato in produzione); il Passo 4 è in corso: 4.0 (ristampa, OrderWorks in ingresso, permesso tra processi, API ordini del cliente), 4.1 (endpoint di stato `GET /api/checkout/status`, solo server) e 4.2 (checkout nuovo: totale dal server, `/cart` e `/checkout` aperti agli ospiti, indirizzo IP fidato solo dal proxy, prezzo non più influenzabile dal browser, test su desktop e smartphone) completati; 4.3–4.6 attendono il via** (piano nel documento di lavoro approvato; elenco delle verifiche da fare fuori dall'ambiente di sviluppo in `docs/CHECKLIST-PRELANCIO.md`) (piano in `docs/CHECKOUT-S2-S3.md`) |
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
10. **Configurazione del proxy di produzione (Fase 7):** dal Passo 4.2 l'indirizzo del cliente per le limitazioni si legge **solo** da ciò che scrive il proxy: `TRUSTED_PROXY_HOPS` (numero di proxy davanti all'app: si prende la voce di `X-Forwarded-For` contando dalla fine; il proxy deve **aggiungere** l'indirizzo, es. nginx `$proxy_add_x_forwarded_for`) oppure `CLIENT_IP_HEADER` (un'intestazione che la piattaforma sovrascrive sempre, es. `cf-connecting-ip`). Senza nessuna delle due ogni richiesta è "unknown": il controllo ambiente admin lo segnala come **errore** in produzione (i limiti di login e registrazione diventano condivisi tra tutti, quelli del checkout per indirizzo si spengono e restano globale, per ordine e per utente). Resta inoltre `X-Forwarded-Proto: https` (cookie `Secure`, anche del token ospite) oppure `COOKIE_SECURE=true`. Orologio del server sincronizzato (le sessioni Stripe hanno una scadenza di 32 minuti calcolata dal nostro orologio).
11. **Ordini non pagati.** Gli ordini creati prima del pagamento e mai pagati vengono chiusi dall'evento di scadenza della sessione (Passo 3, dopo aver verificato che non ci sia pagamento) e, per quelli che l'evento non raggiunge, dallo script di riconciliazione (Passo 5); le viste di coda (`lib/production.ts` e altre) includono `awaiting_payment` e il badge cliente lo mostra come "Queued": da correggere (etichetta "In attesa di pagamento", viste di coda con `productionEligibleOrderWhere`). La numerazione `orderNumber` avrà buchi (ordini annullati).
12. **Fatturazione per organizzazione, metodi riservati agli amministratori e richieste di preventivo** non sono nel nuovo checkout a carta: restano nella vecchia interfaccia, spostata (Passo 4.2) in `/checkout/billing` (dietro l'accesso, in inglese, senza carta; il link compare solo ad amministratori e membri di organizzazioni). Le funzioni delle organizzazioni sono candidate a essere rimosse nella semplificazione. Il rapporto di producibilità PDF nel nuovo flusso è creato al pagamento verificato (effetto `report`, Passo 3; usa le righe salvate in `metadata.checkout.lines`).
13. **Residui del Passo 3 da chiudere (dettagli in `docs/CHECKOUT-S2-S3.md`, "Non verificato / limiti")**: (a) un effetto dopo il pagamento fallito (ricevuta, rapporto, notifica, PrintLab) non viene riprovato da solo finché non c'è lo script del Passo 5 (`recoverPostPaymentEffects`); (b) i pagamenti senza ordine sono registrati ed elencabili (`findUnmatchedPaymentEvents`) ma serve il comando del Passo 5; (c) `StripeEvent.payload` ora contiene anche email e indirizzo del cliente: definire la conservazione (es. 90 giorni); (d) l'aggiornamento manuale admin parte da un PaymentIntent e non trova un ordine del nuovo checkout non ancora collegato: si risolve con la riconciliazione per sessione (Passo 5); (e) `autoSubmitOrderToPrintLab` scrive i metadati senza blocco di riga (preesistente); (f) il percorso OrderWorks si fida dello stato di pagamento della scheda (non toccato); (g) due schede che creano un ordine nello stesso istante possono sovrascriversi il cookie ospite (rischio basso); (h) nessuna prova con Stripe reale né con più processi del server insieme; (i) ~~ristampa~~ **corretta nel Passo 4.0a**: ora è una richiesta di preventivo (`awaiting_review`, `quote`, nessuna eredità; gratuita solo con autorizzazione admin motivata); restano i testi in inglese della pagina ordini e le viste di produzione che mostrano `awaiting_review` come "in coda" (punto 11).
14. **OrderWorks in ingresso** (`POST /api/makerworks/jobs`): dal Passo 4.0b è spento in produzione se `ORDERWORKS_INBOUND_ENABLED` non è `true` (il controllo ambiente admin lo segnala se acceso). **Deve restare spento** salvo uso reale; il segreto `MAKERWORKS_INBOUND_SECRET` è condiviso con le rotte PrintLab/G-code (consigliati segreti distinti). L'admin può ancora segnare "pagato" una scheda (`PATCH /api/jobs/[paymentIntentId]`): azione esplicita, non registrata come autorizzazione.
15. **Verifiche fuori dall'ambiente di sviluppo**: tutte in `docs/CHECKLIST-PRELANCIO.md` (Stripe in modalità test, smartphone veri Android e iOS, sicurezza della pubblicazione, accessibilità, integrità ordini, infrastruttura…), tutte "da eseguire"; nessuna conta come superata finché non è eseguita nell'ambiente indicato.
16. **Lingua del sito**: l'italiano sarà la lingua principale di MATERIALIZE 3D. Le pagine **nuove** sono in italiano con testi centralizzati (`lib/checkout-copy.ts`, nessuna libreria di traduzione); le pagine esistenti restano temporaneamente in inglese e uniformi (niente etichette italiane dentro pagine inglesi); **traduzione completa delle pagine esistenti in una fase dedicata prima del lancio**.
17. **Rischi residui registrati nella checklist** (`docs/CHECKLIST-PRELANCIO.md`): OrderWorks (1.12), viste di produzione che mostrano ordini non pagati come "in coda" (1.13), metadati dell'ordine modificati insieme (2.7), letture di stato e sincronizzazione su infrastrutture con più istanze (2.8, 2.9).
18. (altri già noti) eseguire `scripts/hold-unpaid-orders.js` e `scripts/privatize-customer-models.js` in modalità prova sui dati reali; valori di prezzo predefiniti troppo bassi (Fase 3); rimborsi/contestazioni che non riportano indietro un ordine già in produzione.

19. **Requisito permanente responsive/mobile-first** (sezione sopra): le prove su iPhone/Safari e Android reali sono verifiche obbligatorie del lancio (checklist 1.3, 1.4, 1.16), mai superate per emulazione. **Misurazione sulle pagine esistenti (informativa, non corretta, fuori dal Passo 4.2)**, Chromium con emulazione, server di produzione locale: a 360 px di larghezza `/upload` scorre in orizzontale di 25 px e `/settings/profile` di 44 px (11 px a 393 px); i controlli dell'intestazione per chi ha fatto l'accesso sono alti 36 px (sotto i 44 consigliati); per un ospite su telefono il marchio va sotto il pulsante del menu; `/models/[id]` e `/products/[id]` segnalano un errore JavaScript non gestito con i dati fittizi (modello senza file reale: causa non indagata); landing, accesso, registrazione, scoperta, carrello, checkout, ordini, profilo e negozio non scorrono in orizzontale a 360/393/768/1280 px. **Resta da fare l'audit completo** (landing, upload STL/3MF da telefono, visualizzatore 3D con i gesti, configuratore, preventivi, area cliente, ordini) in una fase dedicata prima del lancio: da pianificare con l'utente.
20. **Obiettivo futuro, non implementato:** permettere il caricamento iniziale del modello **senza registrazione obbligatoria** (oggi `/upload` è dietro l'accesso e **non è stato toccato** nel Passo 4.2). Quando si farà: file privati per sessione/ospite con lo stesso rigore di S1/S6/S7 (nessuno vede, configura o compra i modelli di altri), limiti di dimensione e di richieste, scadenza e pulizia dei file degli ospiti, collegamento al carrello senza account.
21. **Ritiro e testi del nuovo checkout:** la scelta "Ritiro" è ereditata dal vecchio checkout; va confermato che il negozio offra davvero il ritiro (e dove) o toglierla. Mancano nella pagina i riferimenti a condizioni di vendita, recesso e informativa sulla privacy: da definire con un consulente (checklist 1.14 e 1.15).
22. **Limiti di richieste da tarare:** ora che gli ospiti possono usare carrello e checkout, i valori di partenza (`CHECKOUT_GLOBAL_RATE_MAX` 300 per finestra di 10 minuti e per tipo, `CHECKOUT_QUOTE_RATE_MAX` 120 per indirizzo) vanno confrontati con il traffico atteso (nel Passo 4.4 il carrello chiederà un preventivo a ogni modifica). Checklist 2.10.
23. **Trovato e corretto nel Passo 4.2:** (a) con la vecchia lettura di `X-Forwarded-For` bastava scrivere un indirizzo diverso a ogni richiesta per non incontrare mai un limite (tentativi di password illimitati per un account, preventivi e sessioni di pagamento illimitati per indirizzo); (b) il `priceMultiplier` scelto dal browser moltiplicava il prezzo (0,1 = pagare un decimo) e un prodotto era riconosciuto da un id scelto dal browser senza controllare che esistesse, fosse in vendita e appartenesse a quel modello; materiale, finitura e scala di un prodotto erano quelli del carrello anche se il prezzo non ne dipende; (c) il carrello nel browser veniva svuotato per un istante all'apertura di ogni pagina (la scrittura dell'elenco ancora vuoto precedeva la lettura): un ricaricamento o una seconda scheda in quell'istante vedevano il carrello vuoto o lo perdevano; (d) la pagina di fatturazione caricava lo script di Stripe già all'importazione del pacchetto.

24. **Verifica 4.2-bis (carrello, preventivo, Stripe) – risultati e decisioni aperte** (`docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md`): preventivo = ordine = Stripe al centesimo in 18 carrelli su 18 (e in 36 esecuzioni su 36 nel browser, desktop e telefono); **BLOCCANTI da risolvere prima del lancio, con proposta di correzione in attesa di approvazione:** A1 la stima del carrello differisce dal preventivo (fino a −11,34 € / +7,42 €; proposta: anticipare nel carrello le cifre del server), A2 le parti di un modello a più parti sono addebitate circa la metà (la pagina invia la dimensione in mm della parte, il server la legge come dimensione del modello; proposta: non inviarla più e ricavarla dal server), A3 la valuta dei componenti del browser è incorporata alla build e il `Dockerfile` non la passa (carrello in «$» con checkout in «€»; proposta: `ARG NEXT_PUBLIC_CURRENCY`); altre: A4 materiale/finitura come testo libero prezzati come PLA/standard, A5 nessun importo minimo dopo la scala (0,01 € a scala 0,1; minimo di Stripe), A6 stima della pagina del prodotto diversa dall'addebito, A8 nessun controllo del volume di stampa (requisito tecnico permanente sopra).

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
