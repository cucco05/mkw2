# Verifica del Passo 4.6 (S0–S3, primo punto di arresto; S4, S5 e S6a, secondo, terzo e quarto punto di arresto, in fondo)

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro e delle decisioni: `docs/CHECKOUT-S2-S3.md`, «Passo 4.6 – S0–S3». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre, che cosa è cambiato nei prezzi e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale in modalità test o con telefoni veri: restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (1.1–1.4, 1.26–1.29, 1.41–1.44). Le prove con **Stripe simulato** (rete simulata a livello HTTP con l'SDK Stripe vero, oppure un client Stripe finto nei test in processo) e con **Chromium emulato** sono tenute distinte da quelle necessarie con Stripe reale e dispositivi fisici (sezione 8).

**Ambito autorizzato (primo punto di arresto):** solo S0, S1, S2, S3. **Non iniziati allora:** S4 (rilascio in produzione), S5 (sessione ospite), S6 (pagamenti in verifica), S7 (anteprima e testi), S8, Passo 5. **Il secondo punto di arresto (S4) e il terzo (S5) sono in fondo a questo documento; S6, S7, S8 e il Passo 5 restano non iniziati.**

## 1. Ambiente delle prove

PostgreSQL 16 locale (`mkw_sectest`, porta 55432); `next start` in produzione (build con `NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR`); SDK Stripe vero davanti a un Stripe simulato (`tests/real-run/fake-stripe-http-preload.js`, nessuna rete); Chromium con emulazione: `chromium` 1280×720, `mobile` 393×851 (Pixel 5, tocco), `mobile-small` 360×640 (tocco). Dati fittizi. Minimo per unità della configurazione di prova: 5,00 €.

## 2. Risultati

| Verifica | Mezzo | Esito |
|---|---|---|
| Tipi (`tsc --noEmit`), `eslint` (0 avvisi), `next build` | locale | OK |
| `npm test` | `node --test` | **366/368** — i 2 fallimenti sono **preesistenti** e non riguardano questo passo (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); al 4.5 erano 326/328 |
| `npm run test:api` / `test:contracts` | `node --test` | 7/7 / 14/14 |
| `npm run test:security` (serie) | `node --test --test-concurrency=1` | **505/505** (429 al 4.5); 0 `todo` |
| Percorso reale `tests/real-run/checkout-return.ts` | `next start` + Stripe simulato + Chromium | **86/86** |
| Matrice `tests/real-run/checkout-matrix.ts` (27 scenari + 17 casi stampante = 44 × 2 formati; `STRICT_CART=1`) | come sopra | **88/88**, 0 differenze preventivo/ordine/Stripe, 0 differenze carrello/preventivo |
| Guardie di produzione `tests/real-run/production-guards.ts` | `next start` | **8/8** |
| Intera suite nel browser (`npx playwright test`, 3 formati, con la seed e un token admin di prova) | Playwright, Chromium emulato | **214 passati, 3 saltati, 0 falliti** (217 prove; erano 193 + 3 al 4.5: +18 del carrello a gruppi, +3 delle deroghe; i 3 saltati sono gli stessi del 4.4 e 4.5) |
| Migrazione M1 su **database vuoto** con tutte le migrazioni | `prisma migrate deploy` | applicata; tabella vuota; la macchina `bambu-a1-mini` resta `{PLA, PETG}` 180×180×180 |
| Migrazione M1 su **copia popolata** di `mkw_sectest` (24 ordini, 1 tentativo) | `prisma migrate deploy` dopo aver tolto M1 dalla copia | applicata; 24 ordini e 1 tentativo **invariati**; tabella creata vuota |
| `npm run prisma:migrate:drift` | `prisma migrate diff` | **una differenza preesistente** (indice `ModelComment_partId_idx`: in una migrazione, non nello schema), **identica** sullo schema e sulle migrazioni di `HEAD`; nulla dovuto a M1 (**risolta in S4**, sezione S4.7) |
| Mutazioni sulle regole nuove | script fuori dal repository | **32 su 32 rilevate** (sezione 6) |
| Dipendenze | `git diff -- package.json package-lock.json` | **nessuna modifica** |

File di prova nuovi: unitari `unit-pricing` (9), `sale-units` (11), `cart-canonical` (5), `cart-groups` (11), `minimum-waivers` (5), `single-parts-ack` (5), + 2 in `checkout-client`; sicurezza `sale-units` (12), `economic-thresholds` (4), `set-orders` (5), `price-waivers` (14), `admin-order-routes` (25); browser `cart-groups.responsive` (6 × 3 formati), `price-waivers.responsive` (1 × 3 formati). Rifatti per scelta: 5 test di sicurezza e l'unitario `pricing-minimum` del 4.5 (regola a conteggio), lo scenario del golden snapshot (sezione 3) e lo script `tests/real-run/checkout-matrix.ts` (ora fa la scelta del cliente davanti all'avviso).

## 3. Differenze economiche rispetto alla versione precedente (4.5)

Totale **dell'ordine** (articoli + spedizione + IVA), in euro; «prima» = codice del 4.5 (`eea7d5b`) eseguito sugli stessi scenari; «dopo» = questo passo. Per ogni scenario carrello = preventivo = ordine = importo Stripe (colonne «Ordine» e «Stripe» uguali, 88 prove su server reale).

| # | Scenario | Prima | Dopo | Diff. | Perché |
|---|---|---:|---:|---:|---|
| 01–08, 10–18 | scenari 4.2-ter (vaso, lampada, prezzo fisso, sconti, IVA, spedizione, urgenza, scale, prodotto, 50 pezzi…) | = | = | 0,00 | nessuna differenza |
| 09 | modello a due parti: parte 1 ×2 + parte 2 ×1, **senza chiave**, spedizione, IVA esclusa 22 % | 20,74 | **26,84** | **+6,10** | carrello «vecchio» (parti sciolte): ogni parte è un'unità e paga il proprio minimo (articoli 10,00 → 15,00; l'IVA segue). Il server lo segnala e il cliente deve scegliere prima di pagare (sotto) |
| 19 | modello a tre parti venduto **completo** (una chiave), ritiro | 10,78 | 10,78 | 0,00 | = prezzo del modello |
| 20 | come 19, ×2 copie, colori diversi per parte, spedizione, IVA inclusa | 28,56 | 28,56 | 0,00 | idem |
| 21 | le **stesse tre parti senza chiave**, ritiro | 10,78 | **16,47** | **+5,69** | prima la regola a conteggio le leggeva come un set (1 unità); ora sono tre parti singole: 6,47 + 5,00 + 5,00 (minimo per parte). Con la chiave (scenario 19) il totale resta 10,78 |
| 22 | modello a due parti **in saldo** venduto completo, spedizione, IVA inclusa | 17,78 | **14,55** | **−3,23** | D1: un set vale il prezzo del modello **in offerta** (7,55), non la quota del prezzo calcolato (10,78); coincide con ciò che la pagina del modello pubblicizza |
| 23 | set completo + una parte 1 in più da sola | 17,25 | 17,25 | 0,00 | set = prezzo del modello; la parte in più = un'unità |
| 24 | set completo a scala 0,3 (sotto il minimo) | 5,00 | 5,00 | 0,00 | un solo minimo per l'unità |
| 25 | le tre parti a scala 0,3 **senza chiave** | 5,00 | **15,00** | **+10,00** | tre unità, tre minimi (prima: letto come un set = un minimo) |
| 26 | gruppo **non valido** (parti a scale diverse, stessa chiave) | 18,45 | **22,37** | **+3,92** | U3b: non è un modello completo, quindi nessun prezzo del set; la parte da 1,08 € paga il minimo 5,00 € |
| 27 | vaso a scala 0,5, tolleranza «bozza» (×0,94) | 4,70 | **5,00** | **+0,30** | D2: il moltiplicatore che abbassa il prezzo non porta più un'unità sotto il minimo |

**Golden snapshot** (`/api/checkout` storico): cambia **un solo importo** — «part priced from volume (multipart split)» 14,61 € → **14,60 €** (−0,01 €): la quota della parte è ora ripartita in centesimi che sommano esattamente al prezzo del modello (prima ogni quota era arrotondata a sé). Tutte le altre differenze sono **campi aggiunti** (`unit`, `minimum`, e nell'ordine `configuration.unit`/`.pricing`). Aggiornato con `UPDATE_GOLDEN=1` solo dopo aver letto riga per riga il confronto (621 righe aggiunte, 16 sostituite).

**Come si riconosce la differenza per il cliente:** gli aumenti riguardano solo carrelli di **parti sciolte** che messe insieme formerebbero un modello completo (09, 21, 25) o gruppi non validi (26). Per i primi la pagina mostra il subtotale attuale e **non abilita «Checkout»/«Paga»** finché il cliente non sceglie «Raggruppa come modello completo» (torna al prezzo del set, es. 10,78 invece di 16,47) oppure conferma le parti singole. **Verificato sul server reale:** alla prima esecuzione della matrice proprio gli scenari 09, 21 e 25 sono falliti (6 prove su 88) perché il pulsante era giustamente spento fino alla scelta; lo script ora fa la scelta del cliente (`confirm-single-parts`) e passa 88/88.

## 4. Per punto della richiesta di arresto

### 4.1 Regressione prevista dal piano
Sezione 2. Nessun test del 4.5 è stato indebolito: i 5 riscritti hanno asserzioni **più forti** (uguaglianza al centesimo dove prima c'era una tolleranza di 3 centesimi) e testano la regola nuova.

### 4.2 Tabella economica e spiegazione
Sezione 3. Ogni differenza ha una causa nominata; nessuna differenza è «di arrotondamento» tranne il −0,01 € del golden.

### 4.3 Anomalie e rischi residui
Sezione 7.

### 4.4 Migrazioni, audit, protezione delle rotte admin
- **Migrazione M1** `20261020120000_minimum_price_waivers`: una tabella nuova, vuota, senza chiavi esterne; verificata su database vuoto e su copia popolata (sezione 2). Ritorno indietro = solo codice (il codice vecchio ignora la tabella).
- **Audit** (`AdminAuditEvent`, catena di hash): scritto **nella stessa transazione** dell'azione per `admin.price_waiver.grant|revoke`, `admin.order.delete`, `admin.order.item_quantity`, `admin.orderworks_job.delete`, `admin.job.payment`, `admin.order.create`. Prove: se l'audit non si può scrivere (attore inesistente) la deroga **non** esiste e la revoca **non** avviene; un rifiuto (409) **non** lascia tracce a metà; la catena di hash resta continua (ogni evento punta all'hash del precedente).
- **Protezione delle rotte admin** (`tests/security/admin-order-routes.sec.ts`, `price-waivers.sec.ts`): per ognuna delle rotte critiche — anonimo 401, cliente 403, **staff 403**, origine estranea o assente 403, motivo mancante/breve/lungo 400; un ordine con **ciascuna** delle otto prove di pagamento Stripe (tentativo, id pagamento, id addebito, data di pagamento, rimborso, pagamento in verifica, dati Stripe nei metadati, fattura) non si modifica né si elimina (409, riga, righe e registro invariati); un ordine con solo un pagamento manuale registrato **si può** eliminare (con motivo).
- **Nessuna regressione sulle autorizzazioni dei file privati:** la suite di sicurezza completa (che comprende modelli privati, ricevute, file di ordine, accesso ospite) è verde.

### 4.5 Precisioni dell'approvazione
1. **Stripe (E3/E4):** corrette nel piano prima di S6 (PaymentIntent di una Checkout Session distinto da uno indipendente; tentativi senza identificativi sufficienti sempre «non verificabile»; la ricerca Stripe non esclude mai un pagamento) con le fonti ufficiali e le righe (†) da riconfermare (checklist 1.44). **S6 non implementato.**
2. **D8 (OrderWorks):** prima di toccare `PATCH /api/jobs/<id>` il difetto è stato **riprodotto sul codice del 4.5**: staff + `{"paymentStatus":"paid"}` su una scheda carta con identificativo digitato → HTTP 200, ordine `paid` e `queued`, nessuna data di pagamento, nessun id Stripe, nessuna traccia (e invio automatico a PrintLab). Corretto: sezione 4 di `docs/CHECKOUT-S2-S3.md`, tre stati distinti (pagamento Stripe verificato / pagamento manuale registrato / autorizzazione eccezionale alla produzione), 12 prove dirette sulla rotta e sulla libreria.
3. **Coerenza delle scale (U3b):** un gruppo con scale diverse non è un modello completo (`SCALE_MISMATCH`), colori diversi sì; scale confrontate a 4 decimali (1,00001 = 1,0; 1,001 ≠ 1,0); per materiale/finitura/riempimento diversi non si è inventata alcuna regola; il carrello propaga quantità e dimensione a tutto il gruppo.

### 4.6 Requisiti di esecuzione
- *Modifiche minime e additive:* una tabella nuova; campo opzionale `setKey` e risposta additiva; nessuna dipendenza; `@stripe/react-stripe-js`, `@stripe/stripe-js`, `CheckoutForm` intatti.
- *Cent-esatto carrello → preventivo → ordine → Stripe:* matrice 88/88 su server reale; per i set `tests/security/set-orders.sec.ts` (somma delle righe dell'ordine = preventivo = righe Stripe).
- *Casi multiparte e prezzi pubblicizzati:* `sale-units.sec.ts` («advertised = charged» per un modello a più parti: pagina, riga intera e set coincidono, le parti sommano al prezzo del modello; una parte da sola costa la sua quota o il minimo); il prezzo pubblicizzato nell'**anteprima** del configuratore e nell'**elenco** non è ancora allineato (S7, sezione 7).
- *PC e smartphone:* 214 prove nel browser sui tre formati (nessuno scorrimento orizzontale, bersagli ≥ 44 px, nessun controllo fuori schermo) — emulazione, non dispositivi.

## 5. Che cosa è stato provato sul carrello a gruppi (browser, 3 formati)
Un modello completo è **un blocco** con una sola quantità; le righe delle parti non hanno «+»/«−»/«Remove» propri; la quantità del gruppo diventa la quantità di ogni parte e il server è interrogato con le tre righe sotto **una** chiave; cambiare la dimensione di una parte la cambia a tutte; «Split into single parts» scioglie il gruppo, il server **suggerisce** soltanto, «Checkout» si spegne e si riaccende con «Group as a complete model» (prezzo del set) o con la conferma del subtotale; la conferma vale per quel carrello e quel subtotale (resta dopo un ricarico, decade se cambia una quantità); togliere il modello toglie tutte le righe. Unitari (`cart-groups`, 11) per la logica pura: propagazione, scioglimento alla rimozione di una riga, conteggio per copie, raggruppamento solo se stessa quantità/dimensione/nessuna parte doppia.

## 6. Mutazioni (script fuori dal repository, ogni mutazione ripristinata subito)
Tutte rilevate (32/32) dopo aver aggiunto una prova: la mutazione «la dichiarazione di una scheda carta è creduta dalla libreria» era **sopravvissuta** alla prima serie, perché la rotta già non passava più lo stato dichiarato; è stato aggiunto un test diretto su `createOrderFromJobForm` e ora è rilevata.
Impronta che dipende dal valore casuale della chiave; impronta che dipende dall'ordine delle righe; controllo della scala dei set rimosso; controllo di completezza rimosso; la rimozione di una riga non scioglie il gruppo; quantità/dimensione non si propagano; il raggruppamento accetta quantità diverse; la conferma ignora il subtotale; una deroga sopra il minimo **alza** il minimo; deroghe revocate ancora valide; deroghe scadute ancora valide; il motore ignora le deroghe; un prodotto prende la deroga del suo modello; lo staff concede deroghe; errore di audit inghiottito (deroga senza traccia); più deroghe attive per lo stesso bersaglio; eliminazione ordine ignorando le prove Stripe; eliminazione ordine consentita allo staff; eliminazione senza motivo; modifica quantità ignorando le prove Stripe; ordine a mano sotto il minimo senza controllo; identificativo digitato accettato come pagamento carta; lo staff cambia il pagamento di una scheda; la libreria crede alla dichiarazione di una scheda carta; pagamento manuale senza `manualPayment`; pagamento modificabile su un ordine con prove Stripe; pagamento manuale con id Stripe; eliminazione scheda ignorando le prove Stripe; eliminazione scheda consentita allo staff; `manualPayment` falsificabile da servizi esterni; un tentativo di pagamento non conta come prova; il motore non verifica più i set (11 prove falliscono).

## 7. Anomalie e rischi residui (non risolti, nessuno nascosto)

**Aperti e già pianificati (S4–S7, non autorizzati):**
1. **Ordini `awaiting_payment` trattati come lavoro in coda**, `printlab-link` senza politica di pagamento, nessuna porta unica di rilascio (S4). *Bloccante di lancio.*
2. **Ospiti senza identità prima del primo ordine** (S5): due prime richieste simultanee senza cookie possono creare due ordini (R1); `storedCheckoutKey` per gli ospiti dipende dalla sola chiave del browser.
3. **`acknowledgeUnverified`** esiste ancora in `lib/payment-hold.ts` (S6): un pagamento incerto può ancora essere sbloccato su dichiarazione se Stripe non risponde. *Bloccante di lancio.* Le regole E1–E5 corrette sono nel piano, non nel codice.
4. **Anteprima del configuratore** (`app/api/models/[id]/quote`) = calcolo separato che accetta ancora `priceMultiplier` dal browser, e **elenco** (`/products`, `/api/models`) con `resolveModelPricing` senza configurazione (S7, F1/F4): il prezzo mostrato fuori dal carrello può non coincidere con quello addebitato per i modelli in offerta sotto il minimo e con una deroga.
5. Testi illeggibili a 360 px nel visualizzatore e nella colonna della miniatura del carrello (S7, F7); statistiche che contano ordini non pagati (F6) e scaglioni di sconto non monotoni (F8): checklist.

**Nuovi o da sapere, introdotti o resi evidenti da questo passo:**
6. **`window.prompt` per il motivo** delle azioni admin: alcuni browser interni (app di messaggistica) lo bloccano; in quel caso l'azione **non parte** e il messaggio lo dice (fallimento sicuro). Da provare su telefono vero (1.42). Un modulo dedicato è la correzione, non fatta.
7. **Governance delle deroghe**: un solo amministratore può concederne; `PRICE_WAIVER_ADMIN_IDS` restringe a un elenco, ma non c'è seconda approvazione (1.40).
8. **Conferma «parti singole» in `localStorage`**: in navigazione privata vive solo nella pagina (si richiede a ogni ricarico: fallimento sicuro). Un cliente che compra apposta tutte le parti separate (colori o dimensioni diverse) deve fare un clic in più; se le righe hanno quantità o dimensioni diverse non può raggrupparle e può solo confermare.
9. **Cambio di comportamento della rotta `PATCH /api/jobs/<id>`**: una modifica **solo** di evasione su una scheda già «pagata» non crea più un ordine fidandosi dello stato della scheda (prima lo faceva: era la stessa falla di D8). Se qualche flusso esterno dipendeva da quell'effetto collaterale, ora l'ordine va creato dal webhook OrderWorks (non fidato) o dalla dichiarazione esplicita.
10. **Ordine a mano con una riga a prezzo 0 dentro un ordine non gratuito** richiede ora il motivo (è sotto il minimo); l'ordine **tutto** gratuito resta il flusso «senza addebito» riservato all'admin (senza motivo obbligatorio: già un'azione esplicita e solo admin, ma ora con evento di audit).
11. **Pagamenti manuali**: restano `paymentStatus='paid'` (il flusso non cambia) ma riconoscibili da `metadata.manualPayment` e dall'assenza di `paidAt`/id Stripe. Il codice che oggi tratta `paid` come «Stripe ha confermato» non è stato ancora rivisto riga per riga (porta unica S4).
12. **Deroga sopra il minimo del negozio** (se il minimo viene abbassato dopo): non ha effetto e non è registrata sull'ordine (provato); resta nell'elenco finché non si revoca.
13. **Drift preesistente** `ModelComment_partId_idx` (sezione 2): correzione proposta (`@@index([partId])`), non fatta. **→ Risolto in S4** (una riga di schema, dopo il confronto a tre fonti: sezione S4.7).
14. **Cifre dell'elenco «prezzi fissati a mano sotto il minimo»** considerano solo `salePriceUsd`; per i prodotti si segnalano quelli con moltiplicatore < 1, non si calcola il prezzo finale.

## 8. Non provato
Stripe reale in modalità test (compresi sessioni/PaymentIntent veri, annullamento, ricerca per metadato); iPhone con Safari e Android veri (carrello a gruppi, avviso del nuovo prezzo, finestra del motivo, `localStorage` in navigazione privata); un operatore reale che usa la pagina delle deroghe e le rotte con motivo; le fonti Stripe marcate (†) nel piano; la riga 1.40 (governance). Tutto è in `docs/CHECKLIST-PRELANCIO.md` come «da eseguire».

## 9. Come riprodurre
```
npm run lint && npx tsc --noEmit && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security      # database di prova locale
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
# server di produzione sul database di prova + seed (tests/e2e/seed-customer-orders.ts) + token admin; poi:
E2E_BASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium E2E_FIXTURE=… E2E_ADMIN_TOKEN=… npx playwright test
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/checkout-return.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/production-guards.ts
DATABASE_URL=… npx prisma migrate deploy                                                              # su database vuoto e su una copia
```

---

# Verifica del Passo 4.6 — S4: rilascio sicuro in produzione (secondo punto di arresto)

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro, della regola e dei limiti: **`docs/RILASCIO-PRODUZIONE.md`**; decisioni e piano: `docs/CHECKOUT-S2-S3.md`, «Passo 4.6 – S4». Questo capitolo riporta **che cosa è stato provato, con quale mezzo, con quali cifre e che cosa no**.

**Ambito autorizzato:** solo S4 («APPROVAZIONE PIANO E IMPLEMENTAZIONE S4», con le precisazioni obbligatorie e le due correzioni finali). **Non iniziati:** S5 (sessione ospite), S6 (pagamenti in verifica, compreso `acknowledgeUnverified`), S7, S8, Passo 5. **Il checkout non è dichiarato pronto per la produzione commerciale.** Non sono stati contattati Stripe, PrintLab, StockWorks né stampanti reali; nessun prezzo, IVA o regola commerciale è cambiato.

## S4.1 Ambiente

PostgreSQL 16 locale (`mkw_sectest`, porta 55432); Stripe simulato (client finto nei test in processo; SDK vero davanti a un Stripe simulato a livello HTTP nei percorsi reali); **PrintLab e StockWorks finti** (`tests/security/_fake-services.ts`): veri server HTTP su 127.0.0.1 che contano ogni richiesta e possono rifiutare, rispondere dopo aver registrato, perdere la risposta, andare in timeout, rispondere con un corpo che non è un record, o eseguire codice del test nel momento in cui arriva la richiesta; `next start` in produzione (build con `CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR`); Chromium emulato `chromium` 1280×720, `mobile` 393×851 (Pixel 5, tocco), `mobile-small` 360×640. Dati fittizi.

## S4.2 Risultati (confronto con il primo punto di arresto)

| Verifica | Mezzo | S4 | Primo punto di arresto |
|---|---|---|---|
| Tipi (`tsc --noEmit`) / `eslint` (`--max-warnings=0`) / `next build` | locale | **0 errori / 0 avvisi / OK** | idem |
| `npm test` | `node --test` | **453/455** — gli stessi **2 fallimenti preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`) | 366/368 |
| `npm run test:api` / `test:contracts` | `node --test` | **7/7 / 14/14** | 7/7 / 14/14 |
| `npm run test:security` (serie, un solo database) | `node --test --test-concurrency=1` | **944/944** (0 `todo`) | 505/505 |
| Matrice di stato `production-release.sec.ts` | handler reali, servizi finti | **364/364** (sul codice di `HEAD`: **165 passavano, 199 fallivano**, a dimostrazione dei difetti) | — |
| Effetti esterni, concorrenza, rotte, viste, parità, caso «blocco dopo l'invio» | idem | 30 + 31 + 9 + 5 (incluse nei 944) | — |
| Unitari nuovi | `node --test` | regola pura 52, registro/classificazione 18, collegamento PrintLab 5, `stripe-attach` 7, guardie sul sorgente 10, coda 1 (incluse nei 453) | — |
| Server reale `tests/real-run/production-release.ts` | `next start` + servizi finti, HTTP vero con cookie, `Origin` e segreti | **68/68** (eseguito due volte: sulla build intermedia e su quella finale) | — |
| Guardie di produzione `production-guards.ts` | `next start` | **8/8** | 8/8 |
| Percorso reale `checkout-return.ts` | `next start` + Stripe simulato + Chromium | **86/86** | 86/86 |
| Matrice economica `checkout-matrix.ts` (`STRICT_CART=1`) | come sopra | **88/88**, 0 differenze preventivo/ordine/Stripe, 0 differenze carrello/preventivo — **nessun totale è cambiato** | 88/88 |
| Intera suite nel browser (`npx playwright test`, 3 formati) | Playwright, Chromium emulato | **259 passati, 3 saltati, 0 falliti** (45 nuove: 15 prove × 3 formati) | 214 + 3 saltati |
| Deriva Prisma (`prisma:migrate:drift`) | `prisma migrate diff` | **0 differenze** dopo la correzione di una riga di schema (sezione S4.7, **separata**) | 1 differenza preesistente |
| Mutazioni sul codice nuovo | script fuori dal repository | **52 su 52 rilevate** (sezione S4.5): 48 subito, 4 dopo aver controllato i test (2 test nuovi) | 32/32 |
| Dipendenze | `git diff -- package.json package-lock.json` | **nessuna modifica** | nessuna |

File di prova nuovi: unitari `production-release` (52), `external-effects` (18), `production-release-guards` (10); sicurezza `production-release` (364), `production-release-effects` (30), `production-release-routes` (31), `production-release-views` (9), `production-release-parity` (5) più i moduli comuni `_release-fixtures.ts` e `_fake-services.ts`; script `tests/real-run/production-release.ts`; browser `production-release.responsive.spec.ts` (15 × 3 formati) con la seed `seed-production-release.ts`.

## S4.3 Che cosa dimostra la matrice rossa su `HEAD`

Prima di toccare il codice è stata scritta la matrice di stato (ogni caso elencato nell'approvazione più quelli trovati leggendo il codice, contro i percorsi reali: stato, assegnazione, coda automatica, invio e collegamento PrintLab, callback, sincronizzazione OrderWorks, consumo di materiale). Sul codice del primo punto di arresto **199 prove su 364 fallivano**: per esempio un ordine **non pagato** poteva diventare `queued`/`printing`/`completed` da un collegamento o da un callback PrintLab (anche `failed`), e un ordine pagato **in revisione**, in conferma o con la pagina Stripe aperta poteva essere assegnato, inviato a PrintLab, avanzato o consumare materiale. Altri difetti sono stati **individuati leggendo il codice** (inventario del piano) e poi coperti da prove dedicate scritte insieme alla correzione, senza una corsa «rossa» separata su `HEAD`: l'approvatore di un'organizzazione che poteva riportare in coda un ordine `completed`/`cancelled` o annullarne uno in stampa; il consumo di materiale senza controllo del pagamento e con «già consumato» non atomico; due clic sull'auto-coda che potevano assegnare due volte; una chiamata a PrintLab con esito sconosciuto che poteva essere ripetuta; un ordine già inviato che poteva essere eliminato lasciando un lavoro orfano; una richiesta di preventivo, anche da ospite, che poteva togliere dal magazzino i prodotti pronti.

## S4.4 Difetti trovati durante il lavoro (oltre ai precedenti)

1. `assign-printer` con la sola `amsTrayMap` azzerava `printerAssignedAt`/`printerAssignedBy` (corretto; test).
2. La `fetch` verso PrintLab non aveva timeout (ora `PRINTLAB_SUBMIT_TIMEOUT_MS`, 20 s).
3. `PATCH …/status`: se StockWorks falliva rispondeva 400 **dopo** aver salvato e senza audit (ora: avviso nella risposta, audit nella stessa transazione).
4. Una connessione a una porta vietata («bad port» di undici) veniva classificata «incerta» invece di «non partita» (corretto; test unitario).
5. La rotta degli effetti esterni accettava un campo extra (`{action:'retry'}`): ora lo schema è `.strict()`.
6. **Trovato solo dal browser:** un'opzione `Intl.DateTimeFormat` non valida (`timeZoneName` insieme a `dateStyle`) introdotta da me nei due componenti nuovi faceva cadere l'intera pagina con «Application error: a client-side exception»; il controllo sul server reale via HTTP (HTML già renderizzato) **non** poteva vederlo. Corretto; la prova nel browser (console, errori di pagina, richieste esterne, errori 5xx) ora c'è e la rileva. Lezione: i controlli HTTP e quelli nel browser non si sostituiscono.
7. Una costante esportata da un file `route.ts` (non ammessa dalle regole di Next.js): spostata in `lib/external-effects.ts`. Una `Date.now()` nel corpo di una pagina server (regola `react-hooks/purity`): spostata in `claimIsLive`.
8. Le **prove esistenti** che chiamavano le rotte admin senza intestazione `Origin` (richiesta ora) sono state aggiornate (sezione S4.6).

## S4.5 Mutazioni (script fuori dal repository, ogni mutazione ripristinata subito)

Ogni riga è una protezione rotta apposta nel codice; il test che la rileva è quello indicato. **Nessun controllo è stato allentato per far passare una prova.** Due mutazioni (M40, M41) non erano rilevate dai test scritti: sono stati **aggiunti due test** (B9b: un claim passato a un altro processo tra due chiamate non viene scavalcato; K1: una parola sconosciuta di PrintLab non muove un ordine pagato che aspetta un amministratore). Altre due (M47, M51) risultavano non rilevate solo perché la selezione dei test non comprendeva il test esistente che le copre (M51: a livello di rotta esiste un secondo controllo, difesa in profondità).

| # | Cosa si rompe | Rilevata alla prima | Rilevata da |
|---|---|---|---|
| M01 | la regola ignora un pagamento in revisione | sì | decision: payment under review (amount) |
| M02 | la regola ignora un pagamento in conferma | sì | decision: payment being confirmed (status + attempt) |
| M03 | la regola ignora una pagina Stripe ancora aperta | sì | decision: authorization does not override an open Stripe page |
| M04 | un'autorizzazione prevale su un pagamento in revisione | sì | decision: outside order, authorized, with a later money problem in the review log |
| M05 | un ordine esterno è rilasciato senza autorizzazione | sì | decision: outside order, not authorized |
| M06 | «pagato» senza prova vale come prova | sì | decision: free order made by an administrator |
| M07 | un pagamento manuale è presentato come pagamento Stripe (basi scambiate) | sì | decision: paid by a registered manual payment |
| M08 | il prefiltro Prisma dimentica il motivo di revisione | sì | P1 on every row of the state matrix the prefilter and the rule agree (the one documented exception aside) |
| M09 | la rotta di stato non applica la regola di rilascio | sì | A/status/awaiting payment: moving the order into production |
| M10 | assegnare una stampante non richiede un ordine rilasciato | sì | A/assign/awaiting payment: assigning a printer |
| M11 | l'invio a PrintLab non richiede un ordine rilasciato | sì | A/printlab-submit/awaiting payment: sending to PrintLab |
| M12 | un collegamento PrintLab muove un ordine non rilasciato | sì | A/printlab-link/awaiting payment: linking a PrintLab job that reports "completed" |
| M13 | un callback PrintLab muove un ordine non rilasciato | sì | A/callback(started)/awaiting payment: the PrintLab callback |
| M14 | la coda automatica non ricontrolla ogni ordine sotto blocco | sì | P3 whitespace-only proof fields: the prefilter admits what the rule refuses (declared) |
| M15 | la sincronizzazione OrderWorks muove un ordine non rilasciato | sì | A/orderworks-sync/awaiting payment: the OrderWorks fulfilment sync |
| M16 | un approvatore di organizzazione risponde su un ordine in qualunque stato (fa risorgere un ordine annullato) | sì | H2 an approver can not turn around an order that is not waiting for an answer |
| M17 | approvare un preventivo mette in coda un ordine non rilasciato | sì | H1 an approver answers a quote that is waiting |
| M18 | rifiutare un preventivo annulla un ordine che ha denaro sopra | sì | H3 rejecting cancels an order that has no money on it - and refuses one that has, or is being paid, or is und… |
| M19 | il materiale esce dal magazzino per un ordine non rilasciato | sì | A/stock/awaiting payment: taking the material out of stock |
| M20 | due richieste possono togliere lo stesso materiale insieme (niente claim) | sì | C4 two consumptions at once write each line once |
| M21 | la coda elenca ordini non rilasciati | sì | V1 the queue and the hours of work ahead hold only released orders, whatever else exists |
| M22 | lo snapshot per i clienti porta i motivi del blocco | sì | V1b the snapshot for customers carries no explanation of why anything is held back |
| M23 | il blocco di riga non viene preso (niente FOR UPDATE) | sì | B7b many requests at once: still one request to PrintLab per item |
| M24 | una richiesta di preventivo toglie dal magazzino i prodotti pronti | sì | legacy checkout: stock of a ready-made product is taken only for a sale that is real |
| M25 | la rotta di stato accetta una richiesta da un altro sito | sì | E1 every route that changes an order, a printer, a machine or the stock refuses a request from another site -… |
| M26 | stripe-attach accetta un pagamento che non nomina quest'ordine | sì | G2 the payment must name THIS order: the same customer, e-mail, amount, currency and date are not a substitut… |
| M27 | un esito incerto può essere ritentato | sì | an intent whose claim ran out is UNCERTAIN, never a license to send again (process restart) |
| M28 | un claim scaduto permette di rifare la chiamata | sì | an intent whose claim ran out is UNCERTAIN, never a license to send again (process restart) |
| M29 | un timeout è letto come «la richiesta non è partita» | sì | classification: anything that may have been done is uncertain |
| M30 | un errore del server è letto come «rifiutato, non ha fatto nulla» | sì | classification: anything that may have been done is uncertain |
| M31 | un ordine andato in produzione si può eliminare | sì | F1 an order with a job in production (confirmed) is not deleted, however it is asked |
| M32 | annullare un ordine andato in produzione non chiede un motivo | sì | F5 cancelling an order that went to production needs a written reason, leaves a record, and sends nothing to … |
| M33 | la rotta degli effetti esterni accetta un'istruzione «riprova» | sì | B12 an administrator can end the doubt only with a PrintLab job the server verifies - never with a word, neve… |
| M34 | un servizio esterno può scrivere il registro delle chiamate | sì | reserved metadata keys: an outside service can not write the markers of the production flows |
| M35 | il pianificatore di lotti conta ordini non rilasciati | sì | V5 the batch planner and the StockWorks prediction look only at released orders |
| M36 | la previsione StockWorks conta ordini non rilasciati | sì | V5 the batch planner and the StockWorks prediction look only at released orders |
| M37 | la storia della flotta conta ordini in attesa di pagamento | sì | V5b the history readers do not count an order that waits for a payment or a review as printed |
| M38 | il rapporto sprechi conta ordini in attesa di pagamento | sì | V5b the history readers do not count an order that waits for a payment or a review as printed |
| M39 | un blocco arrivato tra due righe non è visto prima della chiamata successiva | sì | B9 a block between two items stops the rest |
| M40 | il claim non è ricontrollato prima di ogni chiamata (un altro processo può subentrare senza che si veda) | no (vedi nota) | B9b another process took over the next item between two calls: this one does not send it, and the other proce… — sopravvissuta alla prima selezione → **nuovo test B9b** → rilevata |
| M41 | una parola PrintLab sconosciuta è letta come una parola che PrintLab manda davvero | no (vedi nota) | K1 a PrintLab word nobody knows does not move a paid order that waits for an administrator (awaiting_review) — sopravvissuta → **nuovo test K1** → rilevata |
| M42 | la vecchia regola di idoneità è usata in un posto nuovo (guardia statica) | sì | G4 the old eligibility rule is not used to decide anything about production |
| M43 | un posto nuovo scrive un PrintOrder senza essere registrato (guardia statica) | sì | G1 every file that writes a PrintOrder is in the registry |
| M44 | una rotta che modifica dati smette di controllare l'origine (guardia statica) | sì | G5 every route that changes an order, production, a printer, a machine or the stock refuses a request from an… |
| M45 | un callback PrintLab comincia a controllare l'origine di un browser (guardia statica) | sì | G6 the callbacks that carry a secret or a signature do not depend on a session or on the origin of a browser |
| M46 | una seconda richiesta può inviare mentre la prima lavora ancora (un claim vivo non è rispettato) | sì | B7 two requests at once send once |
| M47 | lo staff può autorizzare la produzione senza pagamento verificato | no (vedi nota) | admin status route: every production status needs verified payment or explicit admin authorization — sopravvissuta ai file S4 → **rilevata** dal test esistente `admin status route: every production status needs verified payment…` (e da `s5-payment-methods`) |
| M48 | lo staff può confermare un effetto esterno | sì | J2 the routes that decide about money or about what is true belong to administrators, not staff |
| M49 | lo staff può collegare un pagamento Stripe a mano | sì | J2 the routes that decide about money or about what is true belong to administrators, not staff |
| M50 | un pagamento Stripe si collega senza un motivo scritto | sì | G4 who may link a payment, and from where |
| M51 | un pagamento Stripe si collega anche se un altro ordine lo usa già | no (vedi nota) | attach: a payment already used elsewhere, and orders in a state that can not take a payment, are refused — a livello di rotta c'è un secondo controllo (difesa in profondità), quindi non rilevata dai test di rotta → **rilevata** dai test unitari di `evaluateAttach` |
| M52 | si collega un pagamento Stripe di importo diverso | sì | G3 the other checks: what Stripe says, reuse, the state of the order, and nothing that skips them |

## S4.6 Test esistenti modificati (dichiarati; nessuna asserzione di sicurezza allentata)

- `tests/security/checkout-golden.sec.ts`: non dipende più da una stampante lasciata da prove precedenti (ne crea una).
- `tests/security/reprint.sec.ts`, `s5-payment-methods.sec.ts`, `s2s3-step2.sec.ts`, `printer-machines-admin.sec.ts`: le richieste alle rotte admin ora portano `Origin` (richiesto dal controllo CSRF); le fixture con `paymentStatus: 'paid'` ora portano anche la **prova** del pagamento (`stripeProof()`), perché «pagato» da solo non rilascia più; `autoQueue()` riceve una richiesta.
- `tests/admin-order-printlab-link.test.ts` (ordini di prova pagati e un caso non rilasciato) e `tests/admin-order-stripe-attach.test.ts` (ruolo, motivo, associazione, audit).
- `tests/production-queue-display.test.ts`: +1 prova (lista degli ordini trattenuti).
- `scripts/suite-demo-seed.ts`: l'ordine dimostrativo `in_production` **non pagato** (fattura) porta ora un'`productionAuthorization` esplicita, altrimenti uscirebbe dalla coda delle schermate dimostrative; è un dato sintetico, dichiarato nel commento.

## S4.7 Deriva Prisma `ModelComment_partId_idx` — esito **separato**

Verifica a tre fonti, senza scritture sul database di prova (salvo un database ombra vuoto, poi eliminato):

1. **Schema** (`prisma/schema.prisma`, `model ModelComment`): dichiarava `@@index([modelId])`, `@@index([userId])`, `@@index([isHomeCurated, createdAt])` e **non** `@@index([partId])`.
2. **Migrazioni**: `20260303153000_model_comment_part_pins` esegue `CREATE INDEX IF NOT EXISTS "ModelComment_partId_idx" ON "ModelComment"("partId")` (riga 8); nessuna migrazione lo elimina (verificati tutti i `CREATE/DROP INDEX` su `ModelComment`).
3. **Database reale** (`mkw_sectest`, costruito con `prisma migrate deploy`): `pg_indexes` contiene `ModelComment_partId_idx`; `_prisma_migrations` registra come **applicate e finite** la `20260303153000_model_comment_part_pins` e le altre (93 su 93, nessuna interrotta o annullata).

`npm run prisma:migrate:drift` **prima**: una differenza, «Removed index on columns (partId)», codice di uscita 2. Le tre fonti concordano: l'indice esiste ovunque tranne nello schema, quindi è lo **schema** a mancare di una dichiarazione. **Correzione applicata, solo-schema, una riga:** `@@index([partId])` in `ModelComment`. Nessun SQL, nessuna migrazione, nessun dato toccato, **nessun `prisma format`** (avrebbe riformattato tutto lo schema). **Dopo:** `prisma validate` valido; `prisma:migrate:drift` (migrazioni → schema) **nessuna differenza**, codice 0; e il confronto database reale → schema **nessuna differenza**, codice 0. Scartate: una migrazione `DROP INDEX` (distruttiva, contraria all'intento della migrazione) e una `CREATE INDEX IF NOT EXISTS` (ridondante). Non verificato: lo stato della CI (`prisma-drift`) dopo il commit.

## S4.8 Differenze rispetto al piano approvato

- Un **pagamento PayPal verificato dal server** è stato aggiunto come quarta base di prova (accanto a Stripe verificato, pagamento manuale documentato, gratuito).
- `getProductionSnapshot` **omette del tutto** il campo `notReleased` quando non si chiede `includeRelease` (il piano diceva «vuoto»): i clienti non ricevono nemmeno la chiave.
- L'autorizzazione di produzione si chiede **in pagina** (modulo con motivo di almeno 10 caratteri), non con `window.confirm`; aggiunto il pulsante «Move to queue» per gli ordini `awaiting_*`; le date dei componenti nuovi sono in UTC dichiarato (identiche sul server e nel browser).
- Aggiunta la guardia statica sul sorgente (10 prove) e la prova di parità con **400 combinazioni casuali**; aggiunti `data-testid` alle liste di coda per le prove nel browser.
- `scripts/suite-demo-seed.ts` aggiornato (sopra).
- Rimane come nel piano: `lib/privacy.ts` **non modificato** (segnalato), nessuna migrazione, nessuna dipendenza, prezzi/IVA/regole commerciali invariati.

## S4.9 Anomalie e limiti noti (non risolti, nessuno nascosto)

Elenco completo in `docs/RILASCIO-PRODUZIONE.md`, §12. In sintesi: (1) ordini **non ospitati** con un motivo di revisione restano bloccati (vicolo cieco operativo: procedura eccezionale = progetto separato); (2) una contestazione su un ordine già segnalato non è registrata da `payment-sync`; (3) un tentativo `processing` rimasto su un ordine pagato non viene mai chiuso; (4) il **rimborso totale non blocca**; (5) nessuna **notifica** all'amministratore per un blocco tardivo, `recoverPostPaymentEffects` senza chiamanti, l'effetto `inventory` non condizionato al rilascio; (6) statistiche non operative (`analytics`, `demand-forecasting`, `creator-quality`) contano ordini non pagati; (7) `lib/privacy.ts` azzera tutti i metadati (difesa lato produzione: effetti «sconosciuti», nessun ritentativo); (8) il controllo di origine **non è esteso** alle altre rotte admin; (9) `acknowledgeUnverified` esiste ancora fino a S6; (10) la regola della sincronizzazione OrderWorks `pending → queued` e `scripts/hold-unpaid-orders.js` restano come erano; (11) il prefiltro Prisma è più largo della regola in due casi dichiarati (registro `paymentReview` degli ordini esterni; campi di prova di soli spazi) e per questo ogni effetto ricontrolla sotto blocco.

## S4.10 Non provato (resta «da eseguire» in `docs/CHECKLIST-PRELANCIO.md`: righe 1.13, 1.45–1.51)

Stripe reale in modalità test (collegamento di un PaymentIntent con `metadata.orderId`, dispute reali); **PrintLab reale** (che onori le chiavi di idempotenza; che `GET /api/jobs` e `GET /api/jobs/<id>` si comportino come assunto dalla riconciliazione); **StockWorks reale** (movimenti leggibili per riferimento); stampanti reali (non è mai partito alcun comando); iPhone con Safari e Android veri sulle nuove schermate; un **operatore reale** che usi il riquadro «Production release», l'autorizzazione in pagina e il modulo di conferma con il record. Le prove sono su **servizi simulati** e **browser emulati**.

## S4.11 Come riprodurre

```
npx tsc --noEmit && npm run lint && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security      # un solo giro per volta sul database
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
SEC_TEST_DATABASE_URL=… node --import tsx tests/real-run/production-release.ts                       # server reale + PrintLab/StockWorks finti
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/checkout-return.ts       # 86/86
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts   # 88/88
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… BUILT=EUR node --import tsx tests/real-run/production-guards.ts      # 8/8
# browser: seed (tests/e2e/seed-customer-orders.ts → E2E_FIXTURE; tests/e2e/seed-production-release.ts → E2E_RELEASE_FIXTURE), server di produzione, poi:
E2E_BASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium E2E_FIXTURE=… E2E_RELEASE_FIXTURE=… E2E_ADMIN_TOKEN=… npx playwright test
# deriva Prisma (database ombra vuoto e usa-e-getta):
SHADOW_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<ombra> npm run prisma:migrate:drift
```

---

# Verifica del Passo 4.6 — S5: identità e sicurezza delle sessioni ospiti (terzo punto di arresto)

Ramo `claude/stampa3d-fase1`. Descrizione del cookie, delle garanzie e dei rischi: **`docs/SESSIONE-OSPITE.md`**; decisioni e differenze dal piano: `docs/CHECKOUT-S2-S3.md`, «Passo 4.6 – S5». Questo capitolo riporta **che cosa è stato provato, con quale mezzo, con quali cifre e che cosa no**.

**Ambito autorizzato:** solo S5 («APPROVAZIONE S4 E AVVIO S5»). **Non iniziati:** S6 (pagamenti in verifica, compreso `acknowledgeUnverified`), S7, S8, Passo 5. **Il checkout non è dichiarato pronto per la produzione commerciale.** Non sono stati contattati Stripe, PrintLab, StockWorks né stampanti reali. Il motore dei prezzi, l'IVA, la spedizione, gli sconti, i centesimi e le autorizzazioni sui modelli privati **non sono stati toccati** (i file `lib/pricing.ts`, `lib/checkout-quote.ts`, `lib/sale-units.ts`, `lib/unit-pricing.ts`, `lib/tax.ts`, `lib/shipping.ts`, `lib/file-access.ts` sono identici a S4). Nessuna dipendenza aggiunta o rimossa (`git diff -- package.json package-lock.json` vuoto), `lib/privacy.ts` non modificato, una sola migrazione additiva (M2).

## S5.1 Ambiente

PostgreSQL 16 locale (`mkw_sectest`, porta 55432); Stripe simulato (client finto nei test in processo; nei percorsi reali l'SDK Stripe vero davanti a un Stripe simulato a livello HTTP, `tests/real-run/fake-stripe-http-preload.js`; nelle prove a **due processi** un Stripe finto su file condiviso, una sessione per chiave di idempotenza, come farebbe Stripe); `next start` in produzione (build con `CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR`); Chromium emulato `chromium` 1280×720, `mobile` 393×851 (Pixel 5, tocco), `mobile-small` 360×640. **Non** sono telefoni veri né Safari. Dati fittizi.

## S5.2 Risultati (confronto con il secondo punto di arresto)

| Verifica | Mezzo | S5 | Secondo punto di arresto (S4, `2a2ea9c`) |
|---|---|---|---|
| Tipi (`tsc --noEmit`) / `eslint` (`--max-warnings=0`) / `next build` | locale | **0 errori / 0 avvisi / OK** | idem |
| `npm test` | `node --test` | **471/473** — gli stessi **2 fallimenti preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`). +18 prove: 11 della sessione (`guest-session.test.ts`) e 7 del client (`checkout-client.test.ts`) | 453/455 |
| `npm run test:api` / `test:contracts` | `node --test` | **7/7 / 14/14** | 7/7 / 14/14 |
| `npm run test:security` (serie, un solo database) | `node --test --test-concurrency=1` | **1001/1001** (0 `todo`, 166 s). +57 prove: sessione 35, conservazione 10, due processi reali 7, metodi di pagamento 5 | 944/944 |
| Prova a **due processi reali** (`guest-session-multiprocess.sec.ts`) | due processi Node, un database, Stripe finto su file condiviso | **7/7**, ripetuta **4 volte** (nella suite e 3 giri a parte, ~18 s ciascuno): nessuna instabilità | — |
| Server reale `tests/real-run/guest-session.ts` (cookie cancellati, rifiutati, due schede, due browser, `Secure` dietro il proxy, cache) | `next start` + Chromium + SDK Stripe vero su rete simulata, 3 formati | **77/77** | — |
| `checkout-return.ts` (ritorno da Stripe simulato) | idem | **86/86** | 86/86 |
| `checkout-matrix.ts` (`STRICT_CART=1`, matrice economica carrello → preventivo → ordine → Stripe) | idem | **88 esecuzioni, 0 differenze** tra preventivo, ordine e Stripe; **0** differenze carrello/preventivo — **nessun totale è cambiato** | 88/88 |
| `production-guards.ts` (valuta, minimo d'ordine) | idem | **8/8** | 8/8 |
| `production-release.ts` (regressione di S4 sul server reale, PrintLab/StockWorks finti) | idem | **68/68** | 68/68 |
| Intera suite nel browser (`npx playwright test`, 3 formati) | Playwright, Chromium emulato | **2° giro: 271 passati, 3 saltati, 0 falliti** (+12: 4 prove × 3 formati). **1° giro: 270 passati, 3 saltati, 1 fallito** — vedi la nota sotto | 259 passati, 3 saltati, 0 falliti |
| Migrazione M2 | `prisma migrate deploy` | **94/94 migrazioni su un database vuoto** (colonna `TEXT` nullabile e indice presenti); su una **copia popolata** (15 ordini, 15 righe, 15 tentativi) gli ordini, le righe, i tentativi e gli utenti restano **identici** (impronta md5 per tabella, a parte la nuova colonna) e la colonna è `NULL` ovunque | — |
| Deriva Prisma | `prisma migrate diff --exit-code`, `prisma validate` | **0 differenze** (migrazioni → schema; database vuoto migrato → schema; copia popolata → schema); schema valido | 0 differenze |
| Mutazioni sul codice nuovo | script fuori dal repository | **48/48 rilevate**, nessuna sopravvissuta (S5.4), **+ 3/3** sull'interfaccia con build vera e browser (S5.4-bis) | 52/52 |
| Dipendenze / `lib/privacy.ts` / motore dei prezzi | `git diff` | **nessuna modifica** | — |

**Nota sul primo giro del browser.** Il fallimento del primo giro è `journey-guards.responsive.spec.ts` (percorso ospite completo) sul solo progetto `chromium`: l'asserzione «nessun errore nella console del browser» ha trovato `Failed to load model …/e2e-shop-model.stl TypeError: Failed to fetch`, cioè il visualizzatore 3D ha registrato un caricamento del modello non andato a buon fine (verosimilmente interrotto: il percorso era già passato ad un'altra pagina). **Non riguarda S5** (nessun file di visualizzatore, di file o di modello è toccato; la richiesta è il file STL, non il checkout); non si è ripetuto in **4 giri della stessa prova** (4/4) né nel **secondo giro completo** (271/271), e nei giri di S4 questa prova non era mai fallita. La mia lettura è una **gara di tempi** (navigazione contro caricamento del file con due processi di prova in parallelo e altro lavoro sulla macchina): è un'ipotesi coerente con i fatti, **non dimostrata**. Non ho allentato né filtrato il controllo.

## S5.3 Che cosa cambia per l'ospite (prima/dopo)

«Prima» è il comportamento di S4 (`2a2ea9c`): le vecchie versioni delle prove riscritte (S5.5) lo descrivevano e passavano; «dopo» è S5.

| Situazione | Prima | Dopo |
|---|---|---|
| Un ospite paga **senza sessione valida** (assente, alterata, scaduta, firmata con un altro segreto) | ordine e pagina Stripe creati | **428** + nuova sessione; **0 ordini, 0 tentativi, 0 chiamate a Stripe**; il client ripete **una volta**, un secondo 428 → «cookie non conservati» |
| Due ospiti con la **stessa chiave** e lo stesso carrello | stessa chiave memorizzata: la separazione era affidata alla sola segretezza della chiave (192 bit) | **due ordini, due pagine Stripe**, nessun cookie d'accesso per l'ordine altrui; una chiave che trova l'ordine di un'altra sessione → `CHECKOUT_KEY_CONFLICT` senza dettagli |
| Doppio clic (stessa chiave) | un ordine | un ordine |
| Due schede dello stesso browser, **chiavi diverse** (`localStorage` non condiviso), richieste simultanee | due ordini, due pagine Stripe (la prima richiesta non aveva identità) | **un ordine, una pagina Stripe** (blocco per sessione e carrello + riuso dell'ordine non pagato dentro il blocco) |
| Pagamento già in conferma per lo stesso carrello, altra chiave | bloccato solo se il browser aveva ancora il cookie d'accesso (72 h) | bloccato anche dalla **sola sessione**; il 409 **non nomina l'ordine** quando è riconosciuto solo dalla sessione |
| Cookie d'accesso cancellato, sessione conservata | secondo ordine | 409 senza identificativi; un altro browser → secondo ordine (R2/R4, dichiarati) |
| Cookie bloccati dal browser | l'ospite paga e non ha pagina di stato | avviso **prima** del pulsante se `navigator.cookieEnabled === false`; altrimenti messaggio dopo il secondo 428; carrello intatto; nessun addebito |
| Intestazioni delle risposte del checkout | `Cache-Control: no-store` | `no-store, private` + `Pragma: no-cache` + `Vary: Cookie` (successo, 428, 409, 400, 403, 429) |
| Dati personali | — | solo `SHA-256` del `sid` su `PrintOrder.guestSessionHash`; azzerato dopo 45 giorni salvo ordini con pagamento in dubbio |
| Prezzi, IVA, spedizione, sconti, importi in centesimi, modelli privati | — | **invariati** (matrice economica 88/88, golden, prova «the economics do not move») |

## S5.4 Mutazioni (script fuori dal repository, ogni mutazione ripristinata subito)

Ogni riga è una protezione rotta apposta nel codice nuovo di S5; il test che la rileva è indicato con le prime prove che falliscono. **48 mutazioni su 48 rilevate alla prima selezione (nessuna sopravvissuta)**. Alla fine tutti i file erano identici al salvataggio fatto prima delle mutazioni (confronto byte per byte di `lib/`, `app/`, `components/`, `prisma/` e `tests/`). Il codice dell'interfaccia (React) non è raggiunto dallo script: vedi S5.4-bis.

| # | Cosa si rompe | Prove che falliscono | Prima prova che la rileva |
|---|---|---|---|
| G01 | la firma del cookie non è verificata | 5 | a forged or altered value is refused: another sid, another date, another or truncated signature, a signature taken… |
| G02 | il server non fa scadere la sessione (conta solo il browser) | 3 | the session ends 30 days after it was issued, by the server's own count; one from the future is believed only withi… |
| G03 | un cookie datato nel futuro è creduto | 1 | the session ends 30 days after it was issued, by the server's own count; one from the future is believed only withi… |
| G04 | la firma non copre la data (la data si può spostare avanti) | 1 | a forged or altered value is refused: another sid, another date, another or truncated signature, a signature taken… |
| G05 | l'hash memorizzato è un SHA-256 semplice della sessione (senza etichetta) | 1 | a new session verifies, carries 128 random bits, and the database would only ever see a hash of them |
| G06 | tutte le nuove sessioni sono la stessa identità | 3 | every new session is a different identity |
| G07 | il rinnovo di una sessione ne cambia l'identità | 2 | a session in use is renewed (same identity, new date) once it is a day old; a young one is left alone |
| G08 | il cookie è leggibile dagli script (HttpOnly tolto) | 1 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| G09 | il cookie viaggia con le richieste di altri siti (SameSite=None) | 1 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| G10 | il cookie vive un anno nel browser | 1 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| G11 | un ospite senza sessione passa comunque (niente 428) | 5 | session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - a… |
| G12 | un ospite senza sessione ne riceve una e l'ordine si crea subito | 5 | session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - a… |
| G13 | la chiave di ripetizione di tutti gli ospiti torna in un unico spazio condiviso | 3 | two guests with the SAME checkout key and the same cart get two orders, two payment pages, and never the other's |
| G14 | una chiave che trova l'ordine di un'altra sessione viene accettata | 1 | defence in depth: a key that finds an order of ANOTHER session (or of an account, or one with no session) is refuse… |
| G15 | la guardia contro un secondo pagamento non conosce la sessione del browser | 5 | guest: a cookie that opens nothing (forged token, another order's token, expired access) is ignored: never reused,… |
| G16 | un pagamento in corso è rifiutato nominando l'ordine anche a un browser noto solo dalla sessione | 2 | a payment being confirmed for this cart blocks the same browser session with ANY key - and the refusal names no ord… |
| G17 | l'ordine non pagato della stessa sessione non viene cercato | 6 | two tabs: several requests at the same moment, same session, DIFFERENT keys (localStorage not shared) = still ONE o… |
| G18 | il blocco per sessione e carrello non è preso — trovata dai **due processi reali** | 3 | A. two processes, one browser session, DIFFERENT keys, the same cart - six rounds: every round is ONE order, ONE at… |
| G18b | idem — trovata dai test in processo che tengono ogni richiesta dentro il blocco | 2 | two tabs: several requests at the same moment, same session, DIFFERENT keys (localStorage not shared) = still ONE o… |
| G19 | il blocco è uno solo per tutti gli ospiti (l'acquisto di uno rallenta quello di un altro) | 1 | made certain: guests do not wait for each other - two sessions are inside at the same time, and make two orders |
| G20 | l'ordine è creato senza l'hash della sessione | 16 | session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - a… |
| G21 | lo strato degli ordini accetta un ordine ospite senza sessione | 1 | the order layer has the rule too, not only the route: a guest order can not be created without a session (nothing i… |
| G22 | le risposte del checkout possono essere conservate da una cache condivisa | 3 | quote: a guest with no session is given one, with the strict attributes; the answer is never cached |
| G23 | le risposte non dicono di variare per cookie | 2 | quote: a guest with no session is given one, with the strict attributes; the answer is never cached |
| G24 | il preventivo non consegna la sessione | 3 | quote: a guest with no session is given one, with the strict attributes; the answer is never cached |
| G25 | le richieste non sono contate per sessione | 3 | the order stores a hash of the session, from the moment it exists; the session itself is nowhere - not in the datab… |
| G26 | il preventivo consegna una sessione ospite anche a un cliente con account | 1 | quote: answers without a quote (a bad request, a model that can not be sold) hand out no session; a signed-in custo… |
| G27 | una sessione in uso non viene rinnovata al pagamento | 1 | "pay" keeps a session in use alive: an old session gets a new date with the SAME identity, a young one is left alone |
| G28 | il 428 non consegna al browser una sessione | 2 | session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - a… |
| G29 | il 428 mette la nuova sessione nel corpo della risposta | 1 | session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - a… |
| G30 | una chiave trovata per questo checkout non è confrontata con la sessione nella rotta | 1 | defence in depth: a key that finds an order of ANOTHER session (or of an account, or one with no session) is refuse… |
| G31 | il client chiede una terza volta dopo un secondo 428 (ciclo) | 1 | requestSession: a second 428 means the browser keeps no cookies - said once, no third request, no loop |
| G32 | il client ripete con una chiave diversa | 1 | requestSession: a 428 is answered by the SAME request once more (same key, same body) and the payment page follows |
| G33 | il client non dice che il browser non conserva i cookie | 1 | requestSession: a second 428 means the browser keeps no cookies - said once, no third request, no loop |
| G34 | il client non attende prima della ripetizione | 1 | requestSession: the repeat waits a short, fixed time (both tabs of a new browser get their answer first); a cancell… |
| R01 | la conservazione svuota l'hash di un ordine con pagamento in dubbio | 3 | the hash goes from old orders that nobody waits on, stays on young ones and on every order whose payment is in doubt |
| R02 | la conservazione sposta «updatedAt» degli ordini che tocca | 1 | ONLY the hash changes: not the metadata, the review reason, the payment markers, the access token, the key - and no… |
| R03 | la conservazione svuota l'hash degli ordini recenti | 4 | the hash goes from old orders that nobody waits on, stays on young ones and on every order whose payment is in doubt |
| R04 | la conservazione lascia i contatori per sessione | 1 | the per-session request counters go with the hash: the guest ones older than the limit are deleted, the others stay |
| R05 | la conservazione cancella ogni contatore vecchio, non solo quelli degli ospiti | 1 | the per-session request counters go with the hash: the guest ones older than the limit are deleted, the others stay |
| R06 | il limite predefinito di 45 giorni diventa 10 | 5 | the policy: 45 days by default, from DATA_RETENTION_GUEST_SESSION_DAYS, and a wrong value falls back to 45 |
| R07 | la regola SQL «pagamento in dubbio» dimentica i tentativi | 4 | the hash goes from old orders that nobody waits on, stays on young ones and on every order whose payment is in doubt |
| R08 | la regola Prisma «pagamento in dubbio» dimentica un pagamento non corrispondente | 1 | the JavaScript rule and the SQL rule pick the same orders (the guard against a second payment, and the retention th… |
| R09 | la rotta di pulizia accetta una richiesta da un altro sito | 1 | the cleanup route (it now writes orders too) refuses a request from another site before it touches anything; the si… |
| P01 | il pagamento accetta campi che non conosce (un metodo, una prova di pagamento) | 1 | the pay endpoint has no field for a payment method, a provider or a proof of payment: naming one is refused and not… |
| P02 | un mittente esterno può scrivere una prova PayPal | 1 | nothing an outside sender writes can become a PayPal proof: the key is reserved, and the proof needs a capture id A… |
| P03 | una pagina pubblica nomina PayPal | 1 | the public pages and components do not offer PayPal; its button lives only in the billing page of administrators an… |
| P04 | un'altra rotta legge il cookie di sessione (guardia statica) | 1 | another guest's session (even a copy of it) opens no order, and the session itself is only ever read by the two che… |

### S5.4-bis Mutazioni dell'interfaccia (build vera + browser, 3 formati)

Lo script sopra rompe il codice del server e i moduli puri; l'interfaccia (React) richiede una build per ogni mutazione. Tre protezioni della pagina sono state rotte **una alla volta**, il sito ricostruito (`next build`, `CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR`) e la spec `guest-session.responsive.spec.ts` (4 prove × 3 formati = 12) rilanciata contro `next start`. Alla fine i due file erano identici al salvataggio (confronto byte per byte), la ricostruzione pulita è andata a buon fine e la spec è tornata **12/12**.

| # | Cosa si rompe | Esito | Prova che la rileva |
|---|---|---|---|
| U01 | il pulsante «Paga» resta attivo in un browser che dichiara di non conservare i cookie | **rilevata** (9 passate, 3 fallite = una prova × 3 formati) | a browser that says it keeps no cookies is told BEFORE the button: nothing to press, the cart untouched |
| U02 | l'avviso «cookie disattivati» non compare | **rilevata** (9 passate, 3 fallite) | la stessa prova |
| U03 | dopo il secondo 428 la pagina non dice che il problema sono i cookie | **rilevata** (9 passate, 3 fallite) | a browser that keeps no cookies: after the one repeat the page says so, nothing loops, the cart is untouched and the customer can try again |

**Non mutato, e perché:** la guardia dentro `pay()` (il controllo `cookiesOff` in testa alla funzione) è una seconda difesa dietro il pulsante già spento; con il pulsante disattivato nessuna prova del browser può invocarla, quindi una mutazione lì non sarebbe rilevabile da un browser — è difesa in profondità, non una protezione verificabile da fuori. I passaggi del client (ripetizione unica, nessun terzo tentativo, pausa, stessa chiave) sono rotti da G31–G34 e dai loro unitari.

## S5.5 Test esistenti modificati (dichiarati; nessuna asserzione di sicurezza o di prezzo allentata)

- **Helper delle ospiti** (`_guest.ts` nuovo: `newGuestBrowser`, `guestHeaders`): le prove che chiamano le due rotte del checkout come ospite ora mandano il cookie di sessione di un «browser di prova» — `checkout-consistency`, `economic-thresholds`, `guest-checkout`, `manual-review`, `minimum-after-scale`, `minimum-amounts`, `multipart-pricing`, `price-multiplier`, `price-waivers`, `printer-limits`, `printer-scenarios`, `s2s3-step3`, `set-orders` (da 3 a 7 righe ciascuna, nessuna asserzione cambiata). Senza il cookie riceverebbero 428: è proprio il comportamento nuovo.
- **`s2s3-step2.sec.ts`**: lo stesso, più la prova dei limiti di richieste: le cinque richieste dallo stesso indirizzo usano **un browser nuovo ciascuna** (con la stessa sessione sarebbero lo stesso acquisto, quindi un solo ordine: la prova voleva contare ordini distinti).
- **`s2s3-step4.sec.ts`**: i due ospiti `g1`/`g2` e il pagatore dell'ultima prova usano browser diversi (stesso motivo). Parametro `browser` aggiunto agli helper.
- **`cart-after-payment.sec.ts`**: helper e **tre prove riscritte** che fotografavano come «limite scritto» l'assenza di identità: (1) due richieste simultanee con chiavi diverse e senza cookie d'accesso **ora fanno un ordine** (il limite si chiude per lo stesso browser; il caso residuo — due browser — è nella stessa prova, R1 in `guest-session.sec.ts`); (2) un cookie d'accesso falso/altrui/scaduto: un altro browser riceve 200 e un ordine nuovo, lo **stesso** browser un 409 senza identificativi; (3) cookie d'accesso cancellato con sessione conservata: 409 senza identificativi; altro browser: secondo ordine (R2/R4).
- **`checkout-client.test.ts`**: da 21 a 28 prove (le 7 nuove sono del 428); le prove del handshake usano `NO_PAUSE` (la pausa di 300 ms è una proprietà e ha la sua prova).
- **`tests/real-run/production-guards.ts`**: il «browser» dello script conserva il cookie `mw_sid` ricevuto dal preventivo (altrimenti avrebbe ricevuto 428).
- **`tests/production-release-guards.test.ts`** (guardia di S4): il registro degli scrittori di `PrintOrder` ha una voce in più, `lib/data-retention.ts` come `maintenance` (la conservazione ora azzera la sola colonna `guestSessionHash`). **La guardia ha fatto il suo lavoro:** ha fermato il nuovo scrittore non classificato nella suite unitaria completa (471/473 dopo la voce; prima 470/473). Nessuna regola di S4 è cambiata.
- Totale: **nessuna prova di S4 è stata cancellata o indebolita**; i sei casi che descrivevano i vecchi limiti sono quelli riscritti sopra (tre in `cart-after-payment`, uno in `s2s3-step2`, due in `s2s3-step4`, assegnati a ospiti diversi).

## S5.6 Dove sono dimostrati i requisiti A–H e le prove obbligatorie

| Richiesta | Dove | Mezzo |
|---|---|---|
| **Sessione valida / assente / scaduta / falsificata** | `tests/guest-session.test.ts` (11: firma, spellings base64, altro segreto, scadenza a 30 giorni, futuro, rinnovo, attributi); `guest-session.sec.ts` (preventivo ×4, pagamento ×5: assente, alterata/scaduta/altro segreto, bad request prima della sessione, cliente con account); `real-run/guest-session.ts` | unitario, handler reali, `next start` |
| **Cookie disattivati / rifiutati** (F) | `checkout-client.test.ts` (7); `guest-session.sec.ts` («a browser that keeps no cookies…»); `guest-session.responsive.spec.ts` (2 prove × 3 formati); `real-run/guest-session.ts` (Chromium vero, risposte senza `Set-Cookie`) | unitario, handler reali, browser **emulato** |
| **Doppio clic / due schede dello stesso browser** (D) | «double click», «two tabs…», «a second request with another key…», «made certain: … held inside the lock» (sei richieste), `guest-session.responsive.spec.ts` («double tap»), processi A–C | in processo, due processi reali, browser emulato |
| **Due ospiti, stessa `checkoutKey`** (C) | «two guests with the SAME checkout key…», «the same key with ANOTHER cart…», «defence in depth…», «requests… from two DIFFERENT guests…», processi E | in processo, due processi reali |
| **Richieste concorrenti e due processi reali** (D) | `guest-session-multiprocess.sec.ts` A–G: stessa sessione chiavi diverse (6 giri), stessa chiave, sei richieste, nessuna sessione, due ospiti, R1, **i tratti dentro il blocco non si sovrappongono tra processi** | due processi Node reali, un solo database |
| **Ripetizioni dopo errori di rete** | «Stripe unreachable, then the same request again», «the answer is lost after Stripe made the page…»; `requestSession`: «only a 428 is repeated… a lost connection is returned as it is» | in processo, unitario |
| **Ritorno da Stripe simulato** | `real-run/checkout-return.ts` | `next start` + Chromium + Stripe simulato |
| **Nessuna informazione privata esposta** (A) | «a session cookie alone opens nothing…», «another guest's session… only ever read by the two checkout routes» (guardia statica), «the order stores a hash…, the session itself is nowhere», «every answer… is private and never cached» | handler reali + sorgente |
| **Conservazione e scadenza degli hash** | `guest-session-retention.sec.ts` (10), `guest-session.test.ts` (scadenza server) | handler reali, database |
| **E. nessun ordine né Stripe senza sessione, un solo nuovo tentativo** | «with no session cookie… 428 and NOTHING is made», «forged, altered, expired…», «requests at the same moment with no session at all: all 428», `requestSession` ×2, processi D | in processo, unitario, due processi |
| **G. R1 documentato, non dichiarato risolto** | «RESIDUO R1 (not closed)…» in processo e con due processi (F) | in processo, due processi |
| **H. prezzi, IVA, spedizione, sconti, centesimi** | «the economics do not move…», `checkout-golden`, `checkout-matrix` (STRICT_CART=1), 13 file di prove di prezzo e importi adattati solo nell'helper di richiesta (import e intestazione del cookie: nessuna riga con un'asserzione è cambiata) | in processo, `next start` |
| **PayPal non entra nel checkout pubblico** | `public-checkout-payment-methods.sec.ts` (5): nessun campo «metodo», ordine carta, Stripe chiesto solo `card`, la rotta vecchia rifiuta PayPal a ospiti/clienti/staff, la prova PayPal non si falsifica, pagine pubbliche senza PayPal | handler reali + sorgente |
| **Regressione completa di S4** | tutti i file di S4 nella suite di sicurezza (944 prove) e nell'unitaria (453) + `production-release.ts` 68/68 sul server reale + Playwright | vedi S5.2 |

## S5.7 Difetti e sorprese trovati durante il lavoro

1. **La guardia di S4 sugli scrittori di `PrintOrder` ha fermato `lib/data-retention.ts`** (nuovo scrittore: azzera `guestSessionHash` con `UPDATE "PrintOrder" …`) solo quando ho lanciato la suite unitaria completa a fine lavoro. Classificato `maintenance` con il motivo (S5.5). Lezione: dopo ogni modifica in `lib/` si lancia `npm test` intero, non solo i file toccati.
2. **I test di concorrenza in processo NON rilevavano un blocco consultivo tolto** (l'intreccio naturale delle richieste non bastava). Aggiunto il punto di prova `checkoutOrderHooks.afterLock` (nullo in produzione) e le prove «con ogni richiesta tenuta dentro il blocco»; la mutazione G18 è stata trovata dai **due processi reali** (test G: i tratti dentro il blocco di due processi non si sovrappongono) e la G18b dai test in processo.
3. Una prova statica segnalava `lib/checkout-orders.ts` perché un commento nominava `lib/guest-session.ts`: la regola ora cerca l'`import`, la stringa `'mw_sid'` o `GUEST_SESSION_COOKIE`, non il testo libero.
4. `Secure` su http locale: Next imposta `x-forwarded-proto: http` anche in connessione diretta, quindi in prova locale il cookie **non** è `Secure` (corretto); `Secure` compare dietro un proxy che dice `https` (prova dedicata). **Da leggere dalla risposta reale in produzione** (checklist 1.54).
5. L'emulazione del rifiuto dei cookie nel browser non funzionava con `route.fetch()` (condivide il barattolo dei cookie del browser): il gestore ora cancella i cookie dentro la richiesta.
6. `tests/real-run/production-guards.ts` avrebbe ricevuto 428 senza cookie: aggiunto il barattolo.
7. Primo giro completo di sicurezza dopo il codice, prima di adattare le prove: **6 fallimenti attesi** (le sei prove che descrivevano il vecchio ospite senza identità, S5.5); dopo l'adattamento 984/984, poi 1001/1001 con le prove nuove.
8. Una mia ipotesi sbagliata in un unitario (l'ultimo carattere dei 43 della firma porta 4 bit significativi, quindi 3 «cugini» e non 15) e un errore di tipo (`customer` possibile `null`): corretti.
9. **Il numero delle mutazioni** previsto a memoria (53) era sbagliato: lo script ne contiene **48** (35 sulla sessione e le rotte, 9 sulla conservazione, 4 su PayPal/guardie); il conteggio dichiarato è quello del registro.

## S5.8 Differenze rispetto al piano approvato

Elenco completo in `docs/SESSIONE-OSPITE.md`, §10 (data di emissione nel cookie, rinnovo, limite per sessione anche sul preventivo, pausa di 300 ms, predicato unico `payment-in-doubt`, conservazione che salva gli ordini in dubbio e cancella i contatori, controllo di origine sulla rotta di pulizia, intestazioni di cache, 409 senza identificativi, avviso `cookieEnabled`, punto di prova `afterLock`, prove adattate). In più: la voce del registro degli scrittori (S5.5). **Nessuna differenza riguarda prezzi, importi o autorizzazioni.** Nessuna decisione architetturale che richiedesse la tua scelta è emersa (nessun conflitto tra cancellazione dei dati e sicurezza operativa: `lib/privacy.ts` non è stato toccato).

## S5.9 Rischi residui e limiti noti (non risolti, nessuno nascosto)

- **R1 — NON eliminato:** due *prime* richieste simultanee di un browser nuovo possono ricevere due sessioni diverse e creare due ordini con due pagine Stripe. Fotografato da due test (in processo e con due processi reali) e ridotto (cookie al primo preventivo, 428 solo come rete di sicurezza, 300 ms prima dell'unica ripetizione); **non dimostrabile come nullo**; rilevabile a posteriori (Passo 5, checklist 1.56) — ma **rilevare non è prevenire** i doppi addebiti. **Decisione del titolare (2026-10-17): R1 NON accettato, bloccante per il lancio con traffico da ospite**; la rilevazione non lo sblocca; prima del lancio: verifica della mitigazione effettiva e rischio residuo al titolare per approvazione esplicita e scritta (checklist 1.38).
- **R2** cookie perso o scaduto (senza cookie d'accesso, una ripetizione crea un secondo ordine; l'ordine non pagato si ritrova dal cookie d'accesso per 72 h). **R3** sessione copiata: non apre nulla; può solo, con lo stesso carrello e lo stesso totale entro un'ora, ottenere la pagina di pagamento di un ordine **non pagato** di quella sessione. **R4** due dispositivi/due browser: identità indipendenti. **R5** carrello modificato dopo un primo ordine non pagato: pagine Stripe gemelle (Passo 5). **R6** Safari/ITP e browser integrati nelle app: da provare su dispositivi veri. **R7** (nuovo in S5) sessione imposta al browser da un sottodominio gemello o da una rete http: stessa portata di R3, mitigata da `Secure`/`HttpOnly`/`SameSite=Lax`; **mitigata nella chiusura di S5 (S5.12)** con il prefisso `__Host-`; HSTS resta del proxy (`docs/SESSIONE-OSPITE.md`, §7).
- **Ambito (scelta dichiarata; confermata dal titolare il 2026-10-17):** la sessione protegge il percorso **con pagamento**. Le due strade che creano un ordine **senza pagamento e senza sessione Stripe** — la richiesta di preventivo manuale (`/api/checkout/manual-request`) e il metodo `quote` della rotta vecchia — non la richiedono e i loro ordini non hanno `guestSessionHash`; la carta della rotta vecchia è spenta in produzione. Il requisito «niente ordini né sessioni Stripe senza sessione valida» vale per ogni ordine che può essere pagato. Estenderlo ai preventivi (per limitarne i duplicati) è una decisione separata: il titolare ha deciso di lasciarli senza sessione.
- `POST /api/admin/data-retention` è chiamabile anche dallo staff (come prima; ora con controllo di origine).
- Dopo la conservazione un ordine vecchio non si ritrova più dalla chiave (`CHECKOUT_KEY_CONFLICT`, il client si ripulisce): voluto.
- **Regressioni di S4:** nessuna. L'unico effetto su S4 è una voce nel registro di una sua guardia statica (S5.5/S5.7).
- Il cookie `mw_sid` è «strettamente necessario» solo secondo la mia lettura: l'informativa va fatta verificare (checklist 1.53).

## S5.10 Non provato (resta «da eseguire» in `docs/CHECKLIST-PRELANCIO.md`: 1.38, 1.52–1.59)

Stripe **reale** in modalità test con la sessione ospite; **iPhone Safari e Android Chrome veri**, browser integrati nelle app, modalità privata (solo Chromium emulato); `Secure` e `Vary` dietro il **proxy di produzione reale**; **due istanze reali** dietro un bilanciatore con lo stesso `JWT_SECRET` (con due processi sulla stessa macchina e un solo database è provato); l'informativa legale; la pianificazione effettiva di `retention:run`; l'**assenza** di R1 (non esiste una prova di assenza). Le prove in questo capitolo sono su **servizi simulati e browser emulati**.

## S5.11 Come riprodurre

```
npx tsc --noEmit && npm run lint && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security                   # un solo giro per volta sul database
SEC_TEST_DATABASE_URL=… node --test --test-concurrency=1 --import tsx tests/security/guest-session-multiprocess.sec.ts   # due processi reali
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session.ts            # 77 controlli alla consegna di S5, 114 dopo la chiusura (S5.12)
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/checkout-return.ts                  # Stripe simulato
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts   # matrice economica
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… BUILT=EUR node --import tsx tests/real-run/production-guards.ts
SEC_TEST_DATABASE_URL=… node --import tsx tests/real-run/production-release.ts                                    # regressione di S4 sul server reale
# browser (tutta la suite, 3 formati): seed come in S4.11, server di produzione, poi
E2E_BASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium E2E_FIXTURE=… E2E_RELEASE_FIXTURE=… E2E_ADMIN_TOKEN=… npx playwright test
# migrazione M2 (database vuoto e usa-e-getta; poi su una copia popolata) e deriva:
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<vuoto> npx prisma migrate deploy
SHADOW_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<ombra> npm run prisma:migrate:drift
```

## S5.12 Chiusura di S5 — R7: il cookie di sessione ospite diventa `__Host-mw_sid` (2026-10-17)

**Ambito autorizzato:** registrare le decisioni del titolare (commit `352f615`, solo documenti) e realizzare l'hardening R7 con il prefisso `__Host-`, con due precisazioni: (1) in produzione https la scelta del nome **non deve poter essere aggirata** da `Forwarded` / `X-Forwarded-Proto` non attendibili, la configurazione del proxy deve essere affidabile e **nel dubbio il checkout ospite fallisce in modo sicuro, senza ripiegare sul cookie meno protetto**; nessuna regressione nello sviluppo HTTP; (2) **R1 resta NON accettato e bloccante** (nessun codice). **Non iniziati:** S6, S7, S8, Passo 5. Nessuna migrazione, nessuna dipendenza, nessun cambio di prezzi, IVA, spedizione, sconti, centesimi o autorizzazioni; `shouldUseSecureCookies()` (che serve anche ai cookie di accesso) **non è stata toccata**.

### S5.12.1 Che cosa cambia (prima/dopo)

| Situazione | Prima (S5, `127ccfc`) | Dopo |
|---|---|---|
| Nome del cookie in produzione (https) | `mw_sid` | **`__Host-mw_sid`**: `Secure`, `Path=/`, nessun `Domain`, `HttpOnly`, `SameSite=Lax`, 30 giorni |
| Nome su http semplice (sviluppo, prove, telefono in rete locale) | `mw_sid` | `mw_sid` (invariato; un browser rifiuterebbe il prefisso su http) |
| Quale nome legge il server | `mw_sid` sempre | **soltanto quello della connessione**: su https un `mw_sid` valido e firmato è ignorato (non cancellato) |
| Che cosa decide il nome in produzione | `shouldUseSecureCookies()`: intestazione dichiarata dal visitatore → `COOKIE_SECURE` → `BASE_URL` | **la configurazione**: sempre `__Host-`; `X-Forwarded-Proto`, `Forwarded` e `COOKIE_SECURE=false` non possono abbassarlo |
| `mw_sid` valido «piantato» nel browser prima del preventivo (https) | adottato come sessione dell'ospite | ignorato: l'ordine porta l'hash della sessione `__Host-` consegnata dal server; l'hash del piantatore non compare su nessun ordine |
| `X-Forwarded-Proto: http` forgiato dal visitatore (produzione) | cookie non `Secure`, pagamento possibile | nessun effetto sul nome; se è la voce del **proprio** proxy (letta dalla fine della lista, `TRUSTED_PROXY_HOPS`) → **503 `CHECKOUT_UNAVAILABLE`**, nessun ordine, nessun tentativo, nessuna chiamata a Stripe, nessun cookie; il preventivo mostra il prezzo senza cookie; metrica `checkout_insecure_transport_total` |
| Proxy che accoda invece di sovrascrivere (`http, https`) | letto il primo valore (quello del visitatore) | conta la voce del proxy (l'ultima): `http, https` = https, `https, http` = rifiuto |
| Sviluppo HTTP (`next dev`, prove in processo) | `mw_sid`, non `Secure` | **identico** (prova a tabella contro `shouldUseSecureCookies()` + corsa reale su `next dev`) |

### S5.12.2 Risultati (confronto con la consegna di S5)

| Verifica | Mezzo | Dopo la chiusura | S5 (`127ccfc`) |
|---|---|---|---|
| Tipi (`tsc --noEmit`) / `eslint` / `next build` | locale | **0 errori / 0 avvisi / OK** | 0 / 0 / OK |
| `npm test` | `node --test` | **485/487** — gli stessi **2 fallimenti preesistenti**. +14 prove: 3 sul cookie in `guest-session.test.ts` (ora 14) e 11 nuove in `guest-cookie-transport.test.ts` | 471/473 (2 preesistenti) |
| `npm run test:api` / `test:contracts` | `node --test` | **7/7 / 14/14** | 7/7 / 14/14 |
| `npm run test:security` (serie) | `node --test --test-concurrency=1` | **1010/1010** | 1001/1001 |
| Due processi reali | `guest-session-multiprocess.sec.ts` | **7/7, ripetuta 4 volte** | 7/7 ×4 |
| Server reale `guest-session.ts` (ora dietro proxy TLS di prova, https vero) | `next start` produzione + proxy TLS autofirmato + Chromium emulato | **114/114** | 77/77 |
| `checkout-return.ts` (ora dietro il proxy TLS) | idem | **86/86** | 86/86 |
| `checkout-matrix.ts` (`STRICT_CART=1`, ora dietro il proxy TLS) | idem | **88 esecuzioni, 0 differenze** (nessun totale cambiato) | 88/88 |
| `production-guards.ts` (solo `fetch`, ora con `X-Forwarded-Proto: https`) | idem | **8/8** | 8/8 |
| `production-release.ts` (S4; non paga da ospite, invariato) | idem | **68/68** | 68/68 |
| Controllo in sviluppo `guest-session-dev.ts` (`next dev`, http semplice) | `next dev` + Chromium emulato | **21/21**: nome `mw_sid` non `Secure`, 428 e ripetizione, un proxy che dice «http» non rifiuta nessuno, uno che dice «https» riceve `__Host-mw_sid`; il `mw_sid` piantato **viene adottato** (controllo di riscontro) | — |
| Intera suite nel browser (`npx playwright test`, 3 formati) | Playwright | **271 passati, 3 saltati, 0 falliti** (un solo giro, il primo sullo stato finale; identico a S5) | 271 passati, 3 saltati |
| Mutazioni sul codice nuovo | script fuori dal repository | **32/32 nuove + 48/48 di S5 rilanciate** rilevate (80/80 lato server) | 48/48 + 3/3 |
| Dipendenze / migrazioni / motore dei prezzi | `git diff` | **nessuna modifica** | — |

### S5.12.3 Come sono dimostrate le due precisazioni

1. **Le intestazioni non possono abbassare il nome in produzione.** Prove a tabella (`tests/guest-cookie-transport.test.ts`, 11): con ogni combinazione di `X-Forwarded-Proto`, `Forwarded`, `TRUSTED_PROXY_HOPS` 0/1/2/non valido e `COOKIE_SECURE` il risultato in produzione non è mai «plain»; liste lette dalla fine; intestazioni enormi (per lunghezza e per numero di voci, ciascun limite provato da solo) = nessuna affermazione; conflitto tra le due intestazioni = rifiuto. In processo (`guest-session.sec.ts`, sezione 9, 9 prove nuove su 44; la prova `Secure` esistente è stata riscritta) e **sul server reale** (`guest-session.ts`, sezione «sul filo»: `http, https`, parola incomprensibile, `Forwarded: proto=https` → sempre `__Host-mw_sid` `Secure`; `http`, `https, http`, `Forwarded: proto=http` contro `https`, nessuna intestazione → 503 senza cookie e con zero ordini; attraverso il vero proxy TLS le intestazioni scritte dal client vengono sovrascritte). Il server di prova gira con `COOKIE_SECURE=false` (il predefinito di `docker-compose.yml`): non cambia nulla.
2. **Nel dubbio il checkout ospite si rifiuta, senza ripiegare.** Il rifiuto è provato in tre punti: in processo (503, nulla creato, nessun cookie di alcun nome, neanche con un cookie `__Host-` valido; contata la metrica), sul filo del server reale, e **in un browser** (sezione [8]: Chromium raggiunge `next start` senza proxy, vede il prezzo, preme «Paga» e legge «Il pagamento online non è disponibile al momento»; zero ordini, zero pagine Stripe, nessun cookie, carrello intatto, nessuno scorrimento orizzontale, 3 formati).
3. **Nessuna regressione in sviluppo HTTP.** Fuori produzione la risposta è per costruzione quella di `shouldUseSecureCookies()` (prova a tabella su 3 valori di `COOKIE_SECURE`, 3 di `BASE_URL`, 3 di `NODE_ENV`, 4 intestazioni); l'intera suite di sicurezza (che gira fuori produzione) è verde; una corsa reale su `next dev` con `TRUSTED_PROXY_HOPS=1` (il caso più severo: nulla deve essere rifiutato fuori produzione) ha dato 21/21.

### S5.12.4 «La prova può fallire?»

Il controllo sulla sessione piantata ha un riscontro: su **http semplice** (`next dev`, nome debole) lo stesso `mw_sid` valido piantato prima del preventivo **viene adottato** e l'ordine porta l'hash del piantatore (`guest-session-dev.ts`, [3]); su https (`guest-session.ts`, [7]) non succede. In più le mutazioni «il server legge anche `mw_sid` su https» e «vince il nome debole» sono rilevate (S5.12.5).

### S5.12.5 Mutazioni

Come in S5.4: ogni riga è una protezione rotta apposta nel codice nuovo; una mutazione è «rilevata» se almeno una prova fallisce, ed è ripristinata subito (alla fine un controllo di ancore dimostra che nessun file è rimasto mutato). **32 mutazioni nuove su 32 rilevate, tutte alla prima selezione** (prove unitarie e di sicurezza del cookie), **più le 48 di S5 rilanciate con le ancore aggiornate** (le tre che toccavano righe cambiate delle rotte — G12, G24, G26 — sono state riscritte sullo stesso difetto): **48/48 rilevate**. Totale **80 mutazioni sul lato server, 80 rilevate**; nessuna sopravvissuta alla fine.

| # | Cosa si rompe | Prove che falliscono | Prima prova che la rileva |
|---|---|---|---|
| H01 | il cookie si chiama sempre `mw_sid`, anche su https | 11 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| H02 | il cookie si chiama sempre `__Host-mw_sid`, anche su http semplice (il browser lo rifiuta) | 31 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| H03 | su https si legge anche `mw_sid` quando manca il `__Host-` (una sessione piantata viene adottata) | 3 | only the cookie of the connection is read: over https a perfectly valid mw_sid is a planted one and counts for noth… |
| H04 | quando ci sono entrambi i nomi vince quello debole | 3 | only the cookie of the connection is read: over https a perfectly valid mw_sid is a planted one and counts for noth… |
| H05 | il cookie riceve un `Domain` (il browser rifiuta `__Host-` con `Domain`; e arriverebbe a ogni sottodominio) | 5 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| H06 | il cookie non è mai `Secure` | 7 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| H07 | il cookie non vale per tutto il sito (`Path=/api`) | 2 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| H08 | la scrittura del cookie ignora la connessione e scrive sempre il nome debole | 9 | the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https |
| T01 | **in produzione un proxy che dice «http» abbassa il cookie al nome debole** (il ripiego silenzioso che il titolare ha vietato) | 4 | PRODUCTION: always "secure" - no header, forged or not, lowers it (without a proxy of ours the headers are not even… |
| T02 | in produzione `COOKIE_SECURE=false` abbassa il cookie al nome debole | 2 | PRODUCTION ignores COOKIE_SECURE=false for this cookie (it keeps its meaning for the others): not even the operator… |
| T03 | si crede al **primo** valore di `X-Forwarded-Proto` invece di quello scritto dal proprio proxy (il primo lo può scrivere il visitatore) | 6 | a list is read from the END: what a client wrote in front of what the proxy wrote does not count |
| T04 | il veto è ignorato: un proxy che dice «http» non cambia nulla | 3 | PRODUCTION with a proxy of ours: https or no word = secure; "http" at the place of the proxy, or any conflict, = th… |
| T05 | senza proxy dichiarati le intestazioni vengono comunque consultate | 3 | no proxy of ours declared (TRUSTED_PROXY_HOPS 0 or unset): the headers are not read at all |
| T06 | un `X-Forwarded-Proto` enorme viene comunque letto | 1 | headers that are absurdly long or have absurdly many entries are not read as a claim (and open nothing) |
| T07 | due intestazioni in disaccordo si risolvono a favore di https | 3 | two headers that disagree are settled AGAINST the https side: if either says http, the answer is http |
| T08 | fuori produzione il cookie è sempre quello https (lo sviluppo su http perderebbe le sessioni) | 29 | OUTSIDE production nothing is refused and the answer is the one shouldUseSecureCookies() has always given (developm… |
| T09 | fuori produzione un proxy che dice «http» rifiuta anche l'ospite (lo sviluppo cambia) | 1 | OUTSIDE production nothing is refused and the answer is the one shouldUseSecureCookies() has always given (developm… |
| T10 | l'intestazione `Forwarded` non è letta | 4 | the Forwarded header is read the same way (proto=, quoted or not, from the end of the list) |
| T11 | l'intestazione `X-Forwarded-Proto` non è letta | 8 | one proxy: its own word about the protocol, in any spelling; a word nobody understands is no claim |
| Q01 | preventivo: il cookie si legge sempre con il nome debole, qualunque sia la connessione | 1 | https: the quote knows the __Host- session it is shown - nothing new for a young one, a renewal under the same name… |
| Q02 | preventivo: il cookie si consegna sempre con il nome debole | 6 | quote: over https (COOKIE_SECURE) the cookie is __Host-mw_sid - Secure, Path=/, no Domain - and the plain name is n… |
| Q03 | preventivo: su una connessione che il proxy dice http si consegna comunque un cookie | 1 | PRODUCTION with a proxy of ours that says "http": the guest does NOT check out - 503, nothing made, no cookie of an… |
| Q04 | preventivo: il rifiuto non viene contato | 1 | PRODUCTION with a proxy of ours that says "http": the guest does NOT check out - 503, nothing made, no cookie of an… |
| S01 | pagamento: il cookie si legge sempre con il nome debole | 4 | https: the session of the quote pays under its __Host- name; the order is tied to it; the access cookie is Secure;… |
| S02 | pagamento: il 428 consegna la sessione con il nome debole | 2 | https: a perfectly valid mw_sid - the cookie a site that is not ours could plant - is NOT a session: 428, nothing m… |
| S03 | pagamento: il rinnovo di una sessione in uso la consegna con il nome debole | 1 | https: the session of the quote pays under its __Host- name; the order is tied to it; the access cookie is Secure;… |
| S04 | pagamento: il rifiuto non è applicato (l'ospite riceve dal 428 il cookie debole) | 1 | PRODUCTION with a proxy of ours that says "http": the guest does NOT check out - 503, nothing made, no cookie of an… |
| S05 | pagamento: il rifiuto non è applicato e una sessione valida viene ancora letta (un ospite paga su una connessione vietata) | 1 | PRODUCTION with a proxy of ours that says "http": the guest does NOT check out - 503, nothing made, no cookie of an… |
| S06 | pagamento: il rifiuto non viene contato | 1 | PRODUCTION with a proxy of ours that says "http": the guest does NOT check out - 503, nothing made, no cookie of an… |
| S07 | pagamento: anche un cliente con account viene rifiutato su una connessione che il proxy dice http | 1 | PRODUCTION: a customer with an account is not touched by any of it - no guest cookie, no refusal, even behind a pro… |
| P05 | un altro file nomina il cookie `__Host-` (guardia statica) | 1 | another guest's session (even a copy of it) opens no order, and the session itself is only ever read by the two che… |
| P06 | un altro file legge la sessione con la funzione di lettura (guardia statica) | 1 | another guest's session (even a copy of it) opens no order, and the session itself is only ever read by the two che… |

**Cosa ha insegnato il primo giro (e come è stato corretto, non nascosto).** Nel primo giro due mutazioni (T06, Q01) sono state «uccise» solo al secondo livello (l'intera suite) e non dalle prove che avrebbero dovuto vederle: i fallimenti del secondo livello erano **anteriori alla mutazione** (le due prove di produzione di `s2s3-step2.sec.ts`, vedi S5.12.6 n. 1), quindi quelle due mutazioni erano in realtà **sopravvissute** al primo livello. Ho fermato il giro, corretto l'aiutante di prova, aggiunto le due prove mancanti (limiti di lunghezza e di numero di voci provati separatamente; il preventivo che riconosce la sessione `__Host-`) e **rilanciato tutto da capo**: le cifre sopra sono quelle del giro pulito. Le mutazioni dei file dell'interfaccia (S5.4-bis) non sono state ripetute: nessun file dell'interfaccia è cambiato in questa chiusura.

### S5.12.6 Difetti e sorprese trovati durante il lavoro

1. **Le prove che usavano un ospite in modalità produzione** (`s2s3-step2.sec.ts`, due prove delle guardie di produzione) hanno cominciato a ricevere 428 perché l'aiutante di prova mandava `mw_sid`: l'aiutante (`tests/security/_guest.ts`) ora manda lo stesso valore sotto il nome `__Host-mw_sid` quando `NODE_ENV=production` (nessuna asserzione cambiata). L'ho scoperto perché una mutazione «sopravvissuta» al primo livello è stata uccisa al secondo da fallimenti che non c'entravano con essa: il secondo livello ha fatto emergere un errore delle prove, non una mutazione uccisa; da lì ho **rilanciato l'intera suite di sicurezza** (1010/1010) e riscritto i casi.
2. **Due mutazioni sopravvivevano al primo livello** (lettura del nome sbagliato nel preventivo; limite di lunghezza delle intestazioni, nascosto dal limite sul numero di voci): due prove aggiunte (`guest-session.sec.ts`, «the quote knows the __Host- session…»; `guest-cookie-transport.test.ts`, limiti indipendenti).
3. **Le chiamate dirette al server con `X-Forwarded-Proto: https` devono portare un `Origin` https** (altrimenti 403 `INVALID_ORIGIN`): è la regola di origine già esistente, non un difetto; le prove ora mandano l'`Origin` che manderebbe un browser dietro il proxy.
4. **Chromium 141 accetta un cookie `__Host-` anche su `http://127.0.0.1`** (eccezione per l'indirizzo locale), contrariamente alla ricerca fatta in fase di piano (Chrome lo scartava su http locale). Non cambia il disegno: il nome dipende comunque dal protocollo (un indirizzo non locale e gli altri browser lo scartano) e la prova in produzione usa https vero con un proxy di prova.
5. **Osservazioni da riferire, non corrette (fuori ambito):** `shouldUseSecureCookies()` prende il **primo** valore di `X-Forwarded-Proto`/`Forwarded` (quello che un visitatore può scrivere se il proxy accoda); `docker-compose.yml` ha `COOKIE_SECURE=false` come predefinito; `mw_checkout` e `mwv2_token` hanno la stessa debolezza teorica del cookie di sessione prima di questa chiusura.

### S5.12.7 Non provato (resta «da eseguire» in `docs/CHECKLIST-PRELANCIO.md`: 1.38, 1.52, 1.54)

**Safari, iPhone e Android veri** e i browser integrati nelle app (solo Chromium emulato): se un browser scartasse il cookie con prefisso i pagamenti ospite si fermerebbero sul messaggio dei cookie; **il proxy di produzione reale** (sovrascrittura di `X-Forwarded-Proto`, `TRUSTED_PROXY_HOPS` giusto, HSTS, reindirizzamento da http): provato solo un proxy TLS di prova scritto per le prove; **un sottodominio gemello vero** che scrive il cookie (provato solo aggiungendo il cookie al barattolo del browser di prova); Stripe reale; più istanze reali; l'**assenza** di R1 (non dimostrabile, resta NON accettato e bloccante).

### S5.12.8 Come riprodurre

```
npx tsc --noEmit && npm run lint && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=… npm run test:security
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
# i cinque script sul server reale (i primi tre passano da un proxy TLS autofirmato fatto con openssl, tests/real-run/_tls-proxy.ts):
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session.ts        # 114 controlli, 3 formati
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/checkout-return.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts
SEC_TEST_DATABASE_URL=… BUILT=EUR node --import tsx tests/real-run/production-guards.ts
SEC_TEST_DATABASE_URL=… node --import tsx tests/real-run/production-release.ts
# PER ULTIMO (next dev riscrive .next: poi ricostruire):
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=… node --import tsx tests/real-run/guest-session-dev.ts
```

---

# S6a — rimborsi nella decisione, revisione finanziaria, incassi attestati, credito commerciale (quarto punto di arresto, SP1)

## S6a.1 Ambiente e ambito

**Ambito autorizzato:** piano S6 rev. 3.1 approvato in via definitiva (SP0; migrazioni additive M3a `RefundOperation` e M3b `PrintOrder.financialRevision`; adeguamenti minimi ai moduli esistenti; `bank_transfer` attestabile con riferimento obbligatorio) e ripresa «S6a fino a SP1» (pacchetti W1–W9). Ramo `claude/stampa3d-fase1`, base `b464d04` (S5.12). **Non iniziati, per decisione del titolare:** P1 (posizione dei fondi), la parte Stripe di P3 (contestazioni e transazioni di saldo), **P4 (compresa la rimozione di `acknowledgeUnverified`)**, **P5** (rimborso governato come operazione), S6b (interfaccia di `payment-hold`), S7, S8, Passo 5; `lib/privacy.ts` non toccato (AP-PRIV) e nessuna procedura di sblocco di `unresolved` (AP-ESC). Nessuna nuova dipendenza; nessuna modifica a prezzi, IVA, spedizione, sconti, carrello, sessioni ospite (`git diff` sul perimetro: nessuna modifica a `package.json`/lockfile, motore dei prezzi, `lib/checkout-orders.ts`, `lib/guest-session.ts`, `lib/privacy.ts`; nessun file di P1/P4/P5; la rotta di rimborso e `acknowledgeUnverified` invariati).

**Ambiente.** PostgreSQL 16 locale (cluster isolato `mkwtest`, porta 55432, database `*_sectest`), Stripe simulato (SDK vero con rete finta e il finto di `tests/security/_fake-checkout.ts`), PrintLab e StockWorks finti come server HTTP locali, Chromium con emulazione. **La macchina si era riavviata durante il lavoro**: ho riavviato **solo** il cluster isolato `mkwtest` (`pg_ctlcluster 16 mkwtest start`); nessun altro servizio. I database di prova che ho creato (`mkw_sectest`, `mkw_base_sectest`, `mkw_mig_{src,restore,compat,empty,shadow,archive}_sectest`, `mkw_compat_sectest`) **restano in posto** (nessuno è stato cancellato).

**Nessuna chiamata a servizi reali.** In questo ambiente non c'è alcuna variabile `STRIPE_*` (né di PayPal, PrintLab o StockWorks) e l'unico file `.env*` è `.env.example`; le chiavi che compaiono nel codice di prova sono segnaposto evidenti. Lo script di verifica in Test Mode è stato **solo scritto e provato offline** (con la rete bloccata): **nessuna chiamata a Stripe, nemmeno in Test Mode, è mai stata fatta**.

## S6a.2 Risultati (confronto con `b464d04`)

| Verifica | Mezzo | Dopo S6a | Base `b464d04` |
|---|---|---|---|
| Tipi (`tsc --noEmit`) / `eslint` / `next build` | locale | **0 errori / 0 avvisi / OK** | 0 / 0 / OK |
| `npm test` | `node --test` | **594/596** — gli stessi **2 fallimenti preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); **+109 prove** | 485/487 (2 preesistenti) |
| `npm run test:api` / `test:contracts` | `node --test` | **7/7 / 14/14** | 7/7 / 14/14 |
| `npm run test:security` (serie, un giro) | `node --test --test-concurrency=1` | **1311/1311** (+301) | 1010/1010 |
| Due processi reali | `payment-sync-multiprocess` / `guest-session-multiprocess` | **5/5 e 7/7, ripetute 4 volte** | 5/5 e 7/7 ×4 |
| Server reale `production-release.ts` (S4; PrintLab/StockWorks finti) | `next start` produzione + Chromium emulato | **68/68** (invariato) | 68/68 |
| Server reale `checkout-return.ts` | idem | **86 passati, 0 falliti** | 86/0 |
| Server reale `checkout-matrix.ts` (`STRICT_CART=1`) | idem | **88 esecuzioni, 0 differenze** (nessun totale cambiato) | 88/0 |
| Server reale `production-guards.ts` (`BUILT=EUR`) | idem | **8/8** (vedi nota) | 8/8 |
| Server reale `guest-session.ts` | idem + proxy TLS di prova | **114 passati, 0 falliti** | 114/0 |
| Intera suite nel browser (`npx playwright test`, 3 formati) | Playwright | **289 passati, 3 saltati, 0 falliti** (secondo giro; il primo: 288 passati e 1 fallito, vedi S6a.8 n. 7) | 271 passati, 3 saltati |
| Mutazioni sul codice nuovo | script fuori dal repository | **72/72 vere rilevate** (+ 2 controlli) | — |
| Prove rosse su `HEAD` | 3 file | **29/29 falliscono su `HEAD`**, verdi ora | — |
| Vecchio codice (`b464d04`) sullo schema migrato | suite di sicurezza e due processi del vecchio codice | **1010/1010** (sicurezza) e **5/5** (`payment-sync-multiprocess`) | — |
| Dipendenze / motore dei prezzi / `lib/checkout-orders.ts` / `lib/guest-session.ts` / `lib/privacy.ts` / rotta di rimborso | `git diff` | **nessuna modifica** | — |

*Nota su `production-guards.ts`.* Il primo giro è uscito con 8 esecuzioni su 8 «non come previsto» (`CHECKOUT_DISABLED`): non era una regressione ma un **server di prova rimasto acceso** dalla mia esecuzione del browser precedente (porta 3098, avviato senza `HOSTED_CHECKOUT_ENABLED`), che rispondeva al posto di quello avviato dallo script. Ho fermato il server e rilanciato: 8/8. Da allora i miei script di esecuzione del browser fermano davvero il server (gruppo di processi). **Prove nuove di S6a, per file** (tutte verdi): unitarie `financial-revision` 40 · `s6-release-policy` 19 · `s6-hygiene` 5 · `production-release-facts-oracle` 4 · `production-release-guards` 16 · `production-release` 52 · `stripe-test-mode-verify` 35 (41 dopo la correzione di SP1, v. S6a.13; 83 dopo la seconda verifica, v. S6a.14; 117 dopo la chiusura della garanzia di arresto, v. S6a.15); di sicurezza `s6-money-gaps` 10 · `s6-attested-receipts` 15 · `s6-refund-block` 12 · `s6-revision-events` 37 · `s6-schema` 6 · `s6-legacy-rows` 10, più la matrice di rilascio con **13 nuove voci** (un ingresso per ogni stato di operazione di rimborso, con e senza `appliedAt`) e la parità del prefiltro.

## S6a.3 Prove rosse su `HEAD` (le prove dei difetti falliscono dove il difetto esiste)

Scritte **per prime**, eseguite sul codice di `b464d04` (estratto in una cartella separata, con il suo database): **29 prove su 29 falliscono su `HEAD`** e ora passano.

| File | Prove | Su `HEAD` | Che cosa dimostrano (difetto) |
|---|---|---|---|
| `tests/security/s6-money-gaps.sec.ts` | 10 | **10 falliscono** | rimborso parziale e totale del pagamento dell'ordine non fermano la produzione (F04); un rimborso fallito non restituisce il rilascio (M23); un'autorizzazione sopravvive a un rimborso e a una modifica del totale (F25, M63, M65); un pagamento duplicato sovrascrive i dati dell'ordine (F05, M13, M15); un tentativo `processing` su un ordine pagato non si chiude (F13, M43); autorizzazione e ordine a totale 0 senza motivo (F08, M28, M34) |
| `tests/security/s6-attested-receipts.sec.ts` | 14 | **14 falliscono** | un job `invoice`/`po` marcato «pagato» da una parola (F09, M68); PayPal «registrato a mano» (M32); l'incasso su un ordine già creato scartato in silenzio (M31/M72); registrazioni senza `receivedVia`/importo valide come prova (M73); nessun credito commerciale (M69–M74); `paymentIntentId` scelto dal browser agganciato all'ordine (F21, M45–M46); `updateOrderMetadata` che accetta qualunque colonna (F22, M48) |
| `tests/s6-hygiene.test.ts` | 5 | **5 falliscono** | ricevuta di pagamento per un ordine non pagato e «Amount after refunds» (F23, M47); notifica «Payment received» per un pagamento non verificato (F24, M49); ripiego `'paid'` del checkout vecchio (F15) |

Registro dei fallimenti conservato fuori dal repository. **Nota:** la prova rossa dimostra che il difetto esiste su `HEAD`; non prova che la correzione sia completa (per questo ci sono la matrice, le guardie e le mutazioni).

## S6a.4 Migrazioni M3a e M3b — verifica su database isolati

Eseguita con uno script fuori dal repository sul cluster locale isolato; **nessun database reale**. Dettagli e procedura di ripristino: `docs/RILASCIO-PRODUZIONE.md` §16.

| Verifica | Esito |
|---|---|
| Impronta (righe e somma di controllo per tabella) di un database nello schema di S5 con dati (94 migrazioni; 45 tabelle) | registrata |
| Backup `pg_dump -Fc` e somma SHA-256 del file | fatto (137.870 byte) |
| **Ripristino su una copia** (`mkw_mig_restore_sectest`) e confronto con la sorgente | **identico**: stesse righe e stessa somma di controllo in ogni tabella |
| `prisma migrate status` sulla copia: il codice di S5 la vede aggiornata; le due nuove migrazioni risultano in attesa | confermato |
| `prisma migrate deploy` sulla copia (M3a + M3b) | applicate; 96 migrazioni |
| Dati preesistenti dopo la migrazione | **invariati** in ogni tabella (`PrintOrder` confrontata senza la colonna nuova); 28 ordini con `financialRevision = 0`; `RefundOperation` vuota |
| Deriva Prisma (copia migrata contro lo schema; cartella delle migrazioni contro lo schema su un database ombra) | **nessuna differenza** (due controlli) |
| Vincoli SQL (ognuno in una transazione annullata, 13 casi) | **13/13 come previsto**: il CHECK rifiuta `abandoned` con `firstSentAt` (inserimento **e** aggiornamento) e accetta `abandoned` senza; la chiave esterna rifiuta un ordine inesistente e **la cancellazione di un ordine con operazioni** (`ON DELETE RESTRICT`); chiave primaria; `stripeRefundId` univoco con più `NULL` ammessi; cancellare un ordine senza operazioni funziona; `financialRevision` ha default 0 ed è `NOT NULL` |
| Catena completa da zero su un database vuoto e seconda esecuzione | 96 migrazioni applicate; **idempotente**; il vincolo CHECK è presente |
| Interrogazione di guardia del rollback (`docs/RILASCIO-PRODUZIONE.md` §16) su una riga per ogni stato × `appliedAt` più uno stato sconosciuto | restituisce **esattamente** le 11 operazioni che bloccano (le 4 non bloccanti sono escluse); transazione annullata, 0 righe rimaste |
| `tests/security/s6-schema.sec.ts` (CHECK, chiave esterna, unicità, default) | **6/6** |
| **Codice precedente (`b464d04`) sullo schema migrato** (scenario di rollback applicativo): suite di sicurezza e prova a due processi del vecchio codice contro un database costruito da zero con le 96 migrazioni | **1010/1010** prove di sicurezza del vecchio codice e **5/5** della prova a due processi, su un database costruito da zero con le 96 migrazioni (tabella `RefundOperation` con 28 colonne e colonna `financialRevision` presenti): il vecchio codice funziona sullo schema nuovo (le strutture additive sono inerti per lui) |

## S6a.5 Il nuovo codice sui dati che esistevano prima di S6

Confronto di **sola lettura** (script fuori dal repository) tra la decisione di S5 (`b464d04`) e quella nuova, su **tutti i 28 ordini** della copia migrata dallo schema di S5. Il codice nuovo può solo **restringere**: nessun ordine che la regola vecchia teneva fermo viene ora rilasciato.

| Decisione S5 → S6a | Ordini |
|---|---|
| rilasciato → rilasciato (pagamento Stripe verificato) | 6 |
| rilasciato → `payment_pending` (autorizzazione **senza revisione**: `no_revision`; autorizzabile di nuovo) | 2 |
| rilasciato → `payment_refunded` (ordine rimborsato prima di S6) | 1 |
| rilasciato → `payment_unproven` (pagamento «registrato» senza `receivedVia`/importo) | 3 |
| invariati (non rilasciati prima e dopo) | 16 (`external_review` 1, `payment_hold` 4, `payment_pending` 7, `payment_processing` 2, `payment_unproven` 2) |
| **non rilasciati prima e rilasciati ora** | **0** |

Le stesse forme sono provate sulle rotte vere in `tests/security/s6-legacy-rows.sec.ts` (L1–L7), compreso che un ordine rilasciato per un pagamento Stripe verificato **resta rilasciato** e che ogni caso ha una via d'uscita (nuova autorizzazione con motivo, oppure incasso registrato come previsto).

## S6a.6 Mutazioni

Script fuori dal repository: una **copia** del sorgente, **una mutazione per volta**, il sottoinsieme mirato di prove che deve rilevarla (gruppi: unitarie, guardie, revisione per evento/scrittore, rimborso, incassi, matrice di rilascio, parità, script di verifica); l'albero vero non viene mai toccato. Inclusi **due controlli**: una modifica che non cambia nulla (`CONTROL-noop`) **deve sopravvivere** (e sopravvive), e una che rompe di proposito il rilascio per pagamento verificato (`CONTROL-break`) **deve essere rilevata** (lo è).

| Gruppo | Mutazioni | Rilevate | Che cosa si rompe (esempi) |
|---|---|---|---|
| P2c — blocco durante il rimborso | 14 | **14** | regola assente da `releaseDecision` e dal prefiltro; `unknown`/`pending`/`requested` che non bloccano; stato sconosciuto che lascia passare; un esito terminale che sblocca prima di `appliedAt`; un'autorizzazione che scavalca il blocco; guardia di `payment-hold` assente (prima di Stripe e sotto il blocco); motivo `refund_operation` assente; lettura sotto blocco, pagina di produzione e consumo di materiale che dimenticano le operazioni |
| P2b — revisione finanziaria | 28 | **28** | autorizzazione sempre valida; autorizzazione senza revisione valida; concessione che registra 0; **un incremento tolto per ciascuno scrittore** (sincronizzazione, risoluzione di blocco, pagina di pagamento, incasso attestato, aiutante dei metadati, rotta di stato, rotta delle righe, `stripe-attach`, approvazione di organizzazione, e gli otto scrittori che devono solo restare nell'elenco delle esenzioni, rilevati dalla guardia G11); revisione assegnata invece che incrementata; incremento sempre/mai; un tentativo (E12), una pagina scaduta (N3) o la concessione (N10) trattati nel modo sbagliato; il totale o la cancellazione che non sono eventi; oracolo cieco |
| P6 — incassi, credito, igiene | 14 | **14** | `invoice`/`po` marcato `paid`; `paypal` attestabile; credito che imposta `paid` o con il dovuto sbagliato; autorizzazione senza motivo; tipi di autorizzazione intercambiabili; ricevuta che copre qualunque importo; riferimento del bonifico facoltativo; **ricevuta già registrata sovrascritta**; ripiego `'paid'` del checkout vecchio; id di pagamento scelto dal browser; `updateOrderMetadata` su qualunque colonna; ricevuta per un ordine non pagato; notifica «Payment received» sempre |
| P3 — parti senza Stripe | 2 | **2** | un pagamento duplicato sovrascrive i dati dell'ordine (F05); un tentativo `processing` su un ordine pagato resta aperto (F13) |
| Script di Test Mode (offline) | 14 | **14** | chiave live accettata o forma qualunque accettata; oggetto `livemode` non fermante; esito di pulizia non registrato; **ripetizioni automatiche attive**; tetto di chiamate o di denaro disattivato; **chiave non oscurata**; **rapporto non controllato prima della scrittura**; rapporto leggibile da tutti o dentro il repository; `--dry-run` che apre un client; il `YES` non chiesto; PaymentIntent non pagato mai annullato |
| Controlli | 2 | 1 + 1 | `CONTROL-noop` **sopravvive come deve**; `CONTROL-break` rilevata |
| **Totale** | **74** (72 vere + 2 di controllo) | **72/72 vere rilevate** | nessuna sopravvissuta alla fine |

**Come è andato il primo giro (non nascosto).** Su 72 mutazioni vere, 67 sono state rilevate al primo giro e **5 no**, e ho corretto le **prove**, non le mutazioni:

1. `P2c-stock-forgets` (il consumo di materiale non carica le operazioni di rimborso) **sopravviveva**: il blocco sotto il lucchetto rifiutava comunque, ma solo **dopo** aver letto l'inventario di StockWorks. Aggiunta l'asserzione che un ordine non rilasciato non genera **nessuna** richiesta a StockWorks, nemmeno di lettura (`production-release.sec.ts`, in ogni voce della matrice).
2. `P6-receipt-overwritten` **sopravviveva**: nessuna prova diceva che un incasso già registrato non si sovrascrive. Aggiunta `M31d` (409 `RECEIPT_ALREADY_REGISTERED`, ordine, record, audit e job identici).
3. `V-key-not-redacted` e `V-report-not-checked` **sopravvivevano**: la protezione a due livelli dello script nascondeva la rimozione di uno dei due. Aggiunte una prova diretta di `redact` (anche per una chiave di forma qualunque) e una prova che l'**ultimo controllo di `main()`** ferma la scrittura di un rapporto con un dato simile a un segreto (esito 1, nessun file).
4. `V-retries-on` **non si applicava** (l'ancora compariva due volte: commento e codice): ancora corretta; ora rilevata.
5. Due mutazioni dello script (`V-any-key-shape-accepted`, `V-report-inside-repo-allowed`) erano «rilevate» solo da un **blocco** (la prova aspettava la tastiera, 360 s) e non da un'asserzione: ora la domanda `YES` nelle prove di rifiuto **fallisce subito** se viene posta, e le due vengono rilevate in 1 secondo.

Dopo le correzioni le 7 mutazioni interessate sono state rilanciate su una copia fresca: **7/7 rilevate**.

## S6a.7 Test esistenti modificati (dichiarati; nessuna asserzione di sicurezza allentata)

| File | Che cosa e perché |
|---|---|
| `tests/security/reprint.sec.ts` | la ristampa gratuita senza motivo ora risponde **400 `REASON_REQUIRED`** (era 409 `AUTHORIZATION_REASON_REQUIRED`: la regola vale per **ogni** autorizzazione); la prova «il motivo è solo per le ristampe» è stata **riscritta** nel suo contrario (senza motivo 400, con motivo 200) |
| `tests/security/admin-order-routes.sec.ts` | l'ordine a totale 0 senza motivo ora è rifiutato (400 `REASON_REQUIRED`, nessun audit); i pagamenti manuali portano `receivedVia` |
| `tests/order-receipts.test.ts` | un ordine in contanti **non pagato** non produce più una «Cash Pickup Receipt» ma una «Order Confirmation - Payment Pending»; `netPaidCents` di un ordine non pagato è 0 (F23) |
| `tests/security/s5-payment-methods.sec.ts`, `public-checkout-payment-methods.sec.ts`, `s2s3-step2.sec.ts` | solo i nuovi campi **obbligatori** dei fatti (`refundedCents`, `financialRevision`, `refundOperations`, valuta, metodo) e un'autorizzazione di prova nella forma valida (con tipo e revisione) |
| `tests/security/_harness.ts` | la pulizia tra una prova e l'altra cancella anche `RefundOperation` (chiave esterna `RESTRICT`) |
| `tests/security/_release-fixtures.ts`, `production-release-parity.sec.ts`, `production-release.sec.ts`, `tests/production-release.test.ts`, `tests/production-release-guards.test.ts` | **estesi**: 13 nuove voci della matrice (un ingresso per ogni stato di operazione di rimborso, con e senza `appliedAt`, e 3 stati che tolgono il blocco), parità del prefiltro, guardie G11/G12/G1-create, e l'asserzione «nessuna richiesta a StockWorks» |

## S6a.8 Difetti e sorprese trovati durante il lavoro

1. **Un vero buco del contatore (E12).** La guardia sugli scrittori di tentativi di pagamento ha scoperto che `reopenAttempt` (il cliente che torna su una pagina già completata presso il fornitore) spostava il tentativo da `open` a `processing` **senza** incrementare la revisione: un'autorizzazione concessa prima sarebbe rimasta valida. Corretto con `markPageCompleteAtProvider` (una transazione: blocco di riga, spostamento del tentativo, incremento) e coperto da una prova per evento.
2. **L'oracolo e lo spread.** Nella concessione di un'autorizzazione il codice copia i metadati con uno spread, che su un `Proxy` legge ogni chiave: per l'oracolo la concessione riceve una copia semplice dei metadati (correzione della prova, non del codice).
3. **Un incasso `invoice`/`po` in forma nuova È una ricevuta valida** (M72: fattura saldata in contanti o con bonifico, con importo): la prova L4 è stata divisa in «forma vecchia» (non vale) e «forma nuova» (vale).
4. **Il messaggio di Prisma** per una colonna `NOT NULL` non contiene «null value»: la prova ora riconosce il codice `23502`.
5. **Prove che aspettavano la tastiera** (script di verifica, v. S6a.6 n. 5) e un'ancora di mutazione ambigua (S6a.6 n. 4).
6. **Il seed del browser non era ripetibile.** `tests/e2e/seed-production-release.ts` cancellava gli ordini senza cancellare prima le operazioni di rimborso che crea lui stesso: alla seconda esecuzione la chiave esterna `RESTRICT` lo faceva fallire. Corretto (cancella prima le operazioni del cliente di prova); l'ho scoperto rilanciando il browser.
7. **Playwright, primo giro completo: 1 fallimento transitorio.** `journey-guards.responsive.spec.ts` (chromium, il primo test del giro): errore della console «Failed to load model … TypeError: Failed to fetch» dal visualizzatore 3D, cioè la richiesta del file del modello (`/files/…/e2e-shop-model.stl`) è fallita a livello di rete; le asserzioni sugli errori della pagina e sulle risposte 5xx del sito, che nel test precedono quella fallita, erano passate. Lo stesso spec ripetuto 3 volte su ciascuno dei 3 formati: **9/9**; secondo giro dell'intera suite: **289 passati, 0 falliti**. È la stessa classe di errore già registrata in S5.2 (un primo giro con un errore transitorio del visualizzatore 3D, non ripetuto); nessun file toccato da S6a riguarda modelli o file. **La causa esatta non è stata isolata**: la dichiaro transitoria perché non si è ripetuta in 12 esecuzioni successive del test (4 in chromium), non perché ne abbia la dimostrazione.
8. **Osservazione sulla rete del browser di prova.** Il proxy di uscita dell'ambiente ha **rifiutato** alcuni tentativi di connessione del browser emulato verso `checkout.stripe.com` (e verso host dei servizi di Chromium) durante la ripetizione del test del percorso ospite, che sostituisce quella pagina con una pagina finta ma lascia che il browser provi ad aprire la connessione. Nessuna connessione è stata stabilita e non è partita alcuna richiesta con dati o credenziali (non c'è alcuna chiave di Stripe in questo ambiente); lo segnalo per completezza.

## S6a.9 Differenze rispetto al piano approvato

- **`REFUND_IN_PROGRESS` per righe e totale:** il piano diceva che modifica di righe/totale e cancellazione sono rifiutate con `REFUND_IN_PROGRESS`; in S6a rispondono `ORDER_HAS_PAYMENT_EVIDENCE` con il motivo `refund_operation` (la protezione già esistente, estesa), che impedisce anche la cancellazione che prima falliva con un errore 500 della sola chiave esterna. `REFUND_IN_PROGRESS` resta per `payment-hold`, autorizzazioni, credito e approvazione.
- **`payment-hold` e l'evento di rifiuto:** la guardia `REFUND_IN_PROGRESS` c'è (prima di Stripe e sotto il blocco) ma **non scrive ancora l'evento di rifiuto in audit**: la tassonomia decisione / verifica / rifiuto è di P4, trattenuto.
- **M85, M88, M89, M112** (reclamo con 0 chiamate a Stripe, due processi sul reclamo, rimborso di un duplicato su un ordine in blocco, riavvio in tre punti) **non sono eseguibili senza il protocollo di P5**: il comportamento del blocco è provato con righe scritte dalle prove, in particolare R8 e R9 (un reclamo che arriva mentre un effetto tiene il blocco attende l'effetto; dopo il commit ogni effetto è rifiutato).
- **Mutazioni:** 74 (72 vere), più delle 45–50 previste, perché ogni scrittore e ogni evento ha la sua.

## S6a.10 Rischi residui e limiti noti (non risolti, nessuno nascosto)

Elenco completo in `docs/RILASCIO-PRODUZIONE.md` §15.10. In sintesi: **F01 `acknowledgeUnverified` ancora presente (bloccante per il lancio)**; **R1 non accettato e bloccante**; il rimborso dall'app non è governato (P5) e nessun codice crea ancora le operazioni di rimborso; contestazioni e posizione dei fondi invariate (P1, P3-Stripe, P4); nessuna riconciliazione né notifica (Passo 5); `payment-hold` senza evento di rifiuto per `REFUND_IN_PROGRESS`; `scripts/hold-unpaid-orders.js` non allineato (F16); privacy invariata (R-S6-10); M85/M88/M89/M112 non provati.

## S6a.11 Non provato (resta «da eseguire» in `docs/CHECKLIST-PRELANCIO.md`: 1.43, 1.44, 1.49, 1.60–1.67)

**Tutti i fatti di Stripe T1–T18** (provati solo con un Stripe finto: **simulati, non verificati**); Stripe reale anche in Test Mode; PayPal; PrintLab e StockWorks reali; stampanti; **iPhone con Safari e Android veri** (solo Chromium emulato); un operatore reale che usi il modulo di incasso attestato, il credito commerciale e l'autorizzazione con revisione; le migrazioni su un **database reale** (solo database di prova); l'**assenza** di R1; nessuna riga della checklist è passata a «superata».

## S6a.12 Come riprodurre

```
npx tsc --noEmit && npm run lint && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security      # un giro per volta
node --test --test-concurrency=1 --import tsx tests/security/payment-sync-multiprocess.sec.ts tests/security/guest-session-multiprocess.sec.ts   # x4
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
# server reale su dati fittizi (stessi comandi di S5.12.8): production-release.ts, checkout-return.ts, checkout-matrix.ts (STRICT_CART=1), production-guards.ts (BUILT=EUR), guest-session.ts
# browser: seed-customer-orders.ts + seed-production-release.ts, next start, npx playwright test (3 formati)
# script di verifica di Stripe: SOLO offline qui (tests/stripe-test-mode-verify.test.ts); il titolare lo esegue seguendo docs/STRIPE-TEST-MODE-S6.md
```

## S6a.13 Correzione dopo la revisione di SP1 (script di verifica di Stripe: T17, simulatore, T16, T8)

**Perché.** Il titolare ha esaminato il commit `5391305` e, **prima di autorizzare l'esecuzione reale** dello script in Test Mode, ha chiesto di correggere **solo** quattro difetti dello script `scripts/stripe-test-mode-verify.ts` e del suo Stripe finto: un errore dello script avrebbe sprecato l'unica esecuzione reale o, peggio, dato una conferma che non c'era. **Perimetro rispettato:** nessuna modifica a `app/`, `lib/`, `prisma/`, `components/`, `package.json`; nessuna API applicativa, pagamento, migrazione, database o configurazione Vercel toccati; nessun lavoro su P1, P3-Stripe, P4, P5, S6b; **nessuna chiamata a Stripe, nemmeno in Test Mode**, nessuna chiave. File modificati: lo script, il suo test, `docs/STRIPE-TEST-MODE-S6.md`, questo capitolo e una frase della riga 1.44 di `docs/CHECKLIST-PRELANCIO.md`.

| # | Difetto (verificato leggendo il codice) | Correzione |
|---|---|---|
| 1 | **T17** ripeteva il primo rimborso (quello di T4) con la **stessa chiave di idempotenza** ma con `metadata.step` cambiato da `T4` a `T17`. Con Stripe vero una chiave riusata con parametri diversi dà `idempotency_error` (comportamento documentato, **non osservato qui**: è ciò che T5 verifica con un importo diverso): la chiamata avrebbe lanciato, la sezione dei rimborsi si sarebbe interrotta a metà e **T3, T4, T5, T15 e T17 sarebbero diventati tutti `not_confirmable`** | La richiesta di T4 si costruisce **una volta sola** (`refundRequest` → `{ params, options }`) e T17 la rinvia **identica** (lo stesso oggetto, tre volte). «T17» resta solo l'identificativo del risultato. Stesso schema per T5: l'unica richiesta che a parità di chiave differisce, di proposito, è quella con importo 11, che **deve** essere rifiutata. Il numero di chiamate di creazione di rimborso è identico a prima (ogni `refundOf` è diventato un `sendRefund`, uno per uno): il tetto di 12 non cambia |
| 2 | Il **Stripe finto** confrontava, quando una chiave tornava, solo pagamento e importo (`JSON.stringify({ pi, amount })`): `reason` e `metadata` erano invisibili, perciò il difetto 1 non si vedeva (35/35 verdi) | L'impronta è ora **tutta la richiesta** (JSON canonico, chiavi ordinate in profondità): qualunque differenza (importo, `reason`, `metadata` anche di una sola chiave, pagamento, parametro in più) dà `idempotency_error`; le stesse richieste con le chiavi in un altro ordine sono accettate. Il finto tiene un **registro delle richieste** (chiave, parametri, esito) e un test di regressione intercetta il difetto originale di T17 |
| 3 | **T16** era `ok(...)` **incondizionato**: «confermato» anche se il rimborso era riuscito subito (mai in attesa, mai fallito). Stati e importi erano due elenchi separati, mai legati allo stesso istante, e un test esistente **asseriva** il difetto | Ogni giro legge **prima l'importo** e **poi lo stato del rimborso**; il campione si usa solo se lo stato letto prima e dopo l'importo è lo stesso. `confirmed` solo se si sono visti un rimborso in attesa (`pending` o `requires_action`) **e** uno fallito o annullato, ciascuno con il proprio importo; altrimenti `not_confirmable`, con la metà osservata (`missing`, `amountWhilePending`, `amountAfterFailure`, `wentBackDown`). Mai `contradicted` (è una misura). Le chiamate per giro sono le stesse (una al rimborso, una al pagamento) |
| 4 | **T8**: `confirmed` dipendeva solo dai **fondi** (esiti, ritiro, reintegro); gli eventi stavano in `observed` ma non nel verdetto, benché titolo e ipotesi li citino; gli eventi delle due contestazioni erano fusi in un solo insieme (l'evento di una poteva «coprire» quello mancante dell'altra) e, se `events.list` falliva, si ripiegava su `[]` lasciando T8 `confirmed` | Eventi attribuiti **per contestazione** (persa: `closed` e `funds_withdrawn`; vinta: `closed` e `funds_reinstated`). Il fatto ha quattro **parti** (`outcomes`, `withdrawal_on_lost`, `reinstatement_on_won`, `events`) e lo stato della **parte peggiore** (`contradicted` > `not_confirmable` > `confirmed`). Fondi giusti ma eventi non visti — anche con `events.list` illeggibile — ⇒ `not_confirmable`, con la nota «Confermato: … NON confermato: …». Una sola lettura degli eventi (nessuna chiamata in più); un'assenza è «non osservato», mai una contraddizione |

Regola comune: `FactResult` guadagna `parts` (solo T8 e T16) e lo stato di un fatto con parti è quello della parte peggiore, perciò un fatto è `confirmed` **solo se tutto ciò che il suo titolo afferma è stato osservato**.

### Prove rosso → verde

| Passo | Che cosa girava | Esito |
|---|---|---|
| 0 · **Prima** | Stripe finto vecchio + script di `5391305` + le 35 prove vecchie (copia fuori dal repository) | **35/35 verdi**: i difetti erano invisibili |
| 1 · **Rosso** | 41 prove (35 + 6 nuove, una rovesciata) con il Stripe finto severo + script **ancora com'era** in `5391305` | **33 passano, 8 falliscono**, per i motivi attesi. La ripetizione di T17 porta `metadata.step "T17"`: il finto severo la rifiuta, `refundFacts` si interrompe e **T3, T4, T5, T15 e T17 diventano `not_confirmable`** (fallisce l'intera esecuzione, e le prove di T4/T15 e di T5); il registro delle richieste mostra **2** richieste che riusano una chiave con parametri diversi (la ripetizione di T17 e quella voluta di T5), attesa **1**; nessun fatto ha `parts`; T8 `confirmed` dai soli fondi; T16 `confirmed` per un rimborso riuscito subito (la prova di T14/T16, che ho **rovesciato** perché prima asseriva proprio il difetto, e la tabella di T16) |
| 2 · **Verde** | le stesse 41 prove + lo script corretto | **41/41** |
| 3 · **Secondo rosso** (finto cieco) | le 41 prove + Stripe finto con la **vecchia impronta** (solo pagamento e importo) + script di `5391305` | **35 passano, 6 falliscono**: la prova di severità del finto; **la regressione di T17** (legge il registro, quindi vede la ripetizione con parametri diversi anche se il finto non la rifiuta); l'invariante delle parti; T8; T14/T16; T16 |

Le 6 prove nuove: severità del finto · regressione di T17 · tabella di T16 (9 scenari, compreso lo stato che cambia mentre si legge l'importo) · tabella di T8 (7 scenari, compresi gli eventi di una sola contestazione, l'errore di permesso su `events.list` e il reintegro assente ⇒ `contradicted`) · invariante «ogni fatto con parti vale quanto la sua parte peggiore» · caso peggiore di chiamate (un rimborso che resta in attesa per tutta la finestra: l'esecuzione si chiude da sola entro il massimo di 170, senza tagliare nessun fatto).

### Mutazioni (sulla copia, una per volta, tutte da rilevare)

**27 mutazioni, 27 rilevate, 0 sopravvissute**: le 14 `V-*` già esistenti dello script e **13 nuove** — T17 che cambia di nuovo i parametri · T5 che ripete con parametri diversi · il finto cieco ai `metadata` · T16 sempre `confirmed` · T16 che non richiede il momento «in attesa» · T16 che non richiede il momento «fallito o annullato» · T16 che usa campioni instabili · il ciclo di T16 che si ferma alla prima lettura · T8 che ignora gli eventi · T8 con gli eventi delle due contestazioni fusi · T8 con eventi illeggibili ritenuti validi · T8 con fondi diversi dal previsto non contraddetti · lo stato dei fatti con parti che ignora `not_confirmable`.

### Regressione e perimetro

| Verifica | Esito |
|---|---|
| `tests/stripe-test-mode-verify.test.ts` | **41/41** |
| `npx tsc --noEmit` / `npm run lint` | 0 errori / 0 avvisi |
| `npm test` | **602 prove, 600 passano, 2 falliscono: gli stessi 2 preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); +6 prove rispetto a S6a.2 |
| `tests/production-release-guards.test.ts` (guardie sul sorgente) | 16/16 |
| Tutto il file di prova con lo strato di rete **rifiutato** (un modulo caricato con `--require` che rifiuta e registra ogni tentativo `net`/`tls`/`dns`/`fetch`/`http(s)`) | **41/41 con 0 tentativi di rete**; controllo negativo: lo stesso strato rifiuta e registra 3 tentativi verso un host inesistente (`fetch`, `https.get`, `net.connect`), quindi sa vedere |
| `git diff` | solo i 5 file elencati sopra; nessun file di `app/`, `lib/`, `prisma/`, `components/`, nessun `package.json` |

**Nessuna chiamata a Stripe.** L'ambiente non ha alcuna variabile `STRIPE_*`; il client vero (`createRealClient`) è raggiungibile solo da `main()` quando **non** è stato iniettato un client, e ogni prova ne inietta uno finto o blocca la rete (0 tentativi, v. sopra).

**Non provato.** Che cosa faccia Stripe vero con una chiave riusata con parametri diversi, se `events.list` mostri gli eventi attesi e se il Test Mode produca rimborsi `pending` o `failed`: restano **ipotesi** fino all'esecuzione del titolare; l'`idempotency_error` del finto è il comportamento **documentato**, non osservato. Nessuna riga della checklist è passata a «superata» e 1.44 resta **Bloccante**. **Lo script non è stato eseguito e non lo sarà senza una nuova autorizzazione esplicita.**

## S6a.14 Seconda verifica di SP1 (T5, T2, T14 e gli stop dello script)

**Perché.** Il titolare ha verificato `9367b7f` (le quattro correzioni risultano corrette) e, prima del collaudo Stripe, ha chiesto di correggere altre due imprecisioni del valutatore (T5 e T14); poi ha esteso l'incarico a due difetti dello stesso tipo che avevo segnalato come fuori perimetro (T2 e la parte «richieste simultanee» di T5). Un solo principio: **una conferma — o una contraddizione — deve venire da ciò che è stato effettivamente osservato, non da un errore qualunque né dall'assenza di una risposta.** Perimetro rispettato: solo `scripts/stripe-test-mode-verify.ts`, il suo test e la documentazione pertinente; nessuna modifica a `app/`, `lib/`, `prisma/`, `components/`, `package.json`, a API applicative, pagamenti, database, migrazioni o Vercel; nessuna nuova dipendenza; `BUDGET` e numero di chiamate invariati; **nessuna chiamata a Stripe, nemmeno in Test Mode**; tutti i controlli e le correzioni di `9367b7f` restano (tutte le sue prove passano, salvo i due adeguamenti dichiarati più sotto).

| # | Difetto (verificato leggendo il codice e l'SDK installato) | Correzione |
|---|---|---|
| 1 | **T5 · rifiuto.** La richiesta «stessa chiave, altro importo» era giudicata da `Boolean(mismatch)`: **qualunque** errore (un 500, una connessione caduta, un timeout, un 429, un 403, il conflitto «chiave in uso», perfino uno stop dello script) la contava come rifiuto ⇒ T5 `confirmed` | `isIdempotencyMismatch`: vale solo l'errore di idempotenza di Stripe (nell'SDK installato, stripe 19.3.1: classe `StripeIdempotencyError`, `rawType === 'idempotency_error'`, **`code` non valorizzato**). Il classificatore non guarda `code`: il Stripe finto lo riempiva (forma diversa da quella dell'SDK) e un controllo sul codice non avrebbe mai confermato nulla nella prova reale. Ogni altro errore ⇒ la parte «rifiuto» è `not_confirmable`; nessun errore ⇒ `contradicted` come prima |
| 2 | **T5 · richieste simultanee.** Il verdetto era `withC === 1` (un solo rimborso nell'elenco): bastava che una delle due richieste fallisse per un errore transitorio (la simultaneità non era stata mostrata); due fallimenti (nessun rimborso) o un elenco in ritardo davano `contradicted` | `concurrentAnswerOf` legge **risposte ed elenco insieme**: `confirmed` solo con due risposte sullo **stesso** rimborso, oppure un rimborso più il conflitto documentato `idempotency_key_in_use` (codice presente nei tipi dell'SDK), **e** l'elenco con **un solo** rimborso; `contradicted` solo con **due rimborsi** (nominati dalle risposte o contati nell'elenco); tutto il resto (errore diverso dal conflitto, nessuna risposta, elenco che non mostra ancora il rimborso) ⇒ `not_confirmable`. Il Boolean ingannevole `sameKeyOtherAmountRefused` lascia il posto a `sameKeyOtherAmountAnswer` (nessun test lo leggeva); si aggiungono `concurrentAnswer` e `concurrentErrors` |
| 3 | **T2.** `expireError && after.status === 'complete' ? ok : bad`: **qualunque** errore di `expire` su una pagina pagata valeva rifiuto (un 500 la confermava); «nessun errore, sessione invariata» era `contradicted` | `isRequestRefused`: rifiuto = richiesta processata e respinta come non accettabile (`StripeInvalidRequestError`, HTTP 400). **Nessun codice**: l'SDK non ne documenta uno per «la sessione non è aperta». Due parti: la sessione resta completata (riletta) e Stripe rifiuta. `confirmed` solo con entrambe; altri errori o nessun errore ⇒ `not_confirmable` con lo stato della sessione registrato; sessione pagata **cambiata di stato** ⇒ `contradicted` qualunque sia l'errore (anche se la connessione cade *dopo* la chiusura) |
| 4 | **T14.** `states.some(state => state !== 'succeeded') ? ok`: bastava **un** stato (anche solo `pending` poi `succeeded`) per `confirmed`, benché il fatto riguardi quattro stati; il rapporto non diceva quali non erano stati visti | `t14Result`: tre parti — solo stati noti (`contradicted` se ne compare uno sconosciuto), **stato aperto visto** (`pending` o `requires_action`), **fine senza rimborso vista** (`failed` oppure `canceled`: sono **alternative**, un rimborso ne ha una sola). `confirmed` solo con aperto **e** fine senza rimborso; non si chiede a un singolo rimborso una sequenza irrealistica (nessuna prova la simula). Il rapporto elenca sempre `statesObserved` e `statesNotObserved`: uno stato che nessuno ha prodotto non è mai accreditato, neppure quando il fatto nel suo insieme è confermato |
| 5 | **Gli stop dello script scambiati per risposte di Stripe** (scoperto mentre correggevo T2 e T5). I tre punti che leggono un errore come prova (`catch` di T2, di T5 e le due richieste di T5) inghiottivano `LivemodeError` e `BudgetError`: un oggetto in modalità reale visto lì non fermava la corsa né compariva nel rapporto | `stopOnOwnStop`: gli stop dello script stesso attraversano quei punti e fermano la corsa (`aborted: 'livemode'`, esito 3). Con una chiave di prova un oggetto reale non dovrebbe mai comparire; è una rete di sicurezza, resa vera dove si legge un errore come prova |

I fatti T2, T5 e T14 hanno ora l'elenco `parts` (oltre a T8 e T16): lo stato è sempre quello della parte peggiore. Il Stripe finto produce questi errori con **le classi dell'SDK** (solo costruite: nessuna rete) e senza codici inventati; il codice `checkout_session_expire_failed` che il finto aveva inventato per la chiusura di una sessione è stato **tolto** (non esiste nell'SDK).

### Prove rosso → verde

| Passo | Che cosa girava | Esito |
|---|---|---|
| 0 · **Prima** | `9367b7f` | 41/41 verdi: i difetti erano invisibili a quelle prove |
| 1 · **Rosso** | le prove nuove (81 in tutto) + il simulatore esteso, lo script **ancora com'era** in `9367b7f` | **39 passano, 42 falliscono**. Verdetti sbagliati dello script vecchio, scenario per scenario: **T5-rifiuto** `confirmed` con un 500, una connessione caduta, un 429, un 403, un 401 e il conflitto «chiave in uso» (6); **T5-simultanee** `confirmed` con un 500 o una connessione caduta su una delle due richieste (2) e `contradicted` quando falliscono entrambe o l'elenco è in ritardo (2); **T2** `confirmed` con un 500, una connessione caduta, un 429, un 403, un 401 e un 404 (6) e `contradicted` per «nessun errore, sessione invariata» (1); **T14** `confirmed` con `pending → succeeded`, con `pending` per tutta la finestra e con `failed` subito (3). Totale: **20 verdetti sbagliati**; gli altri fallimenti sono la struttura nuova (parti, elenchi) e gli aiutanti ancora assenti |
| 1b · **Rosso** (stop dello script) | le 2 prove sugli stop, con lo script senza `stopOnOwnStop` | 81 passano, **2 falliscono**: l'aiutante manca, e un oggetto in modalità reale nella risposta a `expire` non ferma la corsa (`aborted` resta vuoto) |
| 2 · **Verde** | le stesse 83 prove + lo script corretto | **83/83** |

Le prove nuove sono 42 (da 41 a 83): classificatore delle risposte; **9 scenari** per il rifiuto di T5; **9 scenari** per le richieste simultanee di T5 + una prova sull'aiutante puro (13 casi); **11 scenari** per T2; **8 scenari** per T14 + la regola sull'aiutante puro; 2 prove sugli stop. Il caso «rifiuto di idempotenza nella forma dell'SDK» passa anche con lo script vecchio **per costruzione**: protegge la correzione dalla trappola del `code`, non è una prova rossa. **Due prove esistenti sono state adeguate, nessuna allentata**: nella tabella di T16 la colonna `t14` di tre scenari passa da `confirmed` a `not_confirmable` (asseriva il difetto: un solo stato bastava), e la prova delle parti ora elenca `T2, T5, T8, T14, T16` (stessa invariante «stato = parte peggiore, ogni parte spiega sé stessa»; gli scenari includono errori generici, una sessione chiusa e uno stato sconosciuto).

### Mutazioni (sulla copia, una per volta, tutte da rilevare)

**54 mutazioni, 54 rilevate, 0 sopravvissute, 0 non applicate**: le 27 di S6a.13 (14 `V-*` + 13 `SP1-*`) e **27 nuove** — T5: classificatore che accetta qualsiasi errore · che guarda `code` (trappola dell'SDK) · che conta il conflitto «chiave in uso» · errore generico ⇒ `contradicted` · richiesta accettata non contraddetta · errore registrato come rifiuto; simultanee: decide il solo conteggio dell'elenco · un errore qualunque scambiato per il conflitto · nessuna risposta ⇒ `contradicted` · due rimborsi nell'elenco non visti · due rimborsi nelle risposte non visti · risposte coerenti che confermano con l'elenco in ritardo; T2: qualunque errore è rifiuto · rifiuto di qualunque stato HTTP · «nessun errore» conta come rifiuto · sessione cambiata non notata; T14: un solo stato basta · stato aperto non richiesto · fine senza rimborso non richiesta · **richiesta di `failed` E `canceled` insieme** (la sequenza irrealistica) · stato sconosciuto ignorato · stati non osservati nascosti; stop: T2, T5-rifiuto e T5-simultanee che inghiottono uno stop dello script · `stopOnOwnStop` che non lancia mai; la nota che non dice cosa NON è confermato.

### Regressione e perimetro

| Verifica | Esito |
|---|---|
| `tests/stripe-test-mode-verify.test.ts` | **83/83** |
| `npx tsc --noEmit` / `npm run lint` | 0 errori / 0 avvisi |
| `npm test` | **644 prove, 642 passano, 2 falliscono: gli stessi 2 preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); +42 prove rispetto a S6a.13 |
| `tests/production-release-guards.test.ts` (guardie sul sorgente) | 16/16 |
| Tutto il file di prova con lo strato di rete **rifiutato** (modulo caricato con `--require`) | **83/83 con 0 tentativi di rete** (solo il canale locale del caricatore di prove); controllo negativo: lo stesso strato rifiuta e registra 3 tentativi verso un host inesistente |
| `git diff` | solo `scripts/stripe-test-mode-verify.ts`, `tests/stripe-test-mode-verify.test.ts`, `docs/STRIPE-TEST-MODE-S6.md`, `docs/VERIFICA-4.6.md`, `docs/CHECKLIST-PRELANCIO.md` |

**Nessuna chiamata a Stripe.** Nessuna variabile `STRIPE_*` nell'ambiente; il client vero (`createRealClient`) è raggiungibile solo da `main()` quando non è stato iniettato un client, e ogni prova ne inietta uno finto o blocca la rete.

**Non provato e limiti.** (a) Come risponde Stripe vero: il rifiuto di una chiave usata con altri parametri (`idempotency_error`), il conflitto delle richieste simultanee (`idempotency_key_in_use`), il rifiuto di `expire` su una sessione pagata (HTTP 400), gli stati dei rimborsi: sono **ipotesi** finché non gira la prova del titolare; il Stripe finto produce questi errori con le classi dell'SDK, ma le risposte sono scelte da noi. Se Stripe vero risponde in un altro modo, il fatto diventa `not_confirmable` e il rapporto mostra la risposta: **mai una falsa conferma**. (b) T14 sarà `confirmed` solo se il metodo di prova indicato dal titolare produce un rimborso aperto e uno che finisce senza rimborsare; con un solo rimborso e un solo metodo è del tutto possibile che resti `not_confirmable`, con gli stati visti e non visti elencati. (c) **Osservazioni non modificate in S6a.14, poi risolte in S6a.15** (stesso tipo, fuori dai fatti richiesti): T13 dichiara `contradicted` ogni risposta «richiesta non valida» alla creazione dell'endpoint, senza controllare che riguardi i tipi di evento; i `catch` di T8 (`events.list`), T11, T12, T13 e della pulizia leggono l'errore senza lasciar passare uno stop dello script (T11 richiede comunque il codice documentato `charge_disputed`, quindi non conferma per errori qualunque). Nessuna riga della checklist è passata a «superata» e 1.44 resta **Bloccante**. **Lo script non è stato eseguito e non lo sarà senza una nuova autorizzazione esplicita.**

## S6a.15 Chiusura della garanzia di arresto (ogni `catch`, T13)

**Perché.** Il titolare ha verificato `da7c10c` e ha segnalato l'ultimo problema di sicurezza dello script: alcuni `catch` intercettavano `LivemodeError` e `BudgetError` senza propagarli al gestore centrale. Il contratto (già definito e già provato in un caso) è: **un oggetto in modalità reale o un limite raggiunto fermano la corsa** — il gestore (`attempt`, in `run`) registra il motivo, salta ogni passo successivo (pulizia compresa), non fa altre chiamate, e per un oggetto reale l'uscita ha codice 3; **nessuno stop dello script è una risposta di Stripe**. Perimetro rispettato: solo `scripts/stripe-test-mode-verify.ts`, il suo test e la documentazione pertinente; nessuna modifica a `app/`, `lib/`, `prisma/`, `components/`, `package.json`, a funzionalità, API, pagamenti, database, schema, migrazioni, configurazioni, dipendenze o Vercel; `BUDGET` invariato (nessuna chiamata in più); **nessuna chiamata a Stripe, nemmeno in Test Mode**; tutte le correzioni di `9367b7f` e `da7c10c` restano.

### Verifica di tutti i `catch` e dei `Promise.allSettled`

| Punto | Prima | Dopo |
|---|---|---|
| `Gate.call` | rilancia `LivemodeError`; `BudgetError` nasce prima del `try` | invariato (**decide**) |
| `attempt` (gestore centrale di `run`) | decide | invariato; il contratto è ora scritto nel commento |
| T2, pagina **pagata** | `stopOnOwnStop` (S6a.14) | invariato |
| T2, pagina **non pagata** (il ramo «sessione non completata») | `catch {}`: inghiottiva tutto | `stopOnOwnStop` |
| T5, altro importo; T5, due richieste insieme (`Promise.allSettled`) | `stopOnOwnStop` (S6a.14) | invariato |
| T8, `events.list` | inghiottiva e andava avanti | `stopOnOwnStop` |
| T11, rimborso di un addebito contestato | inghiottiva | `stopOnOwnStop` |
| T12, ricerca | inghiottiva (e usciva dal ciclo) | `stopOnOwnStop` |
| T13, eliminazione dell'endpoint (`catch` interno) | inghiottiva | `stopOnOwnStop` |
| T13, creazione dell'endpoint (`catch` esterno) | inghiottiva e classificava male | `stopOnOwnStop` + rifiuto dimostrato (sotto) |
| Pulizia (lettura e annullamento dei pagamenti non pagati) | inghiottiva e passava all'oggetto successivo (altre chiamate) | `stopOnOwnStop` |
| `main`, due `catch` (corsa fallita, rapporto rifiutato) | non chiamano Stripe | invariati |
| `.catch` della riga di comando | esito 1 per errori imprevisti | invariato |

Un **controllo sul sorgente** (nel file di prova, con lo scanner già usato dalle guardie) fa fallire il test se resta un `catch` senza `stopOnOwnStop` e senza essere uno dei gestori che decidono, se compare un `.catch(` di tipo promise oltre a quello della riga di comando, un `Promise.all/race/any`, o un `Promise.allSettled` senza il controllo subito dopo.

### T13: un rifiuto dimostra l'impossibilità di sottoscrivere un evento solo se riguarda gli eventi

Prima **ogni** errore «richiesta non valida» alla creazione dell'endpoint dava `contradicted`. Ora `isEventTypeRefusal`: solo una richiesta processata e respinta come non accettabile (`StripeInvalidRequestError`, HTTP 400) il cui **parametro** — l'attributo `param` dell'oggetto errore, documentato da Stripe — è `enabled_events` (o una sua voce, `enabled_events[2]`) dimostra che un tipo di evento non è sottoscrivibile ⇒ `contradicted`. Un rifiuto su un altro parametro (l'indirizzo), senza parametro, con un altro stato HTTP, un limite, un permesso, un errore del server o una connessione caduta ⇒ **`not_confirmable`**, e il rapporto riporta la risposta di Stripe, la sua classificazione (`answer`) e gli eventi che il messaggio nomina (`eventsNamedByStripe`, solo informativo). Anche l'endpoint che torna senza alcuni eventi resta `contradicted` (è la risposta stessa di Stripe). Nessun codice è inventato: l'SDK non documenta un codice per «tipo di evento non valido», e il codice che il Stripe finto dava a questo rifiuto (`parameter_invalid_enum`) non esiste nell'SDK ed è stato tolto; il finto ora costruisce l'errore con le classi dell'SDK. La forma esatta dell'errore **vero** è un'ipotesi: se Stripe non punta a `enabled_events`, T13 diventa `not_confirmable` (nessun effetto sul codice dell'applicazione: la conseguenza è la stessa, «una contestazione chiusa si apprende leggendola»).

### Prove rosso → verde

| Passo | Che cosa girava | Esito |
|---|---|---|
| 0 · **Prima** | `da7c10c` | 83/83 verdi: gli arresti inghiottiti non erano provati |
| 1 · **Rosso** | le prove nuove (117 in tutto) con lo script **ancora com'era** in `da7c10c` | **89 passano, 28 falliscono**. Tutti gli 8 punti che inghiottivano falliscono sia con un oggetto reale sia con un limite (16): `aborted` resta vuoto e la corsa va avanti. Attraverso `main()`: un oggetto reale a metà usciva con **codice 0** invece di 3. Un limite raggiunto «per davvero» (la durata supera il consentito) veniva inghiottito alla cancellazione dell'endpoint. Il controllo sul sorgente elenca i `catch` scoperti. T13: 2 verdetti sbagliati (richiesta non valida su un altro parametro e senza parametro ⇒ `contradicted`) più la struttura nuova (classificatore, `answer`) |
| 2 · **Verde** | le stesse 117 prove + lo script corretto | **117/117** |

I punti già a posto prima (T2 pagina pagata, T5 altro importo e due richieste: 3 punti × 2 = 6 prove) passano anche con lo script vecchio: sono nel giro per completezza, non sono prove rosse. Le prove nuove sono 34 (da 83 a 117): controllo sul sorgente (1) · **11 punti × {oggetto reale, limite raggiunto} = 22 prove di arresto** · uscita di `main()` (1) · limite raggiunto per davvero con il Gate che rifiuta (1) · classificatore di T13 (1) · 8 scenari di T13. Per ogni prova di arresto: lo stop è iniettato nel punto voluto, **nessuna chiamata dopo lo stop** (`fake.calls.length` uguale al numero di chiamate allo stop), `aborted` e `livemodeSeen` come da contratto, i fatti del passo `not_confirmable` con il motivo, la pulizia non eseguita (T18 `not_confirmable`), i fatti precedenti al punto che mantengono il loro verdetto (T1 `confirmed`), il rapporto privo di segreti. L'oggetto reale è un oggetto con `livemode: true` nella risposta; il limite è un `BudgetError` lanciato prima della chiamata (la chiamata non parte). Nessuna prova esistente è stata modificata o allentata.

### Mutazioni mirate (sulla copia, una per volta, tutte da rilevare)

**73 mutazioni, 73 rilevate, 0 sopravvissute**: le 54 di S6a.14 e **19 nuove** — un `stopOnOwnStop` tolto in ciascuno dei 7 punti nuovi · `stopOnOwnStop` che lascia passare solo gli oggetti reali o solo i limiti · il gestore che non registra il limite o l'oggetto reale · i passi successivi non saltati dopo un arresto · il codice 3 tolto · T13: ogni richiesta non valida contraddice, il parametro non richiesto, lo stato HTTP non richiesto, un parametro che inizia soltanto con `enabled_events`, qualunque errore contraddice, gli eventi nominati non riportati. Due mutazioni vecchie avevano l'ancora rotta dalle correzioni (0 occorrenze, 2 occorrenze): le ho riallineate e rilanciate, rilevate. In più, **10 mutazioni «inghiottire lo stop» (i 7 punti nuovi più i 3 di S6a.14) eseguite con il controllo sul sorgente escluso: le sole prove di comportamento le rilevano tutte e 10** — il controllo sul sorgente è una seconda rete, non l'unica.

### Regressione e perimetro

| Verifica | Esito |
|---|---|
| `tests/stripe-test-mode-verify.test.ts` | **117/117** |
| `npx tsc --noEmit` / `npm run lint` | 0 errori / 0 avvisi |
| `npm test` | **678 prove, 676 passano, 2 falliscono: gli stessi 2 preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); +34 prove rispetto a S6a.14 |
| `tests/production-release-guards.test.ts` (guardie sul sorgente) | 16/16 |
| Tutto il file di prova con lo strato di rete **rifiutato** (modulo caricato con `--require`) | **117/117 con 0 tentativi di rete** (solo il canale locale del caricatore di prove); controllo negativo: lo stesso strato rifiuta e registra 3 tentativi verso un host inesistente |
| `git diff` | solo `scripts/stripe-test-mode-verify.ts`, `tests/stripe-test-mode-verify.test.ts`, `docs/STRIPE-TEST-MODE-S6.md`, `docs/VERIFICA-4.6.md`, `docs/CHECKLIST-PRELANCIO.md` |

**Nessuna chiamata a Stripe.** Nessuna variabile `STRIPE_*` nell'ambiente; il client vero (`createRealClient`) è raggiungibile solo da `main()` quando non è stato iniettato un client, e ogni prova ne inietta uno finto o blocca la rete.

**Limiti e cose non provate.** (a) Gli arresti sono provati con un Stripe **finto**: un oggetto reale è un oggetto con `livemode: true` iniettato nella risposta e un limite è un `BudgetError`; con una chiave di prova vera nessuno dei due dovrebbe presentarsi. (b) Il contratto dell'arresto è «nessuna chiamata dopo lo stop», quindi **la pulizia non gira dopo un arresto**, nemmeno per un limite: gli oggetti già creati restano nel rapporto con l'azione che non è stata fatta (per esempio un endpoint di prova non eliminato) e si ritrovano nel Dashboard cercando `makerworksVerify`. (c) L'arresto ha la granularità del **passo**: se la corsa si ferma a metà di un passo, tutti i fatti di quel passo risultano `not_confirmable` con il motivo, anche quelli già risposti prima dell'arresto (per esempio T4 se lo stop cade in T5). (d) Se l'arresto cade sulla **creazione** di un endpoint che Stripe ha restituito come oggetto reale, l'id non è registrato (il Gate lancia prima di restituire la risposta). (e) Un arresto per **limite** esce con codice 0 (il contratto già definito riserva il 3 all'oggetto reale): lo dice il rapporto e l'ultima riga a schermo, non il codice di uscita. (f) La forma esatta degli errori **veri** di Stripe (il `param` di un rifiuto dei tipi di evento, lo stato HTTP del rifiuto di `expire`) resta un'ipotesi fino alla prova del titolare. Nessuna riga della checklist è passata a «superata» e 1.44 resta **Bloccante**. **Lo script non è stato eseguito e non lo sarà senza una nuova autorizzazione esplicita.**

## S6a.16 P4-0: la scorciatoia `acknowledgeUnverified` è tolta (F01 chiusa)

**Ambito.** «Autorizzazione limitata P4-0» (modalità AUTO, impegno MAX): **solo** la rimozione della scorciatoia F01. **Non** sono stati fatti P1, P3a, P4a, P4b, P5, SP1-quater né il piano rev. 3.2. Perimetro toccato: `lib/payment-hold.ts`, la rotta `payment-hold`, due file di prova (`tests/security/payment-hold.sec.ts`, `tests/production-release-guards.test.ts`) e i documenti che descrivevano la scorciatoia come ancora presente. Nessuna modifica a checkout, prezzi, sessioni ospite, schema Prisma, migrazioni, pagamenti Stripe applicativi, webhook, rimborsi, interfaccia, dipendenze o Vercel. Nessuna chiamata a Stripe (nemmeno in Test Mode) e nessuna chiave: Stripe finto, database di prova isolato (`mkw_sectest`, locale).

**Il difetto (F01).** Con Stripe non raggiungibile, `POST /api/admin/orders/<id>/payment-hold` con `{ "outcome": "no_charge", "reason": "…", "acknowledgeUnverified": true }` annullava l'ordine («nessun addebito», esito registrato `unreachable_acknowledged`), chiudeva le pagine di pagamento e scriveva la decisione in audit, anche se il cliente poteva avere pagato. Riprodotto dalla prova rossa; risposta reale del codice vecchio: `200 {"ok":true,"order":{"status":"cancelled","paymentStatus":"canceled",…},"stripeCheck":"unreachable_acknowledged"}`.

### Che cosa cambia

| | Prima | Dopo |
|---|---|---|
| Campo `acknowledgeUnverified` | nel tipo `ResolveHoldInput` e nel contratto Zod della rotta | assente: il corpo è `.strict()`, una richiesta che lo contiene riceve **400** `INVALID_REQUEST` prima che Stripe sia interrogato |
| Esiti registrati (`stripeCheck`) | `confirmed_no_charge`, `unreachable_acknowledged`, `payment_collected` | `confirmed_no_charge`, `payment_collected` |
| Stripe non verificabile (non raggiungibile, sincronizzazione fallita, lettura di una pagina fallita) | `409 STRIPE_UNREACHABLE`, **aggirabile** con il campo | **`409 STRIPE_UNVERIFIABLE`**, senza alternativa; il messaggio non suggerisce alcuna dichiarazione |
| «Nessun addebito» con la verifica incerta | possibile (con il campo) | mai |
| Invariati | | `accepted`; `no_charge` con prove sufficienti (`confirmed_no_charge`); `PAYMENT_COLLECTED`, `CHARGE_EXISTS`, `NOT_PAID`, `NOT_ON_HOLD`, `REFUND_IN_PROGRESS`; 401 / 403 / 400 come prima |

Nel codice: `lib/payment-hold.ts` perde il campo, l'esito e il ramo che annullava l'ordine con la verifica incerta (il controllo `evidence === 'unknown' || !synced` ora rifiuta sempre); la rotta perde il campo dal contratto e dalla chiamata. Il resto del codice dei due file è identico (cambiano anche i commenti che descrivevano la scorciatoia).

### Che cosa è garantito, e con quale precisione

**Provato.** L'impossibilità di verificare Stripe non autorizza mai una risoluzione `no_charge`. In tre modi di non ottenere risposta — nessuna lettura riesce · la sincronizzazione non gira ma la lettura della pagina sì · la sincronizzazione gira ma la lettura della pagina no — la risposta è `409 STRIPE_UNVERIFIABLE`, anche chiedendo due volte, e restano uguali l'ordine (ogni colonna), i suoi tentativi (ogni colonna), le pagine di pagamento (0 chiusure presso Stripe), i metadati (nessuna risoluzione, nessuna cancellazione) e il registro di audit (0 decisioni). Quando poi Stripe risponde, la stessa richiesta è decisa su ciò che Stripe dice (`confirmed_no_charge`).

**Precisione sulla sincronizzazione.** La sincronizzazione che precede la decisione (`syncPayment`) è indipendente dalla decisione. Quando Stripe non le dice nulla tiene soltanto i propri registri di lavoro (il lease che prende mentre legge e l'orario dell'ultima lettura: N2 di `lib/financial-revision.ts`) e l'orario di aggiornamento della riga: la prova ammette **solo** queste colonne come diverse (per i tentativi, solo l'orario di aggiornamento) e verifica che il lease non resti sull'ordine. Se invece la sincronizzazione trova un pagamento **reale**, lo registra: è una modifica dell'ordine che non viene dalla decisione, e «nessun addebito» è allora rifiutato come `PAYMENT_COLLECTED` (prova che esisteva già). **L'assenza di modifiche al database non è quindi presentata come garantita in assoluto**, ma nello scenario in cui Stripe non risponde.

### Prove rosso → verde

| Passo | Che cosa girava | Esito |
|---|---|---|
| 0 · **Prima** | `payment-hold.sec.ts` e le guardie, codice di `e6b3ef3` | 13/13 e 16/16: il difetto non era provato (una prova **verificava che la scorciatoia funzionasse**) |
| 1 · **Rosso** | le prove nuove (16 e 18) con il codice di produzione **ancora com'era** | **12 passano e 4 falliscono** nel file di sicurezza, **17 passano e 1 fallisce** nelle guardie. Le tre «Stripe non verificabile» attendono `STRIPE_UNVERIFIABLE` e ricevono `STRIPE_UNREACHABLE`; la richiesta con il campo attende 400 e riceve **200 con l'ordine annullato** (il difetto); la guardia G13 trova i nomi vecchi in `app/` e `lib/` |
| 2 · **Verde** | le stesse prove + il codice corretto | **16/16** e **18/18** |

Le prove nuove (in `tests/security/payment-hold.sec.ts`): tre scenari «Stripe non risponde» (nessuna lettura riesce · la sincronizzazione non gira · la lettura della pagina non riesce) che chiedono due volte, confrontano ordine, tentativi, pagine e audit e poi ripetono la richiesta a Stripe di nuovo raggiungibile; la richiesta con il campo (`true`, `false`, `"true"`, `1`, `null`; esito `no_charge` e `accepted`; Stripe raggiungibile e no) → 400, **prima di ogni lettura di Stripe**, ordine invariato; il risultato registrato nei flussi validi (`confirmed_no_charge`, `payment_collected`) nella risposta, nei metadati e nell'audit. La prova vecchia che verificava la scorciatoia è stata **sostituita** (non allentata). Guardia **G13** (`tests/production-release-guards.test.ts`): nessuno dei tre nomi (`acknowledgeUnverified`, `unreachable_acknowledged`, `STRIPE_UNREACHABLE`) in `app/`, `lib/`, `components/`, nemmeno in un commento, con una prova del rilevatore (vede ciascun nome in un campo, un valore, un codice e un commento) e un controllo che la scansione raggiunga la libreria e la rotta. I documenti e i test di regressione possono citare il difetto: non sono scansionati.

### Altri risultati

| Prova | Esito |
|---|---|
| Mutazioni (su una copia, fuori dal repository): scorciatoia completa · campo di nuovo nella rotta · rotta non più `.strict()` · lettura non riuscita ignorata · sincronizzazione non riuscita ignorata · lettura che fallisce contata «nessun denaro» · vecchio codice di errore · pagine chiuse / decisione in audit / ordine o tentativi modificati **prima** del rifiuto · «nessun addebito» legittimo rifiutato · il nome vecchio in un commento di `components/`, di un altro file di `lib/`, di un'altra rotta | **15/15 rilevate**, 0 sopravvissute (la lettura non riuscita ignorata e la sincronizzazione non riuscita ignorata sono rilevate da prove distinte; scrivere l'ordine, i tentativi, l'audit o chiudere le pagine **prima** del rifiuto è rilevato in tutti e tre gli scenari) |
| `npx tsc --noEmit` · `npm run lint` (0 avvisi) · `npm run build` | 0 · 0 · riuscita |
| `npm test` | **680 prove, 678 passano, 2 falliscono: le stesse 2 preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); +2 rispetto a S6a.15 (G13) |
| `npm run test:security` (database isolato, un file alla volta) | **1314/1314** (1311 in S6a: +3 nette in `payment-hold.sec.ts`, da 13 a 16) |
| `test:api` · `test:contracts` | 7/7 · 14/14 |
| Rete rifiutata (preload che rifiuta e registra ogni tentativo; `fetch` fallisce in modo asincrono come uno vero) | `payment-hold.sec.ts` + guardie **34/34**; 0 tentativi verso qualunque host, tranne i 40 che il banco di prova rivolge da sé all'indirizzo morto `127.0.0.1:9` (la ricerca dei colori di StockWorks nel preventivo: nessuno vi ascolta e il codice degrada); il controllo negativo registra un tentativo verso `api.stripe.com`, quindi la guardia vede |

Log conservati fuori dal repository.

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **F02, F03, F12 restano aperti**: un tentativo senza identificativi Stripe vale ancora «nessun denaro»; `accepted` verifica ancora solo il database; il vicolo cieco di un pagamento rimborsato. Sono il resto di P4 (trattenuto fino al via libera su SP1). **R1** resta non accettato e bloccante per il lancio. Contestazioni e posizione dei fondi (P1, P3-Stripe) e il rimborso dall'app (P5) sono invariati.
- **Il rifiuto non scrive un evento in audit** (la tassonomia decisione / verifica / rifiuto arriva con P4): la prova verifica che **nessuna decisione** sia registrata, non che il rifiuto sia tracciato.
- **Chiave Stripe mancante.** Se `STRIPE_SECRET_KEY` non fosse configurata, `getStripe()` lancia fuori dal `try` della lettura e la rotta risponde `500 FAILED`, non `409`: resta chiuso (nessuna decisione) ma con un altro codice. Era così anche prima. Non è provato: il banco di prova sostituisce il client condiviso, quindi quel ramo non è raggiungibile.
- **Risoluzioni già registrate** con `unreachable_acknowledged` non vengono migrate o rilette: oggi non esistono ordini reali; un eventuale dato storico resterebbe com'è.
- **La guardia G13 è testuale** (cerca i tre nomi): non impedisce un'altra scorciatoia con un nome diverso. La difesa di fondo è il comportamento provato dai tre scenari.
- Prove con **Stripe finto**: il comportamento di Stripe reale nei tre modi di non rispondere (timeout, errore di connessione, 5xx) è coperto dal modello «ogni errore della lettura = non verificabile», non da una prova reale.
- Alcune sezioni precedenti di questo documento (S4, S5, S6a.1 e S6a.10) e `docs/VERIFICA-4.5.md` descrivono la scorciatoia come presente o aperta: sono la registrazione di quel momento e non sono state riscritte.

### Come riprodurre
`SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest node --test --test-concurrency=1 --import tsx tests/security/payment-hold.sec.ts` · `node --test --import tsx tests/production-release-guards.test.ts` · `npx tsc --noEmit` · `npm run lint` · `npm test` · `npm run test:security`.

## S6a.17 SP1-quater: il primo collaudo reale registrato e il protocollo AR-2 (rimborsi asincroni), scritto e provato solo offline

**Ambito.** «Autorizzazione limitata SP1-quater» (modalità AUTO, impegno MAX): **solo** l'implementazione e la verifica **offline** del protocollo AR-2, più la registrazione del primo collaudo reale. **Non** autorizzati e **non** fatti: l'esecuzione di AR-2 su Stripe (nemmeno in Test Mode), P1, P3, P4a/P4b, P5, S6b e il piano S6 rev. 3.2 nel suo insieme. Perimetro toccato: `scripts/stripe-test-mode-verify.ts`, un file di prova nuovo (`tests/stripe-test-mode-verify-ar2.test.ts`), `docs/STRIPE-TEST-MODE-S6.md` (sezione 11 e puntatori), questo documento e `docs/CHECKLIST-PRELANCIO.md` (riga 1.44). **Nessuna** modifica a `app/`, `lib/`, `components/`, `prisma/`, dipendenze, prezzi, checkout, webhook applicativi o configurazioni di produzione; nessuna migrazione; nessun database reale (le prove di AR-2 non usano alcun database); nessuna chiave; **nessuna chiamata a Stripe**. Partenza: `957375d` (P4-0). Le 117 prove di SP1 (`tests/stripe-test-mode-verify.test.ts`) **non sono state modificate** e passano come prima.

### Il primo collaudo reale (registrazione; nessun identificativo di Stripe)

Eseguito dal titolare, in una sandbox dedicata, con lo script al commit `e6b3ef3`.

| | |
|---|---|
| Esecuzione | `a9488563` |
| Data | 20–21 ottobre 2026 (UTC) |
| Versione API | `2025-10-29.clover` |
| Esito | **15 fatti confermati · 0 contraddetti · 3 non confermabili** (T6, T14, T16) |
| Uso | 65 chiamate (su 170) · 4,00 di importi di prova (su 5,00) · circa 338 s (su 20 minuti) |
| Arresto | `aborted: null` · `livemodeSeen: false` |
| Pulizia (T18) | senza anomalie |

**Fatti confermati (15, evidenza osservata):** T1–T5, T7–T13, T15, T17, T18. **Non confermabili (3):** T6 — le chiavi di idempotenza durano 24 ore: non riproducibile in una prova, **per costruzione**; T14 e T16 — gli stati del rimborso oltre `succeeded` e l'effetto sull'importo rimborsato: **non per ciò che fa Stripe ma per come erano stati definiti** (un solo metodo di prova e un ciclo di lettura che si fermava al primo `succeeded`, v. `docs/STRIPE-TEST-MODE-S6.md` sezione 11.1). Quindi il collaudo ha mostrato **dove il protocollo era sbagliato**, non un comportamento di Stripe.

**Osservazione della sandbox (non un dato di produzione).** Nella contestazione di prova la transazione di saldo del ritiro ha dato commissione di **20,00** su un pagamento da **1,00**. È **solo** ciò che ha mostrato la sandbox: importo e regole della commissione dipendono da paese e account e non sono quelli di produzione; **nessun importo di commissione compare nel codice** e la commissione non entra in alcun calcolo del capitale (P1 non è stato scritto).

**Evidenza osservata e vincoli accettati per costruzione restano distinti.** I 15 fatti sono evidenza **osservata** (in una sandbox). T6 (e gli stati `requires_action` / `canceled`, che i metodi di prova non producono) non sono osservabili con un flusso solo-carta: il progetto non vi si affida (margine di 20 ore, stato sconosciuto = blocco) e la loro chiusura è un'**accettazione per costruzione** che spetta per iscritto al titolare. **Nulla di questo è stato dichiarato superato.**

### AR-2 in breve

AR-2 è un **secondo protocollo dello stesso script**, scelto **solo** con `--protocol ar2` (un avvio semplice esegue SP1, come prima; `parseArgs` non imposta alcun valore predefinito). Due scenari **indipendenti**, dalla tabella dei rimborsi di <https://docs.stripe.com/testing#refunds> (i codici sono quelli verificati dal titolare):

| Scenario | Metodo di prova | Atteso | Fatti |
|---|---|---|---|
| A | `pm_card_pendingRefund` | il rimborso parte `pending`, poi `succeeded` | T14A, T16A |
| B | `pm_card_refundFail` | il rimborso parte `succeeded`, poi `failed` | T14B, T16B |
| — | endpoint di prova | i tipi `refund.created`, `refund.updated`, `refund.failed` sono sottoscrivibili | T13B |
| — | elenco degli eventi | gli eventi generati davvero per ciascun rimborso, e quando | T19 |

**Come osserva.** Un calendario (5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, 540, 570 secondi dalla creazione; nessuna lettura **parte** dopo i 10 minuti). Un **campione** accoppia l'importo `amount_refunded` dell'addebito con lo stato del rimborso letto subito **prima** e subito **dopo**: vale solo se i due stati coincidono; un campione in cui lo stato cambia **mentre** si legge l'importo è tenuto da parte («non usato») e non è mai attribuito a uno stato. L'importo di ogni stato si legge **due volte, a distanza di almeno 5 secondi**, e vale solo se le due letture coincidono (altrimenti la parte è `not_confirmable` e il rapporto mostra tutti i valori). Lo scenario B **non si ferma al primo `succeeded`**. Una transizione o un evento **non visti** entro la finestra danno `not_confirmable`: mai una conferma, mai una contraddizione presunta. Una lettura che fallisce è registrata, non è ripetuta subito, e tre di fila fermano quello scenario. T16B **confronta** esplicitamente l'importo dopo `succeeded` con quello dopo `failed` (`went_back_down` / `unchanged` / `rose`, e la differenza in centesimi). Eventi: **tipo sottoscrivibile** (T13B) ≠ **tipo osservato** ≠ **evento non osservato** (in un elenco letto: non prova mai che Stripe non lo generi) ≠ **errore di lettura** (non è un evento assente e non si ripete). Campi opzionali: `failure_reason` e `failure_balance_transaction` (nullabile) **non** sono condizioni per confermare `failed`; si registrano a parte, insieme alla transazione di saldo del rimborso stesso, se si riesce a leggerle (tipo, importo, commissione, netto, segno, valuta; mai identificativi).

### Il profilo di AR-2 e le differenze rispetto a SP1 (imposti dal codice prima di ogni chiamata)

| | AR-2 | SP1 (invariato) |
|---|---|---|
| PaymentIntent | **2**, da 1.00 | 5 |
| Denaro di prova | **2.00** in totale | 5,00 |
| Rimborsi | **2**, ciascuno **≤ 0.20** (uno più grande è rifiutato prima di essere fatto) | 12 |
| Sessioni di Checkout · prove di contestazione | 0 · 0 | 2 · 2 |
| Endpoint webhook (cancellato subito) | 1 | 1 |
| Chiamate all'API | **120** | 170 |
| Durata totale · osservazione per scenario | **25 minuti** · 10 minuti | 20 minuti · – |
| Chiamate consentite | **elenco chiuso di 10** (rifiutate prima di essere fatte) | nessun elenco |
| Clienti, prodotti, prezzi, fatture, link di pagamento | mai creati | mai creati |
| Nuovi tentativi automatici | nessuno | nessuno |
| Restano uguali | arresto immediato davanti a un oggetto in modalità reale (uscita 3) · arresto davanti a un limite · **dopo un arresto nessuna chiamata, nemmeno di pulizia** · solo chiavi di prova · rapporto 0600 fuori dal repository e controllato prima di essere scritto | idem |

Tecnicamente: `Gate` ha un terzo parametro `budget` (SP1 se omesso, quindi il comportamento di SP1 è identico) con, solo per AR-2, `maxRefundAmountCents` e `allowedCalls`; `run()` passa a `runAr2()` solo se `options.protocol === 'ar2'`; la parola da scrivere per un avvio vero è **`AR-2`** (con `YES`, che avvia SP1, AR-2 non parte, e viceversa); il rapporto si chiama `stripe-test-mode-verify-ar2-<codice>.json` e porta `protocol: 'ar2'`; `--dry-run` mostra il protocollo scelto, i due scenari, i fatti, i massimi e le differenze, senza rete; con `ar2` le opzioni `--refund-test-pm` e `--skip-guided` (di SP1) sono rifiutate e `--only` accetta i fatti di AR-2. L'unico punto che cancella (`webhookEndpoints.del`) è condiviso da T13 e T13B (`throwawayEndpoint`): ne esiste ancora uno solo nello script.

### Prove rosso → verde

| Passo | Che cosa girava | Esito |
|---|---|---|
| 0 · **Base** | le 117 prove di SP1 sullo script di `957375d` | **117/117** |
| 1 · **Rosso** | il file nuovo (150 prove) scritto **prima**, sullo script **non modificato** (import di namespace: ogni prova fallisce da sola, il file si carica) | **148 falliscono, 2 passano**: le due che fissano ciò che **non** deve cambiare (i massimi di SP1 e «un avvio semplice è SP1»); le altre falliscono per `script.t14aResult is not a function`, `Unknown option: --protocol`, fatti T14A… assenti dal rapporto, ecc. |
| 2 · **Verde** | stesso file con lo script implementato | 145/150 al primo giro (tre prove sbagliate da me, sotto, e la sezione 11 della guida ancora da scrivere); 149/150 dopo le correzioni; tutte verdi con la guida |
| 3 · **Rifinitura** | seconda lettura dell'importo, transazione di saldo del rimborso, prove aggiunte per i sopravvissuti delle mutazioni | **174/174** (file nuovo) · **117/117** (SP1, invariate) |

**Tre prove sbagliate da me, corrette durante il verde (dichiarate; nessuna asserzione di sicurezza allentata).** (1) Il test di isolamento contava le richieste di creazione nel registro delle richieste del finto, ma il finto non registra una richiesta rifiutata dal suo stesso interruttore: ora conta le chiamate (`callLog`). (2) Il test «tre letture di fila che falliscono» si aspettava 2 letture di eventi, mentre la sua stessa didascalia diceva «A non ne chiede, B una»: il numero giusto è **1**. (3) Il punto di arresto «B, una lettura del rimborso dopo il primo `succeeded`» usava la ventesima lettura, che nel flusso documentato non esiste: ora è la quattordicesima. Altre prove sono state **aggiunte** (non cambiate) dopo la rifinitura: le due letture dell'importo (concordanti e discordanti, in forma pura e con un addebito aggiornato in ritardo), la transazione di saldo del rimborso, un rimborso che cambia stato a ogni lettura (campioni limitati a 5), gli errori non di fila, una risposta senza stato, un campione instabile che non chiude uno scenario, la conferma che parte da una lettura fresca, il confine esatto della finestra, un fallimento imprevisto dentro uno scenario, il tempo del primo di più eventi dello stesso tipo, la pulizia che non parte dopo un arresto, una `failure_reason` vuota, e la riga per riga della tabella dei massimi nella guida.

**Scelta di progetto presa durante il verde (la dichiaro).** Un importo letto una volta sola subito dopo un cambio di stato potrebbe essere vecchio, se Stripe aggiornasse l'addebito un attimo dopo il rimborso: il risultato sarebbe un falso «invariato» proprio dove serve la misura (T16B decide se `amount_refunded` scende dopo un fallimento). Per questo l'importo di ogni stato è letto **due volte a distanza di almeno 5 secondi** e vale solo se le due letture coincidono. Costo: circa 5 chiamate in più e 5–10 secondi per scenario (restano largamente dentro i massimi: nel caso peggiore ~76 chiamate su 120); in caso di dubbio il fatto resta `not_confirmable` (prudente), non sbagliato.

### Mutazioni (su una copia fuori dal repository, una per volta, ripristino verificato)

**118 mutazioni, 118 rilevate, 0 sopravvissute, 0 non applicate.** Gruppi: profilo e gate (massimi di chiamate, denaro, pagamenti, rimborsi, tetto di un rimborso, durata, finestra, endpoint, elenco delle chiamate consentite, calendario fino al bordo della finestra, gate costruito con i numeri di SP1, SP1 che riceve un elenco) · selezione (protocollo predefinito, `YES` che avvia AR-2, `AR-2` che non serve, `--only` e opzioni di SP1 accettate, `run()` senza smistamento, `runAr2()` che parte con un altro protocollo, nome del rapporto, piano di SP1 al posto di quello di AR-2, nessuna domanda, `--protocol` senza controllo) · osservazione (B che si ferma al primo `succeeded`, stato finale da un campione instabile, campioni sempre «stabili», finestra assente o in ritardo, errori di fila mai contati o mai azzerati, nessuna seconda lettura, letture senza intervallo, letture discordanti mediate o con vince-l'ultima, nessuna conferma dello stato finale o senza lettura fresca, campione instabile non ripetuto, tetto dei campioni, calendario senza attese, letture dopo gli errori, creazione ripetuta, rimborso creato per qualunque stato, importo del rimborso non limitato) · verdetti (partenza non richiesta, passaggio senza lettura diretta, pagamento che smette di essere `succeeded`, stato sconosciuto accettato, `failure_balance_transaction` o `failure_reason` richiesti, T16B confrontato al contrario o con sé stesso o con `canceled`, T16A capovolto o contraddicibile, evento non visto = contraddizione, elenco illeggibile = evento assente, eventi dell'altro scenario, seconda lettura mai fatta o senza attesa, finestra degli eventi sbagliata, tipi di T13B sbagliati, T13B contraddetto da qualunque errore, metodi scambiati, stati mai visti dichiarati osservati, identificativo o segno della transazione di saldo, campioni non usati non contati) · arresti e pulizia (uno stop inghiottito in ciascuno degli 8 punti nuovi, pulizia dopo un arresto, T19 risposto dopo un arresto, un problema di uno scenario che ferma l'altro, oggetto reale che non imposta il segnale di modalità reale, un pagamento riuscito annullato, mai annullato quello non riuscito, eventi letti senza T19, endpoint non cancellato, segreto dell'endpoint nel rapporto, due rimborsi con la stessa chiave, metadati con lo scenario sbagliato, rapporto con il budget di SP1, fatti non risposti non riempiti, una domanda o una scritta durante la corsa) · guida (passi di Windows tolti, massimi diversi dal codice).

**Come ci sono arrivato.** Primo giro: 87 rilevate, 9 sopravvissute, 2 con l'ancora sbagliata. Ogni sopravvissuta è stata analizzata: **sei erano buchi veri e hanno una prova nuova** (stato finale da un campione instabile · errori non di fila che non azzerano il contatore · conferma che non rilegge lo stato · risposta senza stato · pulizia dopo un arresto, non vista perché i pagamenti degli altri punti erano riusciti · riga della tabella dei massimi nella guida, che le prove controllavano solo come numero sparso); una era una **protezione ridondante** (il controllo «elenco di eventi leggibile» prima della seconda lettura era già garantito dall'uscita del ciclo nel `catch`): l'ho tolta dal codice e la mutazione è diventata «il `break` del `catch` tolto», rilevata; una era **più severa del limite**, quindi non un difetto (finestra di un secondo in anticipo): sostituita dalla variante in ritardo, rilevata da una prova sul millisecondo; una non era osservabile (il segreto dell'endpoint copiato in una variabile locale): sostituita dalla variante che lo mette nel rapporto. Secondo giro (ora 118): 115 rilevate, 3 sopravvissute (un fallimento imprevisto dentro uno scenario · una `failure_reason` vuota · il tempo del primo di più eventi dello stesso tipo): prove nuove, terzo giro **118/118**. Le mutazioni sullo stop inghiottito (8) sono rilevate **anche con i due controlli sul sorgente esclusi**: le sole prove di comportamento le vedono tutte.

### Altri risultati

| Prova | Esito |
|---|---|
| `npx tsc --noEmit` · `npm run lint` (0 avvisi) | 0 · 0 |
| `npm test` | **854 prove, 852 passano, 2 falliscono: le stesse 2 preesistenti** (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`); +174 rispetto a `957375d` (680) |
| `npm run test:contracts` · `npm run test:api` | 14/14 · 7/7 |
| `npm run test:security` (database isolato locale `mkw_sectest`) | **1314/1314**, come in S6a.16 (nessun file di `app/ lib/ prisma/ components/` è cambiato; la prova serve a mostrare che nulla si è mosso) |
| Rete rifiutata (preload che rifiuta e registra ogni tentativo; `fetch` fallisce in modo asincrono come uno vero) | i due file di prova dello script, **291/291**; **0 tentativi** di rete (resta solo il canale locale del caricatore `tsx`); il controllo negativo registra i 3 tentativi che gli faccio fare verso un indirizzo riservato `.invalid` (`fetch`, `https.get`, `net.connect`), quindi la guardia vede |
| Perimetro | `git diff`: solo `scripts/stripe-test-mode-verify.ts`, `docs/STRIPE-TEST-MODE-S6.md`, i documenti di registrazione e il file di prova nuovo; nessun file di `app/ lib/ components/ prisma/` |

Log conservati fuori dal repository.

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **AR-2 non è stato eseguito, e non è dichiarato superato.** Tutto ciò che si è provato è il comportamento dello **script** contro un Stripe **finto**: i risultati «confermati» del finto sono **simulati**. Stripe vero può rispondere diversamente: in quel caso i fatti diventano `not_confirmable` o `contradicted` e il rapporto lo mostra.
- **T14A, T14B, T16A, T16B, T13B e T19 sono aperti.** La riga 1.44 della checklist **resta Bloccante** (sezioni 1.44a–1.44d); nulla è passato a «superata».
- **Non osservabile con questi metodi:** tempi e frequenza dei rimborsi in produzione (fallimenti lato banca fino a ~30 giorni, `pending` fino a 45: documentazione pubblica); `requires_action` e `canceled`; un `pending` per saldo insufficiente; la commissione reale di una contestazione.
- **La finestra è di 10 minuti per scenario.** Se Stripe impiega di più, il fatto è `not_confirmable` (e il rapporto lo dice): una seconda esecuzione con finestra più lunga sarebbe una tua decisione.
- **Gli eventi si leggono in una sola pagina (fino a 100)** e si ripete la lettura una volta dopo 10 secondi: un account di prova molto trafficato potrebbe nascondere gli eventi cercati (`not_confirmable`, mai una contraddizione).
- **Permessi della chiave:** i nomi esatti nel Dashboard non sono verificati; un permesso mancante rende `not_confirmable` ciò che ne dipende.
- **Windows:** il permesso `0600` non è imposto dal sistema; la cartella del rapporto deve stare nel profilo utente (v. guida, sezione 11.7).
- **Documenti precedenti** (`docs/CHECKOUT-S2-S3.md`, `docs/PROGETTO.md`, `docs/RILASCIO-PRODUZIONE.md`, S6a.11–S6a.15 di questo file) che dicono «T1–T18 mai verificati» o «mai eseguito» descrivono il momento in cui furono scritti e non sono stati riscritti: lo stato attuale è nella checklist (1.44a–1.44d) e in questa sezione.
- Il profilo di AR-2 usa i numeri **autorizzati** (2 pagamenti, 2 rimborsi da 0.20, 1 endpoint, 120 chiamate, 25 minuti, 10 minuti per scenario); non è stato aggiustato per far quadrare le prove.

### Come riprodurre
`node --test --import tsx tests/stripe-test-mode-verify-ar2.test.ts tests/stripe-test-mode-verify.test.ts` · `npx tsc --noEmit` · `npm run lint` · `npm test` · `npx tsx scripts/stripe-test-mode-verify.ts --protocol ar2 --dry-run` (nessuna rete, nessuna chiave). Eseguirlo **per davvero** richiede una chiave di prova del titolare e una nuova autorizzazione esplicita.

## S6a.18 Il secondo collaudo reale: AR-2 eseguito in Test Mode, rapporto valutato (6 fatti confermati su 6)

**Ambito.** «Chiusura documentale SP1 + AR-2» (modalità AUTO, impegno HIGH): **solo** la registrazione dei risultati. Partenza: `76236d9`. Perimetro toccato: questo documento, `docs/CHECKLIST-PRELANCIO.md` (righe 1.44a–1.44d) e `docs/STRIPE-TEST-MODE-S6.md` (stato di AR-2 e sezione 11.11). **Nessuna** modifica a `app/`, `lib/`, `components/`, `prisma/`, `scripts/`, `tests/`, dipendenze o configurazioni; **nessuna** chiamata a Stripe, nessuna nuova esecuzione, nessuna chiave. Le sezioni precedenti (S6a.11–S6a.17) sono **storiche e non sono state riscritte**: quando dicono che AR-2 «non è mai stato eseguito» o «è aperto» descrivono il momento in cui furono scritte; lo stato attuale è qui e nella checklist.

**Fonte e cautele.** Il rapporto JSON prodotto dallo script in Stripe Test Mode, archiviato dal titolare **fuori dal repository**, è stato analizzato in modo indipendente. Qui compaiono **solo fatti aggregati**: nessun rapporto completo, nessun identificativo di Stripe (`pi_`, `re_`, `we_`…), nessuna chiave, nessun URL di ricevuta, nessun dato personale. È evidenza **osservata in una sandbox** con API reali di Stripe in Test Mode: **non** una simulazione offline e **non** una prova in modalità Live.

### SP1 — prima esecuzione (invariata, vedi S6a.17)

Esecuzione `a9488563`: 15 fatti confermati, 0 contraddetti, 3 non confermabili (T6, T14, T16). T14 e T16 erano non confermabili per i limiti del primo protocollo e sono stati approfonditi con AR-2 (sotto). T6 resta non osservato e richiede un'accettazione per costruzione. **Non risulta registrata alcuna accettazione formale scritta del titolare per SP1** e nessuna è qui supposta.

### AR-2 — seconda esecuzione

| | |
|---|---|
| Esecuzione | `685b014d` · protocollo `ar2` |
| Data · avvio · fine | 21 ottobre 2026 · `09:18:58.374Z` · `09:24:16.375Z` (UTC) |
| Versione API | `2025-10-29.clover` |
| Esito | **6 confirmed · 0 contradicted · 0 not_confirmable** |
| Arresto | `aborted: null` · `livemodeSeen: false` |
| Uso | **51 chiamate su 120**, tutte riuscite · 317999 ms (circa 5 minuti e 18 secondi) su 25 minuti |
| Oggetti creati | 2 PaymentIntent da 1,00 · 2 rimborsi da 0,20 · 1 endpoint webhook temporaneo, eliminato correttamente · **nessun** Customer, Product, Price, Invoice o Checkout Session |
| Restano nella sandbox | i due pagamenti riusciti e i rimborsi di prova (non eliminabili) |
| Chiave | **dichiarazione del titolare**: rimossa dall'ambiente PowerShell e revocata nel Dashboard la chiave temporanea. Non è una verifica dello script |

I numeri sono dentro il profilo di AR-2 (2 pagamenti, 2,00 in tutto, 2 rimborsi ≤ 0,20, 1 endpoint, 120 chiamate, 25 minuti, 10 minuti per scenario): nulla è stato aggiustato per farli quadrare.

### I sei fatti

| Fatto | Esito | Che cosa è stato osservato |
|---|---|---|
| **T13B** | confermato | Stripe ha accettato la sottoscrizione a `refund.created`, `refund.updated`, `refund.failed`. Verificata la **sottoscrivibilità**; **non** la consegna HTTP al webhook applicativo di produzione |
| **T14A** (`pm_card_pendingRefund`) | confermato | Stato iniziale `pending`, finale `succeeded`; ultimo `pending` letto a 120 s, primo `succeeded` a 150 s; il PaymentIntent è rimasto `succeeded`; `pending_reason: insufficient_funds`; transazione di saldo del rimborso `amount -20`, `fee 0`, `net -20`, EUR (sandbox) |
| **T16A** | confermato | Durante `pending` `amount_refunded` = 20 centesimi; dopo `succeeded` = 20. Due letture stabili e concordanti per stato, a più di 5 secondi l'una dall'altra. **Fatto rilevante: `amount_refunded` può includere un rimborso ancora `pending`** |
| **T14B** (`pm_card_refundFail`) | confermato | Stato iniziale `succeeded`, finale `failed`; ultimo `succeeded` a 120 s, primo `failed` a 150 s; il PaymentIntent è rimasto `succeeded`; `failure_reason: expired_or_canceled_card`; transazione di saldo del rimborso `-20 / fee 0 / net -20`, del fallimento `+20 / fee 0 / net +20`, in EUR (sandbox) |
| **T16B** | confermato | Con rimborso `succeeded` `amount_refunded` = 20; dopo `failed` = 0; differenza **-20**. Due letture stabili e concordanti per stato, a più di 5 secondi. **Un rimborso inizialmente riuscito può fallire dopo e l'importo rimborsato può diminuire** |
| **T19** | confermato | Eventi **generati** (tempi circa, dalla creazione del rimborso). **A:** `refund.created` 1 s, `charge.refunded` 1 s, `refund.updated` 122 s, `charge.refund.updated` 122 s. **B:** `refund.created` 0 s, `charge.refunded` 0 s, `refund.updated` 125 s, `refund.failed` 129 s, `charge.refund.updated` osservato due volte |

**Letture da tenere distinte.**
- **`charge.refunded` compare anche nello scenario B**, che fallisce dopo: l'evento **non è da solo prova di un successo definitivo** del rimborso.
- Gli eventi sono stati osservati **nell'elenco degli eventi di Stripe** (generazione); la **consegna** a un endpoint applicativo **non è stata dimostrata** da questo collaudo.
- Le letture a 120 e 150 secondi sono i punti del calendario di osservazione: la transizione è avvenuta **tra** i due, e gli eventi la collocano attorno ai 122–129 secondi. Nessun tempo è una garanzia: sono osservazioni di una sandbox, con importi e comportamenti **di prova**.
- `pending_reason: insufficient_funds` è il valore del campo riportato dalla sandbox per il metodo A. S6a.17 diceva che un `pending` per saldo insufficiente non era osservabile con questi metodi: resta vero che **non è stato osservato un saldo realmente insufficiente**; è stato osservato il valore del campo.
- Gli stati osservati sono `pending`, `succeeded`, `failed`. **`requires_action` e `canceled` non sono stati osservati.**

### Che cosa cambia e che cosa no

- **Cambia:** T14, T16 (SP1, non confermabili per come erano definiti) sono ora **osservati** nei loro sostituti T14A, T14B, T16A, T16B; T13B e T19 non erano mai stati chiesti. L'evidenza **sperimentale** richiesta da AR-2 è completa.
- **Non cambia:** nulla è dichiarato valido in produzione; T6, `requires_action` e `canceled` restano **accettazioni per costruzione non ancora approvate per iscritto**; **l'applicazione non sottoscrive ancora `refund.*`** né gestisce questi eventi (restano da sviluppare e verificare la sottoscrizione dell'endpoint di produzione e la gestione effettiva dei webhook); nessun pacchetto (P1, P3, P4, P5, S6b) è stato avviato o autorizzato da questa registrazione.
- **Non è stata inventata alcuna approvazione scritta** del titolare, né per SP1 né per AR-2.

### Stato delle righe della checklist dopo questo aggiornamento

| Riga | Stato |
|---|---|
| 1.44a | SP1 osservato in sandbox (`a9488563`). Accettazione formale del titolare e requisiti di archiviazione ancora da completare (non documentati) |
| 1.44b | AR-2 **eseguito**, 6 fatti confermati: evidenza sperimentale completa. Nessuna accettazione scritta distinta registrata |
| 1.44c | T6, `requires_action`, `canceled`: accettazioni per costruzione **non ancora approvate** formalmente |
| 1.44d | T13B e T19 confermati in sandbox; restano da sviluppare e verificare la sottoscrizione applicativa e la gestione dei webhook |

La riga **1.44 nel suo insieme non è dichiarata superata** e la readiness produttiva non è dichiarata completata.

### Limiti e cose NON chiuse

- **Sandbox, non Live.** Tempi, frequenza e comportamento dei rimborsi con carte e banche vere (documentazione pubblica: fallimenti lato banca fino a circa 30 giorni, `pending` fino a 45) non sono osservati. Le differenze test/produzione restano da annotare in checklist.
- **Una sola esecuzione**, una sola finestra di 10 minuti per scenario: una transizione diversa o più lenta non sarebbe stata vista.
- **Consegna degli eventi non dimostrata**; sottoscrizione dell'endpoint di produzione ai tipi `refund.*` **non fatta**; gestione applicativa degli eventi **non scritta**.
- **Il rapporto completo resta fuori dal repository**, nella cartella privata del titolare: questa sezione non lo sostituisce come archivio. Il requisito di archiviazione di 1.44a non è per questo soddisfatto.
- Tutto il resto dei limiti di S6a.17 (permessi del Dashboard non verificati, permesso `0600` non imposto da Windows, eventi letti in una sola pagina da 100) **resta valido**.

### Come riprodurre
Non si riproduce da qui: servirebbe una chiave di prova del titolare e una **nuova autorizzazione esplicita**. Per rileggere il protocollo: `docs/STRIPE-TEST-MODE-S6.md` sezione 11 (e 11.11 per l'esito).

## S6a.19 P1: il modello finanziario dei fondi (`lib/payment-hold-evidence.ts`), scritto e provato in isolamento

**Ambito.** «S6 / Pacchetto P1» (modalità AUTO, impegno MAX): **solo** una funzione pura che, a partire da prove già lette da Stripe, dice quanto del denaro incassato per **un** pagamento risulta ancora trattenuto e **con quale certezza**. Partenza: `4b13b47`. Perimetro toccato: `lib/payment-hold-evidence.ts` (nuovo), `tests/payment-hold-evidence.test.ts` (nuovo) e questo documento. **Nessuna** modifica ad altre funzioni, rotte, `prisma/`, `scripts/`, `components/`, configurazioni o dipendenze; **nessuna** chiamata a Stripe (nemmeno in Test Mode) e nessuna chiave; nessun intervento su checkout, prezzi, sessioni ospite, webhook, rotte amministrative, Vercel o database. **P1 non è collegato a nulla**: né a `payment-hold`, né a `payment-sync`, né a `releaseDecision`, né a rotte, webhook o interfaccia; nessun file di `app/`, `lib/`, `components/`, `scripts/`, `prisma/` ne nomina il modulo (lo verifica un test). Non sono avviati P3, P4, P5, S6b, AP-PRIV, AP-ESC. Le righe 1.44a–1.44d e il resto della checklist **non sono toccati** e nessun rischio di 1.44a–1.44d è accettato da questo pacchetto. Le sezioni S6a.11–S6a.18 sono storiche e non sono state riscritte.

**Fonte e cautele.** I fatti osservati sono quelli già registrati in S6a.17 e S6a.18 (nessun identificativo di Stripe qui). Le fixture del file di test sono **costruite** sul modello dei due collaudi in Test Mode e della documentazione pubblica di Stripe: **non** sono risposte di Stripe, **non** sono prese dal rapporto del primo collaudo (non disponibile a questo pacchetto) e **nessun** test chiama Stripe. Test Mode non è presentato come Live.

### Che cosa fa

```ts
computeFundsPosition(evidence: FundsEvidence): FundsPosition        // la funzione
retainedAtLeast(position, amountCents): 'yes' | 'no' | 'unknown'    // «almeno X centesimi sono trattenuti?»
retainedIsZero(position): 'yes' | 'no' | 'unknown'                  // «non è trattenuto nulla?»
FUNDS_FINDING_CODES                                                 // i 42 codici che il modello può dire, e di che tipo sono
```

- **Ingresso** (tipi strutturali con i nomi dell'SDK: un `Stripe.PaymentIntent`, `Charge`, `Refund`, `Dispute`, `BalanceTransaction` o `ApiList` si passa così com'è; lo verifica la compilazione): il PaymentIntent, l'addebito, l'elenco dei rimborsi, l'elenco delle contestazioni con le **transazioni di saldo espanse** e, facoltativo, `requestedRefunds`: i rimborsi che l'applicazione ha chiesto e che Stripe non elenca (ancora). Quest'ultimo è un'**intenzione** passata da chi chiama, non un oggetto di Stripe.
- **Uscita**: centesimi **interi** (nessun numero in virgola mobile; ogni numero dell'uscita è un intero sicuro e non è mai `-0`). Non legge database, orologio, ambiente o rete, non modifica ciò che riceve e non ne conserva riferimenti; non ha stato tra una chiamata e l'altra; l'ordine degli elenchi non cambia il risultato.
  - `certainty`: **`proven`** (nessuna incertezza e nessuna contraddizione: le due letture coincidono e `retainedCents` è l'unico numero) o **`uncertain`**.
  - `retainedLowerCents` / `retainedUpperCents`: il trattenuto **almeno** (ogni cosa incerta nella lettura peggiore) e **al più** (ogni cosa incerta nella lettura migliore); `retainedUpperCents: null` = nessun limite superiore noto (denaro che può ancora arrivare o importo incassato non noto). Un conflitto (prove contraddittorie, di un altro pagamento, non valide) dà l'intervallo **più largo**: da 0 all'incassato.
  - `final`: provata **e** nessun rimborso riuscito che possa ancora fallire. `provisionalRefundCents`: i rimborsi riusciti che contano ora ma non sono definitivi.
  - `overRecoveredCents`: il cliente ha recuperato più di quanto ha pagato (rimborsi e ritiri insieme): segnalato, **mai** un capitale negativo.
  - `refunds`, `disputes`, `fees`: i componenti, tenuti separati; `findings`: ciò che il modello dice, di quattro tipi — **incertezza** e **conflitto** rendono la posizione incerta; **anomalia** (`over_recovered`) e **nota** (`duplicate_removed`, `state_not_observed`) non la rendono incerta.
- **Le due domande** non concludono mai da una posizione incerta: «`retainedIsZero` = `yes`» solo per una posizione **provata** con lettura migliore pari a zero; «`retainedAtLeast` = `yes`» solo se anche la lettura peggiore lo trattiene; una posizione malformata o un importo non valido danno `unknown`.

### Le tre cose tenute separate

| | Regola |
|---|---|
| **Capitale** | Incassato = `amount_received` di un PaymentIntent `succeeded`. Esce per i **rimborsi** (l'importo del rimborso) e per le **contestazioni** (l'importo **realmente ritirato**, meno quanto **reintegrato**). Si leggono gli importi **lordi** (`amount`) delle transazioni di saldo: **mai `net`** (il `net` è solo controllato: se c'è deve essere `amount − fee`). |
| **Commissioni** | La `fee` di una transazione di saldo (di contestazione o di rimborso) è riportata a parte in `fees` e **non tocca mai il capitale**, qualunque sia la sua entità (SP1: ritiro −100, commissione 2000, `net` −2100 su un pagamento di 1,00 → capitale 0, commissione 2000). Nel codice **non compare alcun importo di commissione**; `fees.complete` dice se ogni movimento che poteva portarne una è stato letto. |
| **Incertezza** | Ciò che le prove non stabiliscono è **detto, non indovinato**: un elenco non letto non è un elenco vuoto; uno stato non modellato non è innocuo; «vinta» non è «fondi reintegrati»; «persa» e «chiusa» non sono «ritirati»; un addebito «contestato» non è una contestazione; un id non espanso non è un movimento visto. |

`Charge.amount_refunded` è un **segnale**, mai un addendo e mai la prova dello stato di un singolo rimborso (AR-2: conta già un rimborso `pending` e **scende** quando un rimborso riuscito fallisce): si confronta con i rimborsi elencati; il caso peggiore prende il numero più grande, il migliore il più piccolo. Lo stesso rimborso non è mai contato due volte (come rimborso elencato, come movimento, nell'aggregato, come richiesta): rimborsi e movimenti si identificano per **id**, mai perché si somigliano.

### Casi principali coperti (ogni riga è un test; importi di prova)

| Caso | Posizione |
|---|---|
| Pagamento verificato 1,00, nulla rimborsato o contestato | **provata** 100/100, `final` |
| Incasso parziale (60 su 100); valuta in maiuscolo | provata 60; valuta `eur` |
| Rimborso parziale 0,30 / due rimborsi / totale riusciti | provata 70 / 50 / **0** — ma **provvisoria**, non `final` (un rimborso riuscito può fallire) |
| Più rimborsato che incassato (120 su 100) | provata 0 + anomalia `over_recovered` (20); mai negativo |
| **AR-2 A**: rimborso `pending` già contato in `amount_refunded` (20/20) | **incerta** [80, 100], contato **una volta**; dopo `succeeded`: provata 80 |
| **AR-2 B**: riuscito (20) poi `failed`, `amount_refunded` 20 → 0, −20 / +20, commissione 0 | prima provata 80; dopo provata **100**, `final`; la posizione non ha memoria: l'importo può **scendere** |
| `failed` con debito e senza storno / con id non letti | incerta [80, 100] |
| `failed` senza alcuna transazione; `canceled` senza transazione | `failed`: nulla uscito (provata 100); `canceled` (mai osservato): **incerta**, nota `state_not_observed` |
| Storno ≠ debito (+15, +25, negativo), storno senza debito, `net` ≠ `amount − fee` | **conflitto**: [0, incassato] |
| Aggregato 20 + rimborso elencato 20 | 20, non 40; aggregato maggiore dei rimborsi (50 su 20) → [50, 80], non 70 |
| Contestazione **persa** 1,00 con commissione 20,00 (SP1) | **provata 0**, commissione 2000 a parte; stesso capitale con commissione 0, 1, 1500, 4500, 123456 |
| Contestazione **aperta** (`needs_response`, `under_review`, `warning_*`) | incerta [0, 100]: ritirata ora, può tornare |
| **Vinta** con ritiro **e** reintegro (commissione non restituita) | **provata 100**, commissione 2000 a parte |
| Vinta **senza** reintegro / con reintegro parziale (40 su 100) / senza movimenti | incerta [0, 100] / [40, 100] / [0, 100] |
| Persa **senza** ritiro / ritiro parziale (60 su 100) / movimenti non letti o solo id | incerta [0, 100] / [0, 40] / [0, 100] |
| Più ritirato che contestato; persa con reintegro; reintegro maggiore del ritiro | **conflitto** |
| Stato di contestazione mai visto (`warning_closed`, `prevented`, altri; maiuscolo) | incerta, «non modellato», mai innocuo |
| `Charge.disputed` vero senza contestazione / falso con contestazione | incerta / **conflitto**; il flag da solo non decide |
| Elenco dei rimborsi o delle contestazioni non letto, incompleto (`has_more`) o senza `has_more` | incerta [0, incassato]: ciò che non è stato letto non è «nulla» |
| Addebito non letto; totale rimborsato o flag `disputed` mancanti | incerta |
| Oggetto di un altro pagamento o di un altro addebito; oggetto che non nomina né l'uno né l'altro; movimento di un altro oggetto | **conflitto**, messo da parte e mai contato |
| Valuta diversa, non valida o mancante; importo non intero, negativo, zero, non numero, oltre i numeri sicuri; somma che esce dai numeri sicuri | **conflitto** (nessuna conversione, nessun arrotondamento: la somma si ferma al massimo intero sicuro) |
| Identificatori malformati; id usato da due oggetti; stesso id descritto in due modi | **conflitto** |
| Doppioni identici (rimborso, contestazione, movimento); due rimborsi diversi di pari importo | contati una volta, con nota / **due** rimborsi (nulla si fonde per somiglianza) |
| Rimborso **chiesto** e non elencato; chiesto e poi elencato (`pending` o `succeeded`) | incerta, caso peggiore / contato **una volta** |
| Stato di rimborso sconosciuto (anche in maiuscolo, vuoto, numero) | incerta, caso peggiore, nulla concesso |
| Prove illeggibili (un getter che lancia), non oggetto, nulla | mai un'eccezione: posizione **incerta** più larga; senza il pagamento: `payment_intent_missing` |

### Osservato, prudenza e ipotesi (tre cose distinte)

- **Osservato in Test Mode** (S6a.17, S6a.18): un rimborso `pending` è già in `amount_refunded`; un rimborso riuscito può fallire e `amount_refunded` torna a 0 (−20 / +20, commissione 0); una contestazione ritira l'importo contestato con una commissione **a parte** (ritiro −100, commissione 2000, `net` −2100); una vinta reintegra l'importo e la commissione non è restituita; `Charge.disputed` resta vero dopo la vittoria.
- **Prudenza del progetto, non osservazione**: stati di rimborso `requires_action` e `canceled` (mai visti: nota `state_not_observed`, mai dichiarati verificati); stati di contestazione `warning_*` e `prevented` (mai visti); i valori di `reporting_category` dei movimenti di una contestazione, `dispute` (ritiro, negativo) e `dispute_reversal` (reintegro, positivo), presi dalla documentazione pubblica di Stripe perché il rapporto sanificato del primo collaudo non era disponibile a questo pacchetto; «un rimborso `failed` senza alcuna transazione non ha mosso denaro».
- **Ipotesi da accettare formalmente** (nessuna è stata accettata da questo pacchetto): v. «Limiti e cose NON chiuse».

### Prove rosso → verde

- **Rosso.** Il file di prova (374 test, gruppi 1–15 della consegna) è stato scritto **per primo**; senza il modulo: **372 falliti su 374** — 371 con `ERR_MODULE_NOT_FOUND`, 1 (la scansione di purezza) con `ENOENT` — e **2 passati per costruzione**: la guardia «P1 non è collegato» (deve valere prima e dopo) e la prova di assegnabilità degli oggetti dell'SDK, la cui prova è la compilazione. Il modulo è caricato in modo pigro, così ogni test fallisce da solo. Log: `38-red-p1.txt` (fuori dal repository).
- **Verde, con correzioni dichiarate.** Alla prima esecuzione con il modulo: **368 su 374**. I 6 falliti erano: **3 test che rivelavano 2 difetti del modello** (un importo ricevuto negativo produceva anche `charge_mismatch`; una contestazione di importo negativo o zero produceva anche `dispute_amounts_inconsistent`), corretti nel modulo **senza cambiare le attese**; **2 test per un errore della fixture** (`list(data, undefined)` prendeva il valore predefinito `false`, quindi non ometteva mai `has_more`) e **1 per uno scenario sbagliato** (`state_not_observed` era costruito con un rimborso anche in corso, quindi non poteva essere «solo la nota»), corretti nel test. Poi 374/374. Nessuna attesa dei requisiti è stata allentata.
- **Rinforzo dopo le passate di mutazioni** (v. sotto): 374 → **505 test** (+131) e invarianti più forti per ogni posizione, **senza modificare il modulo** (il modulo ha avuto soltanto le tre correzioni di sopra e un commento riscritto). Anche il file finale, senza il modulo (copia di lavoro senza `lib/payment-hold-evidence.ts`), fallisce quasi interamente: **503 su 505**; i 2 passati per costruzione sono gli stessi. Log: `65-red-final-file-without-module.txt`.

### Che cosa provano i 505 test

- Tabelle di casi (parametrizzate) per ogni area della consegna (1–15), con **uscita esatta** per il caso base e codici esatti per gli altri.
- **Proprietà su mondi generati** (generatore con seme: un fallimento si riproduce): **38 test**. Mondi completi e coerenti: la posizione è esattamente incassato − rimborsato − perso, con pavimento a zero (300 mondi); le commissioni non cambiano capitale, limiti, certezza né segnalazioni (300); un doppione identico cambia solo una nota (300); più denaro in uscita non alza mai un limite (300); **prove che peggiorano** (13 peggioramenti × 300 mondi) non migliorano mai la posizione: il limite inferiore non sale, quello superiore non scende, una posizione provata diventa incerta, nulla diventa `final` e «zero» non viene affermato; un **oracolo indipendente** che calcola l'intervallo e i codici con la sola aritmetica dalle letture peggiore e migliore di ogni parte incerta (400 mondi); un catalogo di **19 contraddizioni iniettate** in mondi provati (19 × 300) che devono essere nominate e dare l'intervallo più largo; 600 mondi casuali, metà corrotti con valori sbagliati, che devono dare una posizione ben formata, ripetibile, indipendente dall'ordine e senza eccezioni. Ogni posizione di ogni test rispetta le stesse invarianti (limiti ordinati, numeri sicuri, riassunto = somma degli elementi, nulla messo da parte senza una parola, conflitto = intervallo più largo, le due domande coerenti con i limiti).
- **Purezza**: la scansione del sorgente (senza commenti) vieta import, orologio, casualità, ambiente, rete, disco, asincronia, uscite, arrotondamenti e stato tra le chiamate; la superficie pubblica è fissa (4 nomi); input congelato, input non modificato, nessun riferimento conservato; determinismo con altre prove in mezzo; ordine degli elenchi irrilevante.
- **Non collegato**: nessun file di `app/`, `lib/`, `components/`, `scripts/`, `prisma/` o della radice nomina il modulo; i sei moduli che oggi decidono (`payment-hold`, `payment-sync`, `order-payment-policy`, `production-release`, `payment-verification`, `stripe-webhook`) non lo conoscono.

### Mutazioni (su una copia fuori dal repository, una per volta, ripristino verificato)

Tutte su una copia fuori dal repository, una per volta, con ripristino verificato a fine passata; «rilevata» = il file di test fallisce (o non termina). Un'ancora che non compare esattamente una volta lascia la mutazione «non applicata»: **0** in ogni passata. Le mutazioni sono scritte a mano (più 84 generate dalla tabella dei codici: per ognuno dei 42 il tipo cambiato e il testo svuotato): non esauriscono i difetti possibili e non provano l'assenza di errori; provano che i difetti messi alla prova sono visti.

| Passata | File di test | Mutazioni | Rilevate | Sopravvissute | Non applicate |
|---|---|---:|---:|---:|---:|
| 1 | 374 test | 280 | 233 | **47** | 0 |
| 2 | 494 test | 381 | 378 | **3** | 0 |
| 3 | 496 test | 409 | 402 | **7** | 0 |
| sonda (31 scelte: le nuove e le sopravvissute) | 505 test | 31 | 30 | 1 | 0 |
| **finale (file definitivi)** | **505 test** | **435** | **432** | **3** | **0** |

Una passata avviata prima della correzione di un commento del file di test fu interrotta dopo 37 mutazioni e **non è contata**. Nella passata finale una prova (`TK invalid_currency`) si è bloccata per un'anomalia del runner dei test (un processo fermo a CPU piena, la stessa mutazione riprodotta a parte termina in 1,7 s): l'ho terminata a mano, il suo esito automatico («rilevata», senza conteggio dei test falliti) **non è un verdetto** e l'ho sostituito con una riesecuzione isolata: **rilevata, 50 test su 505 falliti** (`62-mutation-rerun.txt`).

**Che cosa hanno mostrato le sopravvissute (e che cosa è stato fatto).**
- *Prima passata, 47:* regole che nessun test custodiva — il limite superiore dei pagamenti non ancora pagati e gli stati del pagamento in maiuscolo o non testuali (3); riferimenti e identità malformati, addebito non letto, importo catturato non valido (7); forma dei movimenti di un rimborso (4) e valore a cui si ferma una somma fuori dai numeri sicuri (1); la forma canonica con cui si riconosce un doppione, campo per campo (8); segno del debito e commissione dello storno di un rimborso (2); i bordi del confronto con l'aggregato (3); dispute messe da parte, id malformati, stato in maiuscolo (5); intervallo con denaro ancora in arrivo, recupero eccessivo, ordine delle segnalazioni (4); completezza delle commissioni (3); le due domande su posizioni malformate (2); le commissioni di un oggetto non letto (1); modifica degli ingressi (2); e **3 equivalenti**. Risposta: **+120 test** (tabelle dei casi mancanti, singolo campo che cambia in un doppione, bordi, proprietà più forti) e invarianti più forti per ogni posizione.
- *Seconda passata, 3:* due equivalenti e una lacuna (se addebito e pagamento non concordano sull'ultimo addebito, i rimborsi si giudicano contro l'addebito letto): test aggiunto.
- *Terza passata, 7:* tre equivalenti e quattro lacune (un oggetto in un'altra valuta va messo da parte; i campi dei singoli elementi elencati: importo, stato): test aggiunti.
- *Passata finale:* **3 sopravvissute, tutte equivalenti** (sotto).

Mutazioni della passata finale per area: pagamento e incassato 16 · valute 12 · identità e riferimenti 23 · transazioni di saldo 16 · centesimi interi 6 · identificatori e testo 8 · elenchi, doppioni e ordine 27 · stati dei rimborsi 31 · aggregato 25 · rimborsi chiesti 12 · contestazioni 63 · intervallo e uscita 43 · commissioni 20 · le due domande 10 · robustezza 7 · tabella dei codici 93 · purezza 9 · altre 14.

### Altri risultati

- `npx tsc --noEmit`: **0 errori**. Il file di prova compila contro i tipi dell'SDK: `Stripe.PaymentIntent`, `Charge`, `Refund`, `Dispute`, `BalanceTransaction` e `ApiList` sono assegnabili ai tipi di ingresso **senza cast**.
- `npm run lint` (`--max-warnings=0`): **0 avvisi**.
- `npm test`: **1454 test, 1452 verdi**; falliscono **soltanto i 2 preesistenti** — `global layout includes r3Dr parent-company branding` e `resolveSiblingRepoPath resolves suite repos beside MakerWorks` — non toccati e non usati per nascondere nulla. Prima del pacchetto: 949 test (947 verdi). `tests/production-release-guards.test.ts`: 18/18 (le guardie statiche non vedono nulla di nuovo da esaminare).
- **Rete rifiutata:** il file di prova eseguito con ogni connessione di rete (TCP, DNS, `fetch`, `http`/`https`) rifiutata e registrata: **505/505, 0 tentativi** (solo la pipe locale del caricatore `tsx`); il controllo negativo verso un host `.invalid` registra i suoi 3 tentativi. Nessuna variabile `STRIPE_*` e nessuna chiave.
- `test:security` (richiede un database) **non rieseguito**: nulla sotto `app/`, `prisma/`, `components/` o degli altri file di `lib/` è cambiato (`git diff --stat`: un solo file modificato, questo documento, più i due file nuovi).

### Limiti e cose NON chiuse (nessuna presentata come risolta)

**Perché P1 non può ancora essere usato per decisioni operative.**
- **Non è collegato** e non esiste lo strato che legge Stripe con le espansioni giuste (`latest_charge`, rimborsi con `balance_transaction` e `failure_balance_transaction`, contestazioni con `balance_transactions`, tutte le pagine): sta a chi chiama, e non è scritto (P3). Una lettura incompleta rende la posizione incerta, non sbagliata, ma questo strato non c'è.
- È un'**istantanea**: non sa di rimborsi in corso che Stripe non elenca ancora; li conosce solo se chi chiama li passa in `requestedRefunds`. Non ha memoria né revisione; il confronto con la revisione finanziaria dell'ordine e il blocco sotto lucchetto appartengono ai pacchetti successivi.
- **Non decide**: le soglie delle decisioni (rilascio, `accepted`, `no_charge`) non sono definite qui; `retainedAtLeast` e `retainedIsZero` sono mattoni, non verdetti. Nessuna decisione è stata derivata da questo modello.
- Le fixture sono **costruite**; il modello non è stato confrontato con oggetti reali di Stripe, né con il rapporto sanificato del primo collaudo.

**Ipotesi ancora aperte (da accettare o verificare formalmente).**
1. I valori di `reporting_category` `dispute` / `dispute_reversal`: con altri valori (o con movimenti aggiuntivi di altre categorie, per esempio una commissione registrata a parte) il modello dice `unrecognized_movement` (conflitto, intervallo più largo) invece di indovinare — sicuro, ma inutilizzabile finché non si confronta con il rapporto reale.
2. Rimborso `failed` senza alcuna transazione di saldo = nulla è uscito (non osservato: AR-2 B mostrava entrambe le transazioni); un `canceled` senza transazioni resta incerto.
3. Il comportamento di `requires_action`, `canceled` (rimborsi) e di `warning_*`, `prevented` (contestazioni), mai osservati.
4. La semantica di `amount_refunded` (conta un `pending`; scende dopo un fallimento) è osservata in Test Mode con due metodi di prova, non con carte e banche vere.
5. Più contestazioni sullo stesso addebito sono sommate senza controllare che la somma stia nell'incassato (si segnala `over_recovered`); una contestazione di un addebito già rimborsato in parte è segnalata come recupero eccessivo, non risolta.
6. Pagamenti con valuta di regolamento diversa da quella dell'addebito (le transazioni di saldo sono nella valuta di regolamento): il modello **non converte** e dice `currency_mismatch`. Non coperti: PayPal, fatture Stripe, commissioni di applicazione, Connect, pagamenti non a carta.
7. Una commissione negativa o un `net` assente/incoerente: negativa o incoerente = conflitto; assente = commissione ignota (il capitale non ne dipende; `fees.complete` è falso).

**Mutazioni equivalenti** (non rilevabili per costruzione, dichiarate): tre, tutte riconosciute leggendo il codice e **non** nascoste da un test che le ucciderebbe per caso.
- **Q09** — per un rimborso chiesto, leggere un importo mancante come `0` (`cents(entry.amount ?? 0)`): un importo mancante e un importo zero sono entrambi non validi e danno lo stesso codice (`invalid_amount`) e la stessa esclusione.
- **B13** — dare `retainedCents` senza la condizione `lower === upper`: una posizione **provata** ha sempre i due limiti uguali (senza incertezze la lettura peggiore e la migliore coincidono); la condizione è una difesa, e l'invariante «provata ⇒ limiti uguali» è verificata su ogni posizione generata.
- **A25** — non impostare `sound = false` nel controllo dell'importo di una contestazione: la guardia che segue (importo mancante o ≤ 0) mette già da parte la contestazione; la riga è ridondante per costruzione.

### Come riprodurre

`node --test --import tsx tests/payment-hold-evidence.test.ts` (offline, nessuna chiave); `npx tsc --noEmit`; `npm run lint`. Le mutazioni si eseguono su una copia fuori dal repository (non c'è un comando nel progetto). Nessun passo richiede Stripe.

## S6a.20 P1-bis: correzioni dopo l'audit indipendente di P1 (un ID, un rimborso; zero nell'istantanea e zero su cui contare)

**Ambito.** «P1-BIS: correzioni dopo audit indipendente» (modalità AUTO, impegno MAX). Partenza: `ae71c32` (P1, S6a.19). L'audit indipendente di quel commit ha confermato il perimetro e ha individuato **due rischi di comportamento finanziario** da chiudere prima dell'integrazione con P3. Autorizzata **solo** la correzione mirata dei due punti, con TDD rosso → verde. Perimetro toccato: `lib/payment-hold-evidence.ts`, `tests/payment-hold-evidence.test.ts` e questo documento. **Nessuna** chiamata a Stripe (nemmeno in Test Mode) e nessuna chiave; nessun database, nessuna migrazione; nessuna modifica a rotte, checkout, webhook, decisioni applicative, `app/`, `components/`, `scripts/`, `prisma/`, configurazioni o dipendenze. **P1 resta collegato a nulla** (lo verifica il test della sezione 15, invariato). Non sono avviati P3, P4, P5, S6b; i due test storici della suite non sono toccati. Le righe 1.44a–1.44d e la checklist **non sono toccate**; le sezioni S6a.11–S6a.19 sono storiche e non sono state riscritte. Questa sezione **supera** due sole affermazioni di S6a.19: la definizione della domanda «non è trattenuto nulla?» (punto «Le due domande» di «Che cosa fa»: ora richiede anche che la posizione sia definitiva) e il trattamento delle richieste con lo stesso ID (ridotte alla prima, o saltate perché elencate, senza confrontare l'importo).

### I due difetti, e che cosa è cambiato

**A. Un ID nomina un solo rimborso.** In `ae71c32`, una richiesta di `requestedRefunds` (un'intenzione dell'applicazione, non un oggetto di Stripe) che portava l'ID di un rimborso già elencato da Stripe veniva **saltata senza confrontarne l'importo**; più richieste con lo stesso ID venivano **ridotte alla prima** (con la nota `duplicate_removed`) senza verificare che descrivessero la stessa operazione. Conseguenze, entrambe riprodotte dai test rossi: (1) Stripe elenca `re_1` per 20 e l'applicazione ne ha chiesti 80 con lo stesso ID → posizione **provata**, 80 trattenuti, nessuna segnalazione, e «almeno 80 sono trattenuti?» rispondeva **`yes`** su una cifra che una delle due descrizioni smentiva; (2) due richieste con lo stesso ID, 20 e 80 → contava la prima, quindi **il risultato dipendeva dall'ordine dell'elenco** (limite inferiore 80 in un ordine, 20 nell'altro).

*Soluzione* (blocco delle richieste di `readPosition`, nessun codice nuovo di segnalazione: si riusa `conflicting_duplicate`, che resta di tipo *conflitto*; la tabella dei codici è sempre di 42, 26 / 13 / 1 / 2):
- Le richieste **con ID** si raggruppano per ID. Tutte le descrizioni di un ID devono dire la stessa cosa: **stesso importo e stessa valuta** (una valuta non scritta è quella del pagamento: un rimborso è sempre nella valuta del suo pagamento — ipotesi dichiarata). Se differiscono: `conflicting_duplicate` con l'ID, **nessuna** di quelle richieste è contata, e la posizione è l'**intervallo più largo** [0, incassato] (regola già esistente per i conflitti).
- Se Stripe elenca un rimborso con quell'ID (e non è stato messo da parte), **l'elenco di Stripe è il rimborso**: la richiesta che dice lo stesso importo è quel rimborso, contato una volta, in silenzio (come prima); se dice un **altro importo**, è `conflicting_duplicate`. Un rimborso elencato che è stato messo da parte (altro pagamento, altra valuta, importo non valido…) ha già detto perché: la richiesta non aggiunge nulla e non si inventa un secondo conflitto.
- Le richieste si controllano **prima fra loro e poi contro Stripe**: due richieste discordanti sono un conflitto anche se il rimborso elencato è stato messo da parte.
- Richieste **senza ID**: ciascuna è una richiesta a sé (nulla dice che siano lo stesso rimborso), come prima. Gli ID si confrontano **esattamente come scritti** (`re_a` e `RE_A` sono due rimborsi): nulla si fonde perché si somiglia.
- Invariato: richieste identiche per un ID non elencato → **una** richiesta, con la nota `duplicate_removed`; i controlli di forma, importo, ID e valuta di ogni richiesta; il peggior caso per le richieste (contano solo nel limite inferiore).

**B. Zero nell'istantanea non è zero su cui contare.** In `ae71c32` `retainedIsZero()` rispondeva `yes` a una posizione **provata** con limite superiore zero anche se `final` era falso: per esempio un **rimborso totale riuscito** (AR-2 B: un rimborso riuscito può fallire dopo, e allora il capitale torna intero). Una decisione futura **irreversibile** avrebbe poggiato su un rimborso che può ancora fallire.

*Soluzione:* `retainedIsZero()` risponde **`yes` solo** se la posizione è `proven`, il suo limite superiore (quindi la sua cifra, `retainedCents`) è **0** e `final` è **esattamente `true`**; con `final` falso (o non booleano, o mancante) risponde **`unknown`**; resta **`no`** quando anche la lettura peggiore trattiene qualcosa (un rimborso che fallisce può solo restituire denaro, quindi quel `no` non dipende dalla definitività); tutto il resto è `unknown`. Nessuna nuova soglia e nessuna autorizzazione.

*La differenza, in due righe.* **Zero osservato nell'istantanea**: la posizione è provata e vale 0 *adesso* (`retainedCents === 0`), ma può poggiare su un rimborso riuscito (`final: false`, `provisionalRefundCents > 0`). **Zero affidabile per una decisione definitiva**: lo stesso zero **e** `final: true` — pagamento mai incassato (annullato), oppure capitale portato via da contestazioni **perse** con il ritiro mostrato, senza alcun rimborso riuscito che possa ancora fallire. Solo il secondo è un `yes`. La distinzione è scritta nell'intestazione del modulo e nel commento della funzione.

### Prima e dopo (importi di prova, centesimi)

| Caso | Prima (`ae71c32`) | Dopo |
|---|---|---|
| Stripe elenca `re_1` = 20 (riuscito), richiesta `re_1` = 80 | provata, 80 trattenuti, nessuna segnalazione; «almeno 80?» = `yes` | **incerta** [0, 100], conflitto `conflicting_duplicate` (`re_1`), richiesta non contata; «almeno 80?» = `unknown` |
| Stripe elenca `re_1` = 80, richiesta `re_1` = 20 | provata, 20 trattenuti | conflitto, [0, 100] |
| Due richieste `re_1`: 20 e 80 (Stripe non elenca nulla) | [80, 100] con 20 per prima, [20, 100] con 80 per prima | conflitto, [0, 100], **uguale in ogni ordine** |
| Tre richieste `re_1`: 20, 20, 80 (Stripe non elenca nulla); oppure elenco di Stripe 20 con richieste 20 e 80 | contava la prima; le richieste erano saltate perché elencate | conflitto, [0, 100] |
| Elenco di Stripe `pending` / `failed` (denaro tornato) / stato sconosciuto di 20, richiesta 80 | richiesta saltata | conflitto (qualunque sia lo stato del rimborso elencato) |
| Richiesta = rimborso elencato (stesso ID, stesso importo; valuta scritta in minuscolo, in maiuscolo o non scritta; anche ripetuta) | contata una volta | **invariato**: contata una volta, posizione identica a quella senza richieste |
| Richieste identiche per un ID non elencato | una sola, nota `duplicate_removed` | invariato |
| Stesso ID, due valute diverse, valuta del pagamento non utilizzabile | ridotte alla prima, in silenzio | conflitto |
| Rimborso totale **riuscito** (100 su 100): «non è trattenuto nulla?» | `yes` | **`unknown`** (provata 0, ma `final: false`) |
| Lo stesso rimborso dopo il **fallimento** (−100 / +100, AR-2 B) | `no` | `no` (capitale intero, `final: true`) |
| Rimborso parziale riuscito (20 su 100) | `no` | `no` |
| Rimborso riuscito 30 + contestazione persa 70 che insieme portano via tutto | `yes` | `unknown` |
| Contestazione **persa** con il ritiro mostrato per l'intero importo (SP1) | `yes` | **`yes`** (provata, `final: true`) |
| Pagamento annullato, mai incassato | `yes` | `yes` |
| Rimborso totale ancora `pending`, o solo richiesto e non elencato | `unknown` | `unknown` |

### Test: che cosa è cambiato e perché

Il file passa da **505 a 587 test** (+82). Le aspettative scritte prima dell'audit sono rimaste, **tranne due, ciascuna con la sua motivazione nel codice del test**:
1. *Rimborso totale riuscito* (sezione 2): asseriva `retainedIsZero(position) === 'yes'` per una posizione provata con `final: false`. È **esattamente** il comportamento che l'audit chiede di togliere: ora asserisce `unknown` (e che la cifra dell'istantanea sia 0, la posizione `proven`, `final` falso, il provvisorio 100). Il nome del test è cambiato di conseguenza.
2. *Posizioni scritte a mano* (sezione 16): solo il **titolo** («… e, per "non è trattenuto nulla", se è definitiva …»), perché «nulla più» non è più vero; le asserzioni sono invariate, e le posizioni di quel test (copie di un pagamento incassato) sono definitive.

In più, `assertWellFormed` — usata da decine di test e proprietà — ha **due controlli in più** (più severi, non più larghi): una posizione per cui «non è trattenuto nulla?» è `yes` deve essere provata, definitiva e con limite superiore 0 (e una provata a zero risponde `yes` se definitiva, `unknown` se no); una richiesta che viene contata deve essere detta (`refund_requested`). Il catalogo `DEFECTS` delle contraddizioni iniettate guadagna 4 voci (richiesta con un importo di un centesimo in più o in meno rispetto al rimborso elencato; lo stesso rimborso richiesto due volte con due importi; valuta diversa) e `DIRTY_EVIDENCE` (ordine delle liste) una.

*Verifica indipendente di non regressione:* i **505 test originali** di `ae71c32` eseguiti contro il modulo corretto danno **504 verdi e 1 rosso** — proprio il test del rimborso totale, la cui aspettativa è cambiata di proposito. Niente altro di ciò che era provato è cambiato.

### Prove rosso → verde

- **Rosso.** I test furono scritti **per primi**. Contro il modulo di `ae71c32` (invariato) la prima esecuzione diede **585 test, 552 verdi, 33 rossi**; il file finale (587 test) contro lo stesso modulo dà **587 test, 553 verdi, 34 rossi**. I rossi sono: 27 test nuovi di sezione 17 (nome «P1-bis …») — per A, 19: le 11 contraddizioni «un ID, due importi», le 2 riproduzioni, l'ordine delle richieste, lo stesso ID in due valute, la proprietà «importo diverso dal rimborso elencato» su 300 mondi per ciascuno dei due generatori (2), l'oracolo su 400 mondi, l'ordine dei controlli; per B, 8: la riproduzione di AR-2 B con rimborso totale, 5 scenari di zero non definitivo, le posizioni scritte a mano e la proprietà su 600 mondi — e 7 test già esistenti (il rimborso totale con l'aspettativa cambiata; la nuova voce di `DIRTY_EVIDENCE`; le 3 nuove voci di `DEFECTS`; e 2 test esistenti che falliscono solo perché `assertWellFormed` è ora più severa). Motivi dei rossi: per B `expected 'unknown', actual 'yes'`; per A nessun conflitto segnalato, `requestedCents` diverso nei due ordini, «almeno 80» = `yes`. I **30 test della tabella «richiesta coincidente con un rimborso elencato»**, i test su duplicati identici, valuta diversa dal pagamento, rimborso elencato messo da parte, ID in maiuscolo e minuscolo, lo zero di una contestazione persa e di un pagamento annullato **passano anche prima, per costruzione**: custodiscono ciò che non deve cambiare.
- **Verde.** Dopo la correzione: **587/587** (la prima esecuzione, 585/585). Un solo errore mio durante la scrittura dei test, corretto senza toccare il modulo: l'aspettativa del test sugli ID in maiuscolo e minuscolo prevedeva una segnalazione sola, mentre due richieste con ID diversi ne producono due (una per ID).
- Log, fuori dal repository: `02-red-run.txt` (prima esecuzione rossa), `12-red-final.txt` (file finale contro il modulo di `ae71c32`), `03-green-run.txt` e successivi, `04-old-tests-new-module.txt` (i 505 originali contro il modulo corretto).

### Mutazioni (su una copia fuori dal repository, una per volta, ripristino verificato)

Il banco è quello di S6a.19 (435 mutazioni di P1; le sole 3 con ancore in codice riscritto — Q01, Q02, W08 — sono state riscritte con lo stesso significato) più **39 nuove** per i due difetti: il confronto dell'importo con il rimborso elencato (mai; solo se maggiore; solo se minore; solo per alcuni stati del rimborso elencato; anche per uno messo da parte), il confronto fra le richieste (solo importo; solo valuta; solo le prime due; «tutte diverse»; ultima o prima che vince), la segnalazione del conflitto (assente, senza ID, richiesta contata lo stesso), l'ordine dei controlli, la nota dei duplicati, la valuta non scritta e il confronto con maiuscole, l'abbinamento per importo invece che per ID, le richieste senza ID fuse, e per B la definitività (non richiesta; «qualunque cosa che non sia falso»; «qualunque cosa vera»; invertita; richiesta anche per il `no`; zero non definitivo che risponde `no`; `final` sempre vero con il provato; `final` legato ai rimborsi in corso; legato alle contestazioni).

| Passata | Mutazioni | Rilevate | Sopravvissute | Non applicate |
|---|---:|---:|---:|---:|
| Prime 44 (le nuove e le tre riscritte) | 44 | 43 | **1** (QA27) | 0 |
| Dopo il test di QA27 (rieseguita da sola) | 1 | 1 | 0 | 0 |
| **Banco completo, file definitivi** | **474** | **471** | **3** | **0** |

Le **3 sopravvissute** sono le stesse tre mutazioni **equivalenti** già dichiarate in S6a.19 — Q09 (per una richiesta, un importo mancante letto come `0`: entrambi sono non validi e danno lo stesso codice e la stessa esclusione), B13 (la cifra unica data anche quando i limiti differiscono: una posizione provata ha sempre i due limiti uguali, e l'invariante è verificata su ogni posizione) e A25 (non porre `sound = false` per l'importo di una contestazione non valido: la guardia che segue la mette già da parte). Il codice che toccano non è cambiato; nessun test le uccide per caso. **Tutte le 39 mutazioni nuove sono rilevate**; cinque da un solo test (QA10, QA18, QA27, ZB02, ZB03), scritto apposta per quella regola.

Per famiglia: le famiglie del banco di S6a.19 restano interamente rilevate tranne le tre equivalenti; le nuove sono 28 sulle richieste e sugli ID (QA01–QA28), 9 sulla definitività (ZB01–ZB09) e 2 sulle singole segnalazioni (Q03b, Q04b).

Contabilità onesta: la prima passata sulle sole 44 mutazioni nuove o riscritte diede **43 su 44**: sopravvisse QA27 («l'ID di un rimborso elencato ricordato in minuscolo»: il modello avrebbe fuso `RE_A` e `re_a` perché si somigliano). Non era equivalente: è stato aggiunto il test sugli ID in maiuscolo e minuscolo (con un'aspettativa sbagliata mia alla prima stesura, corretta nel test) e la mutazione, rieseguita da sola, è rilevata. Un tentativo di rieseguirla si fermò subito perché il banco rifiuta di partire se i test della copia non sono verdi: non è una passata e non è contato. Nessuna passata del banco completo è stata interrotta.

### Altri risultati

- `npx tsc --noEmit`: **0 errori**.
- `npm run lint` (`--max-warnings=0`): **0 avvisi**.
- `npm test`: **1536 test, 1534 verdi**; falliscono **soltanto i 2 preesistenti** — `global layout includes r3Dr parent-company branding` e `resolveSiblingRepoPath resolves suite repos beside MakerWorks` — non toccati e non usati per nascondere nulla (prima del pacchetto: 1454 test, 1452 verdi). `tests/production-release-guards.test.ts`: 18/18.
- **Rete rifiutata:** il file di prova eseguito con ogni connessione di rete (TCP, DNS, `fetch`, `http`/`https`) rifiutata e registrata: **587/587, 0 tentativi** (solo la pipe locale del caricatore `tsx`); il controllo negativo verso un host `.invalid` registra i suoi 3 tentativi. Nessuna variabile `STRIPE_*` e nessuna chiave.
- **Confronto differenziale** fra il modulo di `ae71c32` e quello corretto, su **300 000** prove casuali generate fuori dal repository (rimborsi in ogni stato, contestazioni con i loro movimenti, richieste con ID in collisione e importi discordanti, elenchi incompleti o non letti, valute e ID sbagliati): **senza richieste** (120 244 prove) le posizioni sono **identiche**; con richieste, le posizioni cambiano solo dove il nuovo modulo segnala una contraddizione che prima non vedeva (41 034 prove), e in quei casi l'intervallo nuovo **contiene** il vecchio (mai un limite inferiore più alto, mai uno superiore più basso), la posizione non è mai più certa né più definitiva; «non è trattenuto nulla?» cambia **solo** da `yes` a `unknown` per uno zero provato e non definitivo (27 casi); «almeno X?» dà la stessa risposta nei due moduli sulla stessa posizione. **0 divergenze** non spiegate.
- `test:security` (richiede un database) **non rieseguito**: nulla sotto `app/`, `prisma/`, `components/` o negli altri file di `lib/` è cambiato (`git diff --stat`: due file modificati più questo documento).

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **«Almeno X?» risponde ancora `no` dalla lettura migliore dell'istantanea, anche se non è definitiva (limite noto, NON modificato).** Dopo un rimborso totale riuscito, `retainedAtLeast(posizione, 1)` è `no` (il migliore dei casi trattiene 0) e diventa `yes` se il rimborso fallisce. L'audit chiedeva di rendere conservativa «non è trattenuto nulla?»; l'altra domanda non è stata chiesta, resta com'era ed è **fissata da un test** («KNOWN LIMIT») perché nessuno la cambi, né si affidi a quel `no` per una decisione irreversibile, senza vederlo. Chi vorrà usarla per una decisione che non si può disfare dovrà chiedere anche `final`: è una decisione per un pacchetto successivo, e qui non è stata inventata alcuna soglia.
- **Una contestazione persa con il ritiro mostrato è trattata come definitiva** (zero → `yes`). Se una contestazione persa possa essere ribaltata più tardi non è stato osservato in Test Mode e non è modellato: ipotesi aperta, dello stesso genere di quelle di S6a.19.
- **`final` copre i rimborsi riusciti che possono fallire, non altro.** «Zero definitivo» significa «zero secondo le prove, e nulla di ciò che le prove mostrano può ancora riportare denaro»; non dice che nulla possa mai cambiare (è sempre un'istantanea).
- **Le richieste restano intenzioni passate da chi chiama.** Il modello le confronta con i rimborsi elencati **per ID**; una richiesta senza ID non si può abbinare a un rimborso elencato e conta nel caso peggiore **in aggiunta** a esso (può sovrastimare il denaro uscito: è la direzione prudente per il limite inferiore). Chi chiama deve passare l'ID appena lo conosce.
- **Valuta di una richiesta non scritta = valuta del pagamento**: ipotesi (un rimborso Stripe è nella valuta del suo pagamento), non verificata qui.
- Restano **aperte e invariate** le sette ipotesi di S6a.19 (valori di `reporting_category`; rimborso `failed` senza transazioni; stati mai osservati; semantica di `amount_refunded` osservata con due soli metodi; più contestazioni sullo stesso addebito; nessuna conversione di valuta; commissione assente o incoerente) e i limiti del suo elenco: P1 **non è collegato**, non decide, le soglie di rilascio / `accepted` / `no_charge` non sono definite, manca lo strato che legge Stripe (P3), le fixture sono costruite, nessun rischio di 1.44a–1.44d è accettato.

### Come riprodurre

`node --test --import tsx tests/payment-hold-evidence.test.ts` (offline, nessuna chiave); `npx tsc --noEmit`; `npm run lint`. Il rosso si riproduce eseguendo il file di test contro il modulo di `ae71c32` (`git show ae71c32:lib/payment-hold-evidence.ts`). Le mutazioni si eseguono su una copia fuori dal repository (non c'è un comando nel progetto). Nessun passo richiede Stripe.

## S6a.21 Manutenzione dei due test storici della suite (nessun codice applicativo toccato)

Dal commit `09733cd` la suite generale mostrava due fallimenti preesistenti. Diagnosi (riprodotti separatamente sul commit di partenza), poi correzione delle sole aspettative sbagliate:

- **`global layout includes r3Dr parent-company branding`** (`tests/r3dr-branding.test.ts`). Falliva l'ultima asserzione di stile: `.footer-shell { … border-radius: 1.25rem; }` in `app/globals.css`. Il CSS attuale ha un piede di pagina piatto (`border-top`, sfondo trasparente) e la dichiarazione non esiste più (rimossa da una modifica di design storica): **aspettativa visiva obsoleta, non regressione**. Tolta solo quella; al suo posto due controlli strutturali (esistono la regola `.footer-shell` con `border-top` e `.footer-business-grid` con `display: grid`). Restano tutti i controlli su marchio (`r3Dr`, `https://r3dr.ca`), testo, collegamenti, contatto e struttura del footer. `app/globals.css` e il layout non sono toccati.
- **`resolveSiblingRepoPath resolves suite repos beside MakerWorks`** (`tests/suite-demo-seed.test.ts`). Il test usava `path.join('C:', 'Users', 'steph', …)`: su Linux non è un percorso assoluto, e `path.resolve()` dell'implementazione lo ancora alla directory corrente (`/home/user/mkw2/C:/Users/…`): **test non portabile, non regressione**; la funzione è corretta e non è modificata. Il test ora parte da un percorso assoluto costruito con `path.resolve(path.sep, …)` (coerente con la piattaforma, nessun percorso personale, niente da creare su disco) e verifica il contratto — assoluto, stesso genitore di MakerWorks, nome del repository, `path.relative(root, sibling) === '../<nome>'`, separatore finale, radice relativa — per StockWorks e PrintLab. Nuovo test (9 invece di 8 nel file): `resolveSuiteDemoPaths` mette StockWorks e PrintLab accanto a MakerWorks, la cartella dati di PrintLab è dentro PrintLab, e `SUITE_DEMO_STOCKWORKS_ROOT` / `SUITE_DEMO_PRINTLAB_ROOT` la sovrascrivono (la cartella dati segue l'override).

Le prove non sono banali: su una copia, spostare il fratello dentro la radice, ignorare l'override di PrintLab, scambiare StockWorks con PrintLab o togliere la regola `.footer-business-grid` fanno fallire i test. Limiti: eseguito solo su Linux; il comportamento Windows si deduce da `path.resolve`/`path.relative` della piattaforma, non è stato eseguito.

## S6a.22 P3a.1: il lettore delle evidenze Stripe (`lib/stripe-funds-reader.ts`), scritto e provato solo offline

Il modello dei fondi (P1, S6a.19–S6a.20) calcola quanto denaro di **un** pagamento risulta trattenuto a partire da prove «già lette da Stripe», ma nessun codice le leggeva. Questo pacchetto scrive **il lettore**: dato un client Stripe iniettato, un pagamento e la modalità attesa, legge ciò che il modello legge, lo consegna nella forma del suo ingresso e dice **come è andata la lettura**. Punto di partenza: `e2e3e37d23c1600636d523d0298d0ba6063ee16a`, albero pulito. Il piano normativo è il piano P3a.0 con la revisione R2 (approvata); le tre precisazioni dell'audit indipendente (A: i 23 casi; B: scadenza e Promise; C: provenienza) sono applicate e discusse più sotto.

**Correzione D5 (richiesta del titolare).** Una prima versione del lettore inoltrava le richieste dell'applicazione (`requestedRefunds`) **per riferimento**, cioè restituiva a P1 l'array e gli oggetti del chiamante. Su richiesta del titolare è stata corretta: le richieste sono ora acquisite come **copia indipendente e controllata** prima del primo `await`, con quattro precisazioni vincolanti (A: tipi TypeScript; B: limite di 1.000 elementi; C: JSON e numeri anomali; D: `Object.freeze` non è reversibile). Tutti i risultati ottenuti **prima** di D5 sono storici e **non** valgono come esiti finali: ciò che la parte «Risultati» riporta è stato rieseguito sul codice definitivo.

### Ambito e confine

- **File del pacchetto (solo questi):** `lib/stripe-funds-reader.ts` (nuovo, **zero import**), `tests/stripe-funds-reader.test.ts` (nuovo), `tests/_fake-stripe-funds.ts` (nuovo: il finto Stripe dei test) e questa sezione. P1 e i suoi 587 test sono **invariati**; nessun modulo dell'applicazione, rotta, componente, schema, configurazione o dipendenza è toccato.
- **Il lettore legge, verifica, proietta e classifica. Non decide.** Non somma, non converte, non ripara; non contiene soglie, età massime, regole di ripetizione né alcuna decisione operativa (`accepted`, `no_charge`, rilascio: ipotesi di R2.4, per P4, **non approvate**). La posizione del denaro la calcola **solo** P1, e solo nei test. Le richieste dell'applicazione sono copiate e controllate nel **tipo e nella struttura**, mai nel dominio (sezione D5).
- **Non è collegato a nulla.** Nessun file di `app/`, `lib/`, `components/`, `scripts/`, `prisma/` o della radice lo nomina (guardia A4, con `ALLOWED_IMPORTERS = []`, gemella di quella di P1); il lettore non nomina il file di P1 (la guardia di P1 lo vieta anche nei commenti). Un futuro pacchetto di integrazione dovrà modificare quell'elenco **di proposito**.
- **Nessuna chiamata a Stripe, nemmeno in Test Mode; nessuna chiave autentica.** La sola chiave che compare è il segnaposto `sk_test_FAKEOFF1234`, nei test dell'SDK vero con un `httpClient` finto e con **ogni connessione rifiutata e registrata**. Nessun database, migrazione, deploy.

### Contratto implementato

**Ingresso.** `readStripeFundsEvidence(client, request, options)`, che **non rigetta mai**.
- *`client`*: i soli quattro metodi di lettura `paymentIntents.retrieve`, `refunds.list`, `disputes.list`, `balanceTransactions.retrieve`; nessun metodo di scrittura sull'interfaccia. Il vero `Stripe` 19.3.1 è assegnabile senza cast (prova di compilazione nei test, eseguita da `npm run typecheck`, con cinque `@ts-expect-error` che provano l'assenza di `refunds.create`, `paymentIntents.cancel`, `disputes.update`, `balanceTransactions.list`, `checkout`). I metodi si chiamano **come metodi**, mai staccati (l'SDK usa `this`).
- *`request`*: `paymentIntentId` (`pi_…`, solo `[A-Za-z0-9_]`, al più 255 caratteri), **`expectedLivemode` obbligatorio** (booleano: il lettore non conosce chiavi né ambiente, la modalità la dichiara il chiamante dalla propria configurazione), `requestedRefunds` facoltativo (un array di **al più 1.000** oggetti, copiato e controllato: sezione D5).
- *`options`*: `now` (orologio iniettato, **obbligatorio**: il modulo non ha orologio proprio) e cinque numeri interi facoltativi con il loro intervallo — `perCallTimeoutMs` 5000 (500–60000), `deadlineMs` 15000 (1000–120000), `pageSize` 100 (1–100), `maxPages` 5 (1–50), `maxMovementReads` 20 (0–100); i predefiniti sono `FUNDS_READ_DEFAULTS`.
- **Input non valido** (anche un getter che lancia, un orologio che non dà un numero, una lista di richieste che non supera il controllo): rifiutato **prima di qualunque chiamata**, riportato **per nome** (`failures: [{ call: 'input', kind: 'invalid_input', ref: '<nome>' }]`, mai per valore), mai riparato né sostituito con un predefinito; tutto «non letto», tempi `null`; e **nulla delle richieste del chiamante torna indietro**, qualunque sia l'input che ha causato il rifiuto.

**Sequenza** (un solo passaggio, sequenziale, nessun nuovo tentativo del lettore). Ogni chiamata passa **parametri e opzioni in due argomenti**; le opzioni sono sempre `{ timeout, maxNetworkRetries: 0 }` (mai un `idempotencyKey`), nei parametri non c'è mai nulla delle opzioni (la trappola dell'SDK, provata a livello di filo: filtri e opzioni in un solo oggetto danno `GET /v1/refunds` **senza alcun filtro**).
0. **Prima di tutto, prima del primo `await`:** le richieste dell'applicazione sono copiate (o rifiutate), poi si guarda il client, l'orologio, le opzioni.
1. `paymentIntents.retrieve(id, { expand: ['latest_charge'] })`: `id` e `object` devono essere quelli attesi e `livemode` deve essere **un booleano uguale a `expectedLivemode`**; altrimenti il pagamento è «non letto», **si fa una sola chiamata** e ci si ferma.
2. L'addebito espanso: `object === 'charge'`, `id` valido (`ch_…` e `py_…`), `payment_intent` = il pagamento, `livemode` uguale all'atteso; altrimenti è **trattenuto** (non passa come prova). `latest_charge: null` → «`none_reported`» (lo dice il pagamento; **non** è una prova di assenza di denaro e **non** si costruisce mai un addebito); una stringa o un campo assente → «non espanso». `transfer_data`, `on_behalf_of` o `application_fee_amount` non nulli (sul pagamento o sull'addebito) → flusso non modellato.
3. `refunds.list` poi `disputes.list`, con filtro `payment_intent`, **a mano**: `starting_after` assente alla prima pagina, cursore = `id` dell'ultima voce (valido, mai già usato, con almeno una voce mai vista), tetto di pagine, fine **solo** a `has_more === false`. Una pagina è valida solo se è un oggetto con `data` array di al più `limit` voci, `has_more` booleano e non vuota se c'è altro da leggere. Ogni voce di una pagina valida è presa **intera, nell'ordine ricevuto, ripetuta o estranea che sia** (il lettore non filtra, non deduplica, non riordina). Ogni contestazione deve dichiarare `livemode` uguale all'atteso.
4. `balanceTransactions.retrieve(id, {}, …)` per **ogni** id di transazione citato da un rimborso (una sola lettura per id, anche se citato due volte; prima le coppie dei rimborsi non riusciti, che si fermano al primo fallimento; tetto `maxMovementReads`): la risposta deve avere l'`id` chiesto e `object === 'balance_transaction'`. I movimenti **già in linea** (rimborsi e contestazioni) devono essere transazioni di saldo con `id` utilizzabile. Qualunque movimento citato e **non risolto** rende la lettura incompleta.
5. **Richiamo di chiusura** del pagamento (`paymentIntents.retrieve` di nuovo), solo se la struttura è ancora completa: confronta i campi di pagamento e addebito che P1 legge (distinguendo `null`, `NaN`, `Infinity`, `0`, `-0`); è un **segnale di possibile cambiamento, non una prova di atomicità** (sotto).

**Uscita.** `{ evidence, reading }`.
- `evidence`: `paymentIntent`, `charge`, `refunds: { data, has_more }`, `disputes: { data, has_more }` (`null` = **non letto**, mai `[]`), e `requestedRefunds` **soltanto se il chiamante ha dato una lista e la lettura non è stata rifiutata**: una **copia** (array nuovo di oggetti nuovi con `id`, `amount`, `currency`), mai la lista del chiamante. Per il resto solo i campi che P1 legge; un campo assente resta assente, `null` resta `null`, tipi sbagliati restano sbagliati; un riferimento espanso è ridotto al suo `id`; un valore non scalare dove ne serve uno è sostituito da un marcatore che nessun id, valuta o importo può eguagliare (così non viaggia nulla del suo contenuto). Nessun `client_secret`, nessun dato personale, nessun oggetto grezzo.
- `reading.structure`: `complete`, le sei parti (`paymentIntent`, `charge`, `refunds`, `disputes`, `movements`, `mode`) e `incomplete` con le **sole** 16 cause di `FUNDS_READ_STRUCTURE_REASONS`, nell'ordine di quell'elenco.
- `reading.temporal`: `observation` (`no_change_observed` / `change_observed` / `not_verifiable`), `paymentIntentRecheck` (`same` / `different` / `not_done`), `pagination` (`regular` / `anomalous`), `signals` (le sole 3 di `FUNDS_READ_TEMPORAL_SIGNALS`), `notVerified` (l'elenco congelato, **lo stesso array in ogni rapporto**), `startedAtMs`, `finishedAtMs`, `spanMs`, `withinDeadline`.
- `reading.mode`: `{ expected, observed }`, con `observed` ricavato **solo** dagli oggetti che dichiarano `livemode` (mai da prefissi di id o dall'ambiente). `reading.failures` (mai il testo di un errore) e `reading.counts`.
- **Nessun campo** `final`, `safe`, `ok`, `trusted`, `eligible`, `decision`, `snapshot` o simile, in nessun rapporto e in nessun nome esportato (guardia A9).
- **Tipi (precisazione A):** `ReadCall` ammette `'input'` e `ReadFailureKind` ammette `'invalid_input'`; `FundsEvidenceOut.requestedRefunds` è una proprietà **opzionale** (`RequestedRefundInput[]`, senza `null`) e la sua assenza a runtime è reale (nessuna chiave, non una chiave con valore `undefined`); l'uscita resta strutturalmente assegnabile a `FundsEvidence` di P1. Lo provano controlli di compilazione (`npm run typecheck`, compreso un `@ts-expect-error` che esclude `null`) e i test R10 a runtime. Nessun `any`, cast ingiustificato o disattivazione dei controlli nel modulo per ottenerlo.

**Degradazione per costruzione.** Se **non** valgono insieme `structure.complete` e `observation === 'no_change_observed'`, **entrambe** le liste dell'evidenza escono con `has_more: true` (i dati letti sono conservati): P1 risponde «incerta» anche a chi ignora il rapporto. Una lista che non si è potuta leggere è `null`. Il contrario non vale: una lettura strutturalmente completa e senza cambiamenti osservati **non** dimostra che Stripe non sia cambiato.

**Errori.** Classificati dalle stringhe che portano le classi dell'SDK (`type`, `rawType`, `statusCode`, `detail.code`), mai da `instanceof` e mai dal testo: `timeout` (`StripeConnectionError` con `ETIMEDOUT`), `connection`, `rate_limit`, `authentication`, `permission`, `invalid_request`, `api`, `unknown`; più `malformed_response`, `identity_mismatch`, `mode_unverified`, `mode_mismatch`, `budget`, `invalid_input`, `internal_error`. Un codice d'errore è riportato solo se è uno di un elenco di nomi di condizione (`resource_missing`, `ETIMEDOUT`, `ECONNRESET`, …), uno `statusCode` solo se è un numero HTTP.

| Causa di struttura incompleta | Quando |
|---|---|
| `invalid_input` | un input non valido (compresa una lista di richieste che non supera il controllo); nessuna chiamata |
| `payment_intent_not_read` / `payment_intent_identity` | pagamento illeggibile, o `id`/`object` diversi dal richiesto |
| `mode_unverified` / `mode_mismatch` / `mode_mixed` | modalità mancante o non booleana / in un'altra modalità (il pagamento) / oggetti che non concordano |
| `charge_unexpanded` / `charge_identity` | `latest_charge` rimasto id o assente / addebito che non supera tipo, id o appartenenza |
| `payment_flow_not_modeled` | trasferimento, conto «per conto di», commissione applicativa |
| `refunds_not_read` / `refunds_truncated` | prima pagina illeggibile / lettura interrotta (errore, pagina non valida, ciclo, tetto di pagine) |
| `disputes_not_read` / `disputes_truncated` | idem per le contestazioni |
| `movements_unresolved` | almeno un movimento citato non risolto |
| `budget_exhausted` | numero di chiamate, scadenza o orologio |
| `reader_error` | un guasto che il lettore non aveva previsto: l'evidenza è tutta «non letta» |

### Le richieste dell'applicazione (D5): copia indipendente e controllata

Le richieste (`requestedRefunds`) sono parole del **chiamante**, non oggetti di Stripe, e il chiamante conserva i propri oggetti: possono cambiare in qualunque momento, anche mentre una Promise di Stripe è in attesa. Il lettore non le consegna mai per riferimento: le **acquisisce una volta**, le controlla nello stesso gesto e ne restituisce una copia.

| Aspetto | Regola (provata dai test del gruppo R) |
|---|---|
| Quando | **Come prima cosa** di `validate`, nel tratto sincrono che precede il primo `await`, prima di toccare il client, l'orologio, le opzioni o gli altri campi della richiesta: un getter del client, l'orologio iniettato, un getter delle opzioni o un altro campo della richiesta che cambiano la lista alla loro prima esecuzione non la cambiano nell'evidenza (R1e). Una modifica degli originali dopo quel momento — subito dopo la chiamata, con una Promise in attesa in ciascuno dei cinque punti in cui la lettura aspetta, o dopo il ritorno — non altera né il risultato né l'evidenza (R1a–R1c). |
| Presenza | assente o `undefined` ⇒ **nessuna chiave** `requestedRefunds` nell'evidenza (assenza reale); `[]` ⇒ `[]` presente; `null` ⇒ **rifiutato**: solo l'assenza significa «nessuna richiesta» (R4, R10). |
| Contenitore | un array (`Array.isArray`); stringa, numero, booleano, oggetto, oggetto simile a un array, `Set`, funzione, `Symbol`, `BigInt`, `TypedArray`, iterabile, `Error` ⇒ rifiutato (R3). |
| Lunghezza | letta **una volta** e verificata **prima** di toccare un elemento: un intero ≥ 0 e ≤ **1.000**; altrimenti l'intera lista è rifiutata, senza copia parziale (R9). |
| Elementi | un oggetto non nullo e non array, letto per indice **una volta**; `null`, `undefined` (e quindi i **buchi**), primitivi, array, funzioni ⇒ rifiutato (R3). Un oggetto di qualunque tipo (`Map`, `Date`, istanza di una classe) è letto per i suoi tre nomi: se manca l'importo la copia è `{}` e P1 la rifiuta per `invalid_amount` (R3d, limite noto). |
| Proprietà | **solo `id`, `amount`, `currency`**, lette **per nome, una volta ciascuna**; mai enumerate né sondate (`Object.keys`, `for…in`, `in`, spread, `Object.assign`) e mai tramite metodi del chiamante (`map`, `slice`, iteratore, `toJSON`, `toString`): una proprietà estranea — anche un getter o un `Proxy` che lanciano — non viene mai toccata (R2, R3b, R6). |
| Tipi | `id` e `currency`: stringa o `null`; `amount`: numero o `null` — **qualunque** numero: `NaN`, `±Infinity`, `-0`, non intero, negativo; ogni altro tipo ⇒ rifiutato (R3). |
| Fedeltà | valori copiati **così come sono** (`Object.is`): nessun arrotondamento, conversione, maiuscole, `trim`; proprietà assente resta assente, `null` resta `null`, `undefined` vale «assente» (una chiave esiste **se e solo se** c'è un valore); **ordine e duplicati conservati**, nessuna deduplicazione, nessun filtro; chiavi sempre nell'ordine `id`, `amount`, `currency` (R3c, R4, R5). |
| Cosa non viaggia | proprietà aggiuntive (anche con dati personali, `client_secret`, `metadata`), oggetti annidati, prototipi, riferimenti mutabili del chiamante: l'uscita è un array nuovo di oggetti nuovi con soli scalari (R2). |
| Rifiuto | **tutta** la lista: `invalid_input` con `ref: 'requestedRefunds'` (mai indici, valori o testi d'errore), **zero chiamate Stripe**, nessuna eccezione, `structure.complete: false`, `incomplete: ['invalid_input']`, evidenza non conclusiva (le quattro parti `null`, nessuna chiave `requestedRefunds`), P1 «incerta» e mai `retainedIsZero`/`retainedAtLeast` favorevoli. Vale anche per un getter o un `Proxy` che lanciano (sul contenitore, sulla lunghezza, su un indice, su una proprietà) o un `Proxy` revocato (R3, R9). Un rifiuto causato da **un altro input** non lascia nulla delle richieste nell'evidenza (R7). |
| Indipendenza | l'evidenza non condivide nulla col chiamante (né l'array né gli oggetti); modificare l'evidenza non tocca gli originali; due letture contemporanee con la stessa lista hanno copie distinte (R1, R7). Il rapporto di `reader_error` porta la stessa copia già acquisita, non una nuova lettura dell'originale (G15). |
| Oggetti congelati | `Object.freeze` non è reversibile: i test non «scongelano» mai, usano oggetti nuovi o sostituzioni di elementi per i passaggi successivi (precisazione D). Una lista di oggetti congelati è accettata e copiata in oggetti normali (R1d, I5). |

**Validazione strutturale (del lettore) e validazione di dominio (di P1).** Il lettore controlla soltanto che la lista abbia la **forma** di una lista di richieste. Che un id sia ben formato, che un importo sia un intero positivo e sicuro, che la valuta concordi col pagamento, che cosa fare dei duplicati e dei conflitti, è **di P1** e non si anticipa nel lettore, per non introdurre normalizzazioni silenziose:

| Del lettore (tipo e struttura) | Di P1 (dominio, `computeFundsPosition`) |
|---|---|
| contenitore = array; lunghezza intera, 0–1.000; elementi = oggetti; `id`/`currency` stringa o `null`; `amount` numero o `null` | formato dell'id (`invalid_identifier`); importo intero, positivo e sicuro (`invalid_amount`: `NaN`, `±Infinity`, `-0`, `0`, negativi, frazioni, oltre gli interi sicuri); valuta (`currency_mismatch`); richieste senza id (`refund_requested`); **duplicati legittimi** (`duplicate_removed`) e **conflittuali** (`conflicting_duplicate`); richieste che contraddicono un rimborso elencato; rimborsi richiesti e non elencati (`refund_requested`) |

I duplicati si **conservano** nell'evidenza, in ordine, come copie distinte (anche se il chiamante ha dato due volte lo stesso oggetto), e P1 risponde come risponderebbe alla lista del chiamante (differenziale in R5 e R8).

**Limite di dimensione (precisazione B).** Al più **1.000** richieste. È una protezione delle risorse, **non** una soglia finanziaria né una decisione di business: una costante interna (`MAX_REQUESTED_REFUNDS`) non esportata e **non** un parametro (la superficie pubblica non cambia: A5; un'opzione con quel nome è ignorata: R9; nessuna guardia statica ha richiesto adeguamenti, perché il lettore non esporta numeri e A10 guarda solo le costanti esportate). La lunghezza è letta una volta e controllata prima di leggere un elemento; con 1.001 elementi si rifiuta tutto, senza copia parziale, senza chiamate, senza dati del chiamante nel risultato. Provati: esattamente 1.000 (copiati interi), 1.001 (un `Proxy` mostra che si è letto `length` e nient'altro), 1.000 con l'ultimo non valido (nessuna copia parziale), un array sparso di 4.294.967.295 posti, e lunghezze patologiche su `Proxy` (`Number.MAX_SAFE_INTEGER`, `2^32`, `1e21`, `±Infinity`, `NaN`, `-1`, `1.5`, stringa numerica, `null`, `undefined`, `BigInt`, oggetto, `true`, una lunghezza che lancia): un solo accesso a `length` e nessun elemento.

**JSON e numeri anomali (precisazione C).** Una rappresentazione JSON **non** è una copia lossless dell'evidenza a runtime per i numeri che JSON non sa scrivere: `JSON.stringify([NaN, Infinity, -Infinity, -0])` dà `[null,null,null,0]` (verificato in R11). Il lettore consegna gli oggetti, non la loro immagine JSON: i quattro valori arrivano **esattamente** come il chiamante li ha scritti (`Object.is`), e l'immagine JSON dell'evidenza **non** li conserva (`NaN` e `null` hanno la stessa immagine, come `-0` e `0`). Per questo **nessuna immagine JSON è una fonte autorevole per una decisione finanziaria**. P1 rifiuta tutti e quattro (`invalid_amount`, un conflitto): posizione incerta, intervallo più largo, `retainedIsZero` e `retainedAtLeast(…, 1)` mai «yes», limite inferiore mai più alto della stessa lettura senza la richiesta, mai «più favorevole» (R11). Il confronto di chiusura del lettore non usa JSON semplice: distingue `null`, `NaN`, `Infinity`, `0` e `-0` (H16). I rapporti di una lettura ordinaria sono fatti di valori JSON (stringhe, interi, booleani, `null`) e per quelli l'andata e ritorno è identica (I7): non è una dichiarazione su `NaN`, `Infinity` o `-0`.

### Limiti temporali e non-atomicità

Una lettura è una **composizione non atomica** di osservazioni fatte una dopo l'altra: Stripe non offre una lettura atomica di quegli oggetti e il lettore non può crearla. Il richiamo di chiusura dice una cosa sola: in due istanti i campi di pagamento e addebito che P1 legge avevano gli stessi valori. **Non** dimostra che un rimborso non sia fallito e rifatto uguale, che una contestazione non sia cambiata con `Charge.disputed` fermo, che una voce non sia nata dopo la lettura della sua lista, né nulla su ciò che accade dopo la chiusura. Per questo `no_change_observed` significa «nessun segnale visto», non «stabile», e il rapporto porta sempre l'elenco di ciò che nessuna lettura verifica:

| Codice di `FUNDS_READ_NOT_VERIFIED` | Che cosa non si verifica |
|---|---|
| `atomicity_across_objects` | gli oggetti sono letti in chiamate e istanti diversi |
| `changes_between_calls` | salvo ciò che il richiamo e P1 (aggregato contro liste) lasciano emergere |
| `aba_between_open_and_close` | un campo cambiato e tornato uguale (un rimborso fallito e rifatto) |
| `new_entries_after_list_read` | voci nate dopo la lettura di una lista che non muovono né aggregato né flag |
| `dispute_changes_without_flag_change` | una contestazione che cambia con il flag dell'addebito fermo |
| `changes_after_close` | tutto ciò che accade dopo la lettura di chiusura |
| `list_order_and_cursor_stability` | l'ordine di `disputes.list` non è documentato; la stabilità del cursore non è garantita |
| `mode_of_refunds_and_movements` | `Refund` e `BalanceTransaction` non dichiarano `livemode` nei tipi dell'SDK |
| `finality` | se la posizione possa ancora cambiare: non è una proprietà della lettura |

**«Definitiva» di P1 non vuol dire «stabile nel tempo».** `final` copre i rimborsi riusciti che possono ancora fallire; P1 dà `proven` e `final` anche su un'evidenza invecchiata di un attimo. Il lettore non espone alcun campo di definitività.

**La matrice di H13 (precisazione A).** Eventi X1–X9 su sei basi (pagamento semplice; rimborso riuscito; rimborso totale; rimborso `pending`; contestazione aperta; contestazione vinta con reintegro) in cinque momenti (prima dell'apertura; fra apertura e rimborsi; fra rimborsi e contestazioni; fra contestazioni e chiusura; dopo la chiusura), nelle **coppie** evento-base che possono accadere (21), con e senza che Stripe conti nell'aggregato un rimborso che attende un'azione (mai osservato: si giocano entrambe le ipotesi): 105 casi per variante. Per ciascuno il test controlla **in modo indipendente dal lettore** (sul registro di ciò che il finto ha restituito) che il richiamo dica `different` **se e solo se** i campi letti da P1 differiscono tra apertura e chiusura, che le liste siano degradate quando la lettura non è pulita, e che «non è trattenuto nulla» non sia mai promosso rispetto alla realtà a fine mondo.
- **I 23 casi non rilevati della simulazione di R2.1 sono un risultato di quella simulazione, non un limite matematico.** Il test li tiene come un **insieme ammesso, non come una quota da conservare**: un caso che migliora è riportato (`t.diagnostic`) e va verificato e documentato; una promozione favorevole **fuori** dall'insieme fa fallire il test e va documentata come regressione o rischio, non aggiunta all'insieme per far passare la prova.
- Esito di questa implementazione (stesso HEAD): vedi «Risultati» più sotto.

### Scadenza, budget e Promise che non terminano (precisazione B)

Quattro cose diverse, mai confuse:

| Che cosa | È garantito dal lettore? |
|---|---|
| **Numero di chiamate** | **Sì.** Al più `2 + 2 × maxPages + maxMovementReads` (32 con i predefiniti), per costruzione; ogni chiamata è attesa una volta sola. |
| **Timeout passati all'SDK** | **Sì, per ogni chiamata:** un intero esplicito `min(perCallTimeoutMs, ⌊(restante − 500) / 2⌋)`, mai omesso, mai 0, mai più della metà di ciò che resta; la metà tiene conto del fatto che l'SDK ritenta una volta una connessione caduta anche con `maxNetworkRetries: 0`. Senza margine la chiamata **non parte** (`budget`). `maxNetworkRetries` è sempre 0: nessun nuovo tentativo applicativo. |
| **Orologio iniettato** | **Sì:** letto prima di ogni chiamata e alla fine, tenuto al valore più alto già visto (un orologio che torna indietro non fa tornare indietro i tempi); una lettura che non è un numero **ferma** le chiamate, per sempre. `withinDeadline` è giudicato su quell'orologio ed è **informativo**. |
| **Terminazione reale di una Promise** | **No.** Non ci sono timer né corse (`Promise.race`): un client che ignora il timeout fa finire la chiamata in ritardo (e il rapporto dice `withinDeadline: false`, senza altre chiamate); una Promise che non si risolve **lascia la lettura in sospeso** e il lettore non ha fatto altro. Il tetto assoluto resta di chi chiama (come `readWithDeadline` in `payment-sync`). |

Per il client vero restano gli obblighi: timeout espliciti (il lettore li passa sempre) e nessun nuovo tentativo applicativo. Non si promette «15 secondi».

### Provenienza dell'evidenza e input non validi (precisazione C)

L'invariante di provenienza (I1c) distingue **tre classi che non si mescolano**:
1. **Oggetti restituiti dalle chiamate (simulate) a Stripe:** ogni oggetto dell'evidenza è la proiezione di un oggetto restituito *da quella lettura*, nell'ordine restituito; nessun oggetto inventato, nessun valore precedente all'inizio della lettura. Verificato contro il registro di tutto ciò che il finto ha restituito (J8b), su storie casuali con eventi.
2. **`requestedRefunds`, dal chiamante:** non sono oggetti di Stripe e non sono presentati come tali. Sono **copiati** come descritto nella sezione D5: un array nuovo di oggetti nuovi con `id`, `amount` e `currency`, acquisito prima del primo `await`, senza riferimenti mutabili condivisi col chiamante; se il chiamante non li dà, la chiave **non c'è** (il lettore non dice «nessuno»); una lista che non è di tipo e struttura validi fa **rifiutare la lettura** (non viene più passata a P1 perché la giudichi).
3. **Metadati della lettura** (`reading`: parti, conteggi, orari, segnali): derivati dal processo di lettura, fuori dalla prova di provenienza.
Qualunque input runtime non valido è trattato **senza cancellazioni, normalizzazioni silenziose o conclusioni favorevoli** (D1 e D5 sotto); e una risposta di Stripe non valida arriva a P1 com'è, con la lista degradata, mai ripulita.

### Scostamenti dal piano R2 e decisioni prese dove R2 lasciava margine

- **D1 — opzioni non valide:** R2 diceva «valore non valido ⇒ predefinito»; qui un valore **presente e fuori intervallo** è `invalid_input` (nessuna chiamata), uno **assente** prende il predefinito. Motivo: nessuna normalizzazione silenziosa (precisazione C).
- **D2:** gli input rifiutati sono in `failures` con `call: 'input'` e `ref` = **nome** dell'input. Il tipo `ReadCall` ha inoltre `'reader'` per un `internal_error`.
- **D3:** orari e `withinDeadline` valgono `null` quando l'orologio non è mai stato letto; `mode.expected` vale `null` se `expectedLivemode` non è un booleano. Nessun valore inventato.
- **D4:** nessun timer e nessuna corsa (precisazione B); vedi la tabella sopra.
- **D5 — provenienza in tre classi, con la classe (b) corretta su richiesta del titolare:** il piano R2 prevedeva `requestedRefunds` «inoltrati senza modifiche»; la prima versione del lettore li passava **per riferimento** (e un valore non array o con elementi non validi arrivava a P1 com'era). **Definitivo:** copia indipendente e controllata, acquisita prima del primo `await`, solo `id`, `amount`, `currency`, fedele ai valori (assente ≠ `null`, nessuna deduplicazione, nessuna conversione), con rifiuto dell'intera lista (`invalid_input`, zero chiamate, nulla del chiamante restituito) per ogni difetto di tipo o struttura, e con il limite di 1.000 elementi. Scelte che la correzione ha fissato: `requestedRefunds: null` è **rifiutato**; `undefined` vale «assente»; le proprietà estranee si scartano senza errore e non si leggono mai; un rifiuto per qualunque input non lascia le richieste nell'evidenza; `ref` è il solo nome `requestedRefunds`; il dominio resta di P1.
- **D6:** i casi di H13 sono un insieme ammesso, non una quota (precisazione A).
- **D7:** N3 incluso in forma leggera: un test verifica che questa sezione esista e nomini i 9 codici di `FUNDS_READ_NOT_VERIFIED` (non i numeri dei casi).
- **D8:** nessun campo di decisione o di garanzia; `FUNDS_READ_NOT_VERIFIED` è lo stesso array congelato in ogni rapporto.
- **Scelte ulteriori (nessun'altra cosa di R2 è cambiata):** (a) il controllo di flusso non modellato guarda **anche l'addebito**, non solo il pagamento; (b) i movimenti già in linea dei rimborsi si **verificano come quelli delle contestazioni** (tipo e id); (c) il richiamo di chiusura è **controllato come la prima lettura** (un altro pagamento, un altro tipo, una modalità sparita o diversa: confronto non fatto, struttura incompleta, evidenza = la prima lettura); (d) nel confronto di chiusura `null`, `NaN`, `Infinity`, `0` e `-0` sono **diversi** (JSON li renderebbe uguali); (e) il tetto sui movimenti letti e il tetto sulle pagine sono riportati come `budget` con `ref` `movements` e `pages`; (f) l'evidenza del pagamento e dell'addebito è quella del **richiamo di chiusura** quando questo è utilizzabile (se le due letture sono «uguali» le due proiezioni coincidono: la scelta conta solo quando differiscono).

### Risultati

Tutto ciò che segue è stato ottenuto **sul codice definitivo (dopo D5)**, tranne dove è detto che si tratta del rosso, contro il lettore precedente a D5. Nessuna cifra di prima di D5 è riportata come esito.

#### Prove rosso → verde

- **Rosso (D5).** I test furono scritti **per primi**: i quattro che codificavano il vecchio contratto (C8, I5, J8b, G15) cambiati, il gruppo R (R1–R11) nuovo, i controlli di compilazione in A6. Eseguito contro il lettore **precedente a D5** (quello che inoltrava le richieste per riferimento): **161 test, 145 verdi, 16 rossi** — C8, I5, J8b, G15, R1, R2, R3, R3b, R3d, R4, R5, R6, R7, R8, R9, R10 —, ciascuno per il motivo atteso: la lista del chiamante tornava indietro com'era («non lo stesso array»); l'evidenza mostrava la lista già modificata dal chiamante a Promise in attesa (R1); le proprietà estranee e i dati personali viaggiavano (R2, R9); le liste non valide non erano rifiutate e le chiamate partivano (R3, R10); un `{ id: undefined }` restava una chiave (R4, R8); il lettore non leggeva nulla per indice e per nome (R6); il limite non esisteva (R9). I **due che passano anche prima** (R3c, R11) custodiscono ciò che D5 non deve spostare: un valore del tipo giusto ma fuori dominio e `NaN`/`±Infinity`/`-0` arrivano esatti, e P1 li rifiuta. `npm run typecheck` contro i tipi di prima: **1 errore** (`TS2578`: il `@ts-expect-error` che esclude `null` dall'uscita non era soddisfatto).
- **Verde.** Dopo la modifica minima del lettore (una funzione `takeRequested` di 28 righe chiamata per prima da `validate`, i tipi, i commenti): alla prima esecuzione **160/161** — l'unico rosso era un **errore mio nel test** R3b (percorreva l'array con l'iteratore che aveva già sostituito con una trappola), corretto nel test senza toccare il modulo — poi **161/161** e `tsc` a 0 errori.
- **Rosso informativo** contro un lettore ingenuo scritto fuori dal repository (una pagina per lista, un errore diventa una lista vuota, filtri e opzioni in un solo oggetto, nessun richiamo di chiusura, nessun controllo di identità e di modalità, richieste copiate con `[...lista]`): **161 test, 44 verdi, 117 rossi**; dei test di D5 falliscono tutti tranne R3c e R11.

#### Test eseguiti

File dedicato `tests/stripe-funds-reader.test.ts`: **161 test** (147 prima di D5: i 14 del gruppo R sono i nuovi) — Z0 7 (il finto è fedele a Stripe, indipendentemente dal lettore) · A 10 (guardie statiche, sola lettura, superficie fissa, compilazione) · B 10 (casi ordinari) · C 15 (rimborsi e inversioni; **C8: richieste copiate**) · D 5 (contestazioni) · E 12 (paginazione e incompletezza) · F 7 (appartenenza, duplicati, valute) · G 22 (letture fallite, input, tempi) · H 15 (coerenza temporale osservabile, matrice H13) · I 10 (proiezione, read-set, nessun dato personale) · J 10 (compatibilità con P1 e P1-bis, invarianti I1, I1b′, I1c) · K 4 (SDK vero con `httpClient` finto, a livello di filo) · L 3 (rete rifiutata) · M 13 (integrità: modalità, identità, riferimenti, omissioni) · N 1 (contratto e documentazione) · Q 3 (ciò che non deve mai comparire nel rapporto) · **R 14 (D5: richieste, tipi, limite di 1.000, JSON e numeri anomali)**. Il finto (`tests/_fake-stripe-funds.ts`) non ha richiesto modifiche per D5: il client «a cancello» che tiene in sospeso una Promise di Stripe è costruito nel test sopra il finto.

Gruppo R, in breve: **R1** il chiamante cambia tutto (valori, proprietà, oggetti, array) subito dopo la chiamata, con una Promise in attesa in ciascuno dei cinque punti in cui la lettura aspetta (lettura del pagamento, prima pagina dei rimborsi, delle contestazioni, una transazione di saldo, richiamo di chiusura), dopo il ritorno, con oggetti congelati, e dentro il codice del chiamante che la lettura esegue per primo (client, orologio, opzioni, altri campi della richiesta); **R2** proprietà estranee con dati personali, getter e `Proxy` che registrano o lanciano; **R3/R3b/R3c/R3d** tabella dei rifiuti (contenitori, elementi, buchi, tipi, accessi che lanciano, `Proxy` revocati, metodi dell'array sostituiti da trappole), confine tipo/dominio, oggetti di qualunque tipo; **R4** assente ≠ `null` ≠ `undefined`; **R5** duplicati legittimi e conflittuali (incluso lo stesso oggetto due volte) con differenziale contro P1; **R6** una sola lettura di ogni cosa e un getter che cambia risposta; **R7** nessuna condivisione fra letture e nessuna traccia di un rifiuto; **R8** proprietà su mondi coerenti, sporchi, fermi e in movimento (richieste valide, anche fuori dominio e con id di rimborsi elencati): copia fedele, P1 sulla copia = P1 sulla lista del chiamante, fail-closed, mondo fermo = oracolo con le richieste; **R9** il limite; **R10** tipi e assenza reale della chiave; **R11** numeri che JSON non sa scrivere.

#### Prove differenziali e proprietà

Le proprietà (monotonia di P1 sui mondi coerenti J6; fail-closed J7; mondo fermo J8a; provenienza J8b; fedeltà della proiezione I2; read-set di P1 su ≥ 1.000 mondi I8; terminazione sotto avversari G9/G10; omissioni M14; richieste R8) girano su mondi casuali generati con **semi fissi `1..N`** (`mulberry32`: nessun `Math.random`, un fallimento si rigioca dal seme che il messaggio riporta), con `N = FUNDS_READER_WORLDS`:

| N | Esito del file dedicato | Durata |
|---:|---|---:|
| 800 (predefinito, anche in `npm test`) | 161/161 | 6,6 s |
| 20.000 | 161/161 | 99,9 s |
| 100.000 | 161/161 | 471,2 s |

Nessuna divergenza non spiegata fra il lettore e P1, né fra il lettore e l'oracolo del finto.
- **H13 (matrice evento × momento):** 105 casi per variante. Senza che Stripe conti nell'aggregato un rimborso `requires_action`: **28** casi «favorevoli e non visti» = le **23 triple di R2.1, tutte riprodotte (nessuna è migliorata)** più **5 istanze** trovate da questa implementazione sulla base «rimborso già `pending`» (`X1|B-d|T4`, `X5|B-d|T4`, `X9|B-d|T2`, `X9|B-d|T3`, `X9|B-d|T4`), tenute in un insieme separato e fissate come solo limite inferiore di una posizione che resta incerta; se Stripe lo conta: **20**. `retainedIsZero = yes` non è mai stato promosso. Il 23 resta un risultato di quella simulazione, non un invariante.
- **M14 (omissioni):** a 100.000 mondi, le omissioni che il lettore sa riconoscere (oggetto, campo, id non risolto): **95.988 casi, 0 promozioni**; la voce tolta da una lista che dichiara di essere completa, che il lettore non può riconoscere: **4.012 casi, 738 promozioni** (a 20.000 mondi: 19.215 e 0; 785 e 145). È il limite dichiarato R-1, fissato da J9c e da M14.

#### Mutazioni (su una copia fuori dal repository, una per volta, ripristino verificato)

Il banco ha **276 mutazioni** del lettore: 216 del banco precedente (quattro delle quali, J16, R16, N42 e N47, riscritte perché toccavano le righe delle richieste; J15, che trasformava l'inoltro per riferimento in una copia, non ha più senso ed è tolta: la mutazione opposta è D01) più **60 nuove per D5** (D01–D60: inoltro per riferimento; oggetti del chiamante nella copia; proprietà estranee, enumerazione, sonda con `in`, metodi dell'array; `null` ↔ assente ↔ `undefined`; deduplicazione; scarto silenzioso di elementi; conversioni e normalizzazioni — numero da stringa, `-0`, maiuscole, `trim`, id vuoto; contenitori che non sono array; buchi; tipi accettati per errore; limite spostato di uno, tolto, controllato dopo, lunghezza riletta, copia parziale, lunghezze patologiche; copia presa dopo il client, dopo i campi della richiesta, dopo le opzioni, dopo l'orologio, o ripresa alla fine; eccezioni non catturate; rapporti che perdono o inventano la chiave). Il banco rifiuta di partire se i test della copia non sono verdi, e a fine passata verifica che il file del repository sia identico.

| Passata | Mutazioni | Rilevate | Sopravvissute | Non applicate |
|---|---:|---:|---:|---:|
| Le 64 di D5 (60 nuove + 4 riscritte), codice di D5 | 64 | 63 | **1** (D28) | 0 |
| **Banco completo, file definitivi** | **276** | **273** | **3** | **0** |

Per famiglia (tutte rilevate tranne le equivalenti): liste 30, transazioni di saldo 24, pagamento 13, addebito 12, contestazioni 6, richieste (D5) 60, proiezione 22, rapporto 22, tempo 22, errori 14, input 20, predefiniti 5, stato 4, temporale 20, scritture 2.

Le **3 sopravvissute sono equivalenti** (nessun test le uccide per caso; il comportamento osservabile non cambia):
- **T34** — `calls >= maxCalls` scritto `>`: la guardia è irraggiungibile, perché ogni ciclo ha il proprio tetto e la somma dei tetti è esattamente `maxCalls`; scatterebbe solo al tentativo numero `maxCalls + 1`, che nessun ciclo può fare.
- **N53** — adottare il pagamento del richiamo di chiusura solo quando differisce: se il richiamo dice «uguale» le due proiezioni sono identiche, quindi adottarle o no dà la stessa evidenza.
- **D28** — tolto `typeof length !== 'number'` dal controllo della lunghezza: a runtime è ridondante (`Number.isInteger` rifiuta ogni non-numero: stringhe, `BigInt`, oggetti); serve al compilatore per restringere il tipo di una lunghezza che arriva come `unknown`.

Contabilità onesta: nessuna passata è stata interrotta o scartata; la passata sulle 64 mutazioni di D5 fu eseguita **prima** di aggiungere a R3 tre valori «boxed» (`new String`, `new Number`), e il banco completo **dopo**, sui file definitivi (impronte registrate, identiche all'inizio e alla fine). Un solo errore mio nei test di D5 (R3b, sopra) emerso in fase verde; nessuna mutazione sopravvissuta non equivalente ha richiesto di cambiare un test. Le mutazioni D47–D50 (ordine di acquisizione) sono rilevate soltanto da R1e, scritto apposta.

#### Altri risultati

- `npx tsc --noEmit`: **0 errori** (include i test, quindi le prove di compilazione: client reale = interfaccia, nessun metodo di scrittura, uscita = evidenza di P1, `requestedRefunds` opzionale e senza `null`).
- `npm run lint` (`--max-warnings=0`): **0 avvisi**.
- `npm test`: **1698 test, 1698 verdi, 0 falliti** (1537 della baseline di HEAD + 161 nuovi); `tests/payment-hold-evidence.test.ts`: **587/587, invariato**.
- **Rete rifiutata, due volte e in modo indipendente.** (1) Nel file stesso: ogni connessione (`http`, `https`, `net`, `fetch`) rifiutata e registrata fin dal caricamento; L1 prova che il rifiuto funziona (4 tentativi di controllo verso un host `.invalid`, rifiutati e registrati), L3 — l'ultimo test — che la lettura e tutto il resto non ne hanno fatto **nessuno**. (2) Da fuori: il file eseguito con `node --import <preload>` che sostituisce `net.Socket.connect`, `net.connect`, `tls.connect`, `dns.*`, `http(s).request/get` e `fetch` con un rifiuto che registra ogni tentativo: **161/161**; il registro contiene soltanto **2 `net.connect` verso la pipe locale del caricatore `tsx`** (`/tmp/tsx-0/<pid>.pipe`, un socket di file, non rete) e **nessun tentativo verso un host o un indirizzo**; il controllo negativo (stesso preload, uno script che tenta `http.get`, `https.request`, `net.connect`, `tls.connect`, `dns.lookup`, `fetch`, `net.Socket.connect` verso `control.invalid`) dà **7 tentativi su 7 rifiutati e registrati**. Nessuna variabile `STRIPE_*`, nessuna chiave autentica (L2: l'unica chiave nei file è il segnaposto `sk_test_FAKEOFF1234`).
- **Isolamento:** nessun file di `app/`, `lib/`, `components/`, `scripts/`, `prisma/` né della radice nomina o importa il lettore (A4, con `ALLOWED_IMPORTERS = []`; più una ricerca testuale indipendente prima del commit); P1 non nomina il lettore e il lettore non nomina P1.
- **Perimetro:** `git status --porcelain` mostra i soli quattro percorsi del pacchetto (`lib/stripe-funds-reader.ts`, `tests/stripe-funds-reader.test.ts`, `tests/_fake-stripe-funds.ts`, `docs/VERIFICA-4.6.md` con questa sola sezione in coda); `git diff --check` e `git diff --cached --check` puliti prima del commit.
- `test:security` (richiede un database) **non eseguito**: nulla sotto `app/`, `prisma/`, `components/` o negli altri file di `lib/` è cambiato.

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **Voce mancante in una lista che dichiara `has_more: false` (R-1 del piano R2).** Il lettore non può sapere che cosa Stripe non restituisce; P1 la vede soltanto se aggregato o flag la rivelano. M14 la misura (sopra); la mitigazione a valle (età massima dell'evidenza, concordanza di due letture) è un'**ipotesi per P4, non approvata**.
- **ABA, modifiche dopo l'ultima lettura, contestazione che cambia con il flag fermo (R-2, R-3, R-4).** Nessun segnale è possibile per definizione: `no_change_observed` è «nessun segnale visto», non «stabile». `final` di P1 non vuol dire «stabile nel tempo» (vedi sopra): il lettore non espone alcun campo di definitività.
- **Pagamento mai addebitato (D-2 del piano P3a.0).** `latest_charge: null` dà `none_reported` e P1 risponde `uncertain` / `retainedIsZero: unknown`: limite noto, fissato da test («KNOWN LIMIT»), che cambierà solo con un eventuale P1-ter.
- **Le richieste dell'applicazione (D5).** (a) Un oggetto di qualunque tipo (`Map`, `Date`, istanza di classe) è letto per i tre nomi: se manca l'importo la copia è `{}` e P1 la rifiuta per `invalid_amount` (R3d). (b) Il lettore **esegue una volta** il codice del chiamante che sta dietro alle proprietà ammesse (un getter): non può evitarlo; lo rende innocuo (prima di tutto, una sola lettura, tutto o niente), non assente. (c) La copia è superficiale **perché basta**: i valori ammessi sono scalari immutabili. (d) Il limite di 1.000 è una protezione di risorse: una lista più lunga è rifiutata per intero e chi chiama dovrà gestirla; non è un parere sul business. (e) `NaN`, `±Infinity` e `-0` sono consegnati esatti: **chi serializza l'evidenza in JSON li perde** (`null`, `null`, `null`, `0`) e nessuna immagine JSON può essere fonte di una decisione finanziaria.
- **Modalità di rimborsi e transazioni (R-9 del piano R2) e configurazione a monte (R-10).** `Refund` e `BalanceTransaction` non dichiarano `livemode` nei tipi dell'SDK: la loro modalità è solo implicata; `expectedLivemode` nasce dalla stessa configurazione della chiave e non rileva una chiave sbagliata a monte.
- **Orologio e Promise.** Gli orari vengono da un orologio iniettato (R-11); una Promise che non si risolve lascia la lettura in sospeso: il tetto assoluto resta del chiamante.
- **Fixture simulate ≠ osservazioni Stripe reali.** Ogni oggetto dei test è **costruito**, sul modello dei tipi dell'SDK e di ciò che i collaudi in Test Mode del titolare hanno osservato (S6a.17–S6a.19); **nessuna chiamata a Stripe è stata fatta, nemmeno in Test Mode**. Non sono mai stati osservati: `disputes.list({ payment_intent })` (filtro, ordine, forma di `balance_transactions`, cursore), `refunds.list` con rimborsi `failed` o `requires_action`, se `amount_refunded` conta `requires_action`, `livemode` sugli oggetti reali, i permessi della chiave ristretta di produzione, la coerenza in lettura dopo una scrittura, le latenze reali. Se un'ipotesi è falsa il lettore **fallisce chiuso** (posizione incerta), ma può bloccare ordini. Un'osservazione reale (chiamata AR-3 nel piano) **non è autorizzata** e richiederebbe un'autorizzazione separata. Test Mode non è Live; nessuna prova su dispositivi reali.
- **Restano aperte e invariate** R1 (non accettato, bloccante per il lancio); 1.44a (archiviazione del rapporto e accettazione scritta), 1.44b (nessuna accettazione distinta), 1.44c (T6, `requires_action`, `canceled`: accettazioni non ancora date), 1.44d (sottoscrizione applicativa di `refund.*`, consegna non dimostrata); F02, F03 e F12 (1.63); le sette ipotesi di P1 e il limite noto di `retainedAtLeast`; l'integrazione con `payment-sync`, contestazioni e revisione finanziaria (**non fatta**, da autorizzare a parte, con la modifica deliberata di `ALLOWED_IMPORTERS`); le regole di decisione (recenza, concordanza di due letture, soglie, `accepted`, `no_charge`, rilascio: P4); il rimborso governato (P5), AP-ESC, AP-PRIV, S6b, il Passo 5, le migrazioni su database reale. **P3b, P4, P5 e S6b non sono avviati.** Nessuna accettazione scritta è stata registrata da questo pacchetto.

### Come riprodurre

`node --test --import tsx tests/stripe-funds-reader.test.ts` (offline, nessuna chiave, 800 mondi per le proprietà); `FUNDS_READER_WORLDS=20000 node --test --import tsx tests/stripe-funds-reader.test.ts` e `FUNDS_READER_WORLDS=100000 …` per le prove grandi (semi `1..N` fissi); `node --test --import tsx tests/payment-hold-evidence.test.ts` (587); `npx tsc --noEmit`; `npm run lint`; `npm test`. Il rosso di D5 si riproduce eseguendo il file di test contro un lettore che inoltri `requestedRefunds` per riferimento (la prima versione, mai committata); il rosso informativo e le mutazioni si eseguono su copie fuori dal repository (non c'è un comando nel progetto: un banco di mutazioni, un lettore ingenuo e un preload che rifiuta e registra la rete sono rimasti nella cartella di lavoro della sessione, non nel repository). Nessun passo richiede Stripe, una chiave o un database.

## S6a.23 P3b-1: F02 «default-deny» e coerenza dei tentativi di pagamento (`lib/payment-attempt-legs.ts`, `lib/payment-hold.ts`)

Questo pacchetto stringe **una sola cosa** della decisione «nessun addebito» di `payment-hold`: l'**assenza di un identificativo Stripe in un tentativo di pagamento non è più letta come prova che nulla sia stato addebitato** (F02), e la decisione è protetta dai cambiamenti dell'**insieme** dei tentativi mentre si interroga Stripe (correzione vincolante dell'audit indipendente). Punto di partenza: HEAD `5d1e8666a68e293319e2965b9afc1b44cbdf78a4` (P3a.1, S6a.22), ramo `claude/stampa3d-fase1`, albero pulito. Il piano P3b.0 è stato approvato come architettura di riferimento; di esso è autorizzato **solo** P3b-1. **F02 non è chiusa formalmente** (sezione «Limiti»); F03, F12 e R1 restano aperti e invariati.

Le frasi di S6a.16 e di §15.10–§15.11 di `docs/RILASCIO-PRODUZIONE.md` secondo cui «un tentativo senza identificativi Stripe vale ancora «nessun denaro»» descrivono lo stato **di allora** (HEAD `5d1e866` e precedenti): non sono riscritte (storia), questa sezione le supera per F02. Le altre menzioni storiche di F02 come «resto di P4» (S6a.22, `docs/CHECKOUT-S2-S3.md`, `docs/PROGETTO.md`) restano vere: F02 non è chiusa formalmente. Nella checklist (riga 1.63) e in `docs/RILASCIO-PRODUZIONE.md` (§15.10 punto 1, con un rinvio in §15.11) è aggiornato soltanto lo stato di F02.

### Ambito e confine

- **File del pacchetto (solo questi sette):** `lib/payment-attempt-legs.ts` (nuovo, **puro, zero import**), `lib/payment-hold.ts` (modifica minima), `tests/payment-attempt-legs.test.ts` (nuovo, offline, in `npm test`), `tests/security/payment-hold.sec.ts` (estensione: da 16 a 67 test), questa sezione, `docs/CHECKLIST-PRELANCIO.md` (riga 1.63) e `docs/RILASCIO-PRODUZIONE.md` (§15.10 punto 1).
- **Non toccati:** P1 (`lib/payment-hold-evidence.ts`, 587 test), P1-bis, il lettore (`lib/stripe-funds-reader.ts`, 161 test), `lib/payment-sync.ts`, `lib/stripe-webhook.ts`, `lib/checkout-sessions.ts`, `lib/order-payment-policy.ts`, `prisma/` (nessuna migrazione), rotte, componenti, configurazioni, dipendenze. **Il ramo `accepted` non è modificato** (le sue righe sono identiche; nella transazione non prende alcun lock in più, C7b; F03 resta aperta: il test C6b lo fissa).
- **Non collegato a P1 né al lettore.** Il modulo nuovo non nomina nessuno dei due e `payment-hold.ts` nemmeno (le due guardie di isolamento, con `ALLOWED_IMPORTERS = []`, sono invariate e verdi); solo `lib/payment-hold.ts` importa il modulo nuovo (guardia L21).
- **Nessuna nuova chiamata a Stripe** (sezione «Nessuna nuova chiamata»), nessuna chiamata reale nemmeno in Test Mode, nessuna chiave autentica, nessun rimborso, deploy, migrazione.

### Il difetto F02, com'era

`readChargeEvidence` (HEAD `5d1e866`) chiedeva a Stripe dei tentativi che hanno un `stripeSessionId` o uno `stripePaymentIntentId` e **saltava gli altri**: se nulla di ciò che aveva chiesto mostrava denaro o dava errore, rispondeva `'none'` e la decisione registrava `confirmed_no_charge`, la «conferma» di un'interrogazione **che nessuno aveva fatto**. Un tentativo senza identificativi nasce in cinque modi (da `lib/checkout-sessions.ts`): una prenotazione `creating` la cui risposta di Stripe non è ancora stata salvata; una prenotazione scaduta (`expired` / `stale_reservation`, richiesta morta); un rifiuto del fornitore non ritentabile (`failed`); una sessione che non corrisponde all'ordine (`failed` / `session_mismatch:*`: la sessione **esiste** a Stripe, non è salvata); un tentativo aperto che ha perso la sessione (`failed` / `open_without_session`). In tutti questi casi Stripe può avere una sessione e non c'è nulla da chiederle. Un ordine con **solo** tentativi di questo tipo — o con altri tentativi che non mostrano denaro — poteva essere cancellato «per nessun addebito» senza alcuna verifica.

### Contratto implementato (tutto fallisce chiuso)

| Regola | Che cosa succede |
|---|---|
| **Tentativo leggibile** | ha almeno un identificativo Stripe **ben formato** (`cs_…` per la sessione, `pi_…` per il pagamento: prefisso, poi lettere, cifre o `_`, 1–255 caratteri, gli stessi formati che l'applicazione accetta altrove). Solo di questi si chiede a Stripe. |
| **Identificativo assente** | `null`, `undefined`, stringa vuota o proprietà mancante: «assente». Un tentativo senza alcun identificativo **non è verificabile**. |
| **Identificativo presente ma non valido** | un valore non stringa (numero, oggetto…), vuoto-ma-non-assente, con altro prefisso, spazi, caratteri estranei o troppo lungo **non è un identificativo**, e **non è mai «riparato»**: un'immondizia accanto a un identificativo buono rende non leggibile **l'intero** tentativo (il buono non viene letto attraverso l'altro campo). |
| **Tentativo senza `id` proprio / stesso `id` descritto in due modi** | non si distingue da un altro: non verificabile. Lo stesso `id` con sessione, pagamento o stato diversi è una **contraddizione**: nessuna delle sue descrizioni è un canale verificato (una ripetizione identica è solo una ripetizione). |
| **Nessuna eccezione** | non per una prenotazione scaduta, non per un fallimento con motivo, non per un tentativo scaduto da giorni. Se e con quale margine fidarsene è una decisione del titolare (DP-3), **non** di questo pacchetto. |
| **Combinazione** | il denaro su un canale **prevale su tutto** (`CHARGE_EXISTS`, anche se un altro tentativo non ha identificativi o una lettura è fallita); altrimenti è «sconosciuto» se c'è un tentativo senza identificativi, una lettura fallita o un tentativo con identificativo **senza esito** di lettura (un esito mancante o non riconosciuto non è mai «nessun denaro»); è «nessuno» **solo** se ogni tentativo è stato interrogato e nessuno ha mostrato denaro. |
| **Dati fuori contratto** | una lista che non è una lista lascia **un** segnaposto non verificabile (mai «nessun tentativo»); una riga che non è un oggetto prende il suo posto come tentativo non verificabile; un getter che lancia è un dato illeggibile; un `Proxy` revocato non fa lanciare nessuna funzione. Nessuna promozione favorevole. |
| **Il cancello** | `no_charge` prosegue **solo** se la risposta è esattamente `none` e la sincronizzazione che precede è riuscita; `money` → `409 CHARGE_EXISTS`; ogni altra cosa → `409 STRIPE_UNVERIFIABLE` (stesso codice di F01), con un messaggio che distingue «un tentativo non ha identificativi Stripe: serve assistenza» da «Stripe non ha risposto: riprovare». Nessun testo del rifiuto invita a dichiarare qualcosa. |

**Dove sta ciascuna parte.** `lib/payment-attempt-legs.ts` (217 righe, zero import, nessun I/O, orologio, ambiente o stato fra due chiamate) esporta cinque nomi: `classifyAttemptLegs`, `combineLegEvidence`, `snapshotAttempts`, `attemptSetsMatch`, `ATTEMPT_LEG_BASES` (congelato). In `lib/payment-hold.ts` le letture esistenti sono state **spostate senza cambiarne il comportamento** nella funzione `showsMoney` (stesse chiamate, stesse opzioni, timeout 8 s, stessi stati che valgono denaro: `succeeded`, `processing`, `requires_capture`); `readChargeEvidence` legge **solo** i tentativi leggibili, si ferma al primo denaro, registra un errore come `unreadable` e continua con gli altri (un denaro trovato dopo prevale), e consegna la combinazione al modulo puro.

### Il controllo sotto lock (correzione vincolante dell'audit)

Prima di leggere qualunque prova, `no_charge` prende **una copia immutabile** dei tentativi esaminati (`id`, `stripeSessionId`, `stripePaymentIntentId`, `status`; oggetti congelati, nulla condiviso con le righe): Stripe si interroga **su quella copia**, non sulle righe vive. Nella transazione finale, **dopo** il lock dell'ordine e la rilettura, l'insieme trovato si confronta con la copia **per `id`, identificativi e stato, non per numero di righe**, in qualunque ordine; ciò che non si può confrontare (non una lista, una riga senza `id`, un `id` due volte) è «diverso». Se non coincide: `409 STRIPE_UNVERIFIABLE` («i tentativi sono cambiati mentre si interrogava Stripe: chiedere di nuovo») **prima di qualunque scrittura** — nessun `confirmed_no_charge`, nessuna cancellazione dell'ordine, nessun tentativo chiuso, nessuna sessione chiusa (la chiusura best effort sta **dopo** il commit, come prima), nessuna risoluzione amministrativa, nessun evento di audit, **nessuna chiamata a Stripe sotto lock**. I controlli già presenti sotto lock (non più in blocco, rimborso in corso, pagamento incassato nel frattempo, ordine non pagato) restano obbligatori e **vengono prima** del nuovo: un pagamento che si perfeziona durante la lettura è riportato come `PAYMENT_COLLECTED` (C9, anche quando si chiude pure il tentativo che si stava confermando), un rimborso richiesto nel frattempo come `REFUND_IN_PROGRESS` (C10).

**Perché si bloccano anche le righe dei tentativi.** Tutti gli scrittori di `PaymentAttempt` dell'applicazione, ricercati su `app/`, `lib/`, `scripts/`, `components/`: `lib/payment-sync.ts:487` (sotto il lock dell'ordine, `:116`), `lib/checkout-sessions.ts` prenotazione `:166`/`:172` (sotto il lock dell'ordine, `:145`) e `:206` (sotto il lock, `:205`) — questi la decisione li ferma **già** con il lock dell'ordine, compresa ogni **inserzione**; e **due scrittori che il lock dell'ordine non fermano**: `closeAttempt` (`:197`) e il salvataggio dell'id di sessione (`:244`), due `updateMany` secchi senza transazione. Per questi, nella transazione di `no_charge` si prende anche `SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = … FOR UPDATE` (prima l'ordine, poi i tentativi: lo stesso ordine di tutti gli altri scrittori, quindi nessuno stallo; solo per `no_charge`, `accepted` non prende alcun lock sui tentativi). Così una modifica di un tentativo è o **già committata** (e la rilettura la vede: rifiuto) o **attende** la fine della decisione. `PaymentAttempt` non ha tabelle figlie (nessuna chiave esterna lo referenzia) e le sue colonne `stripeSessionId` e `stripePaymentIntentId` sono `@unique`.

**Che cosa NON dice questo controllo.** Il lock è **nostro**: non impedisce a Stripe di cambiare dopo l'ultima lettura (un cliente che completa una pagina fra la lettura e il commit; rimborsi e contestazioni, che questo controllo non legge). Dopo il commit la chiusura delle pagine aperte (`sessions.expire`) resta best effort come prima, e un pagamento che arrivasse comunque su un ordine annullato continua a essere registrato e mostrato a una persona (`paid_after_cancel`, flusso esistente, non toccato). Il pacchetto **non** dichiara di prevenire cambiamenti esterni.

### Nessuna nuova chiamata a Stripe

L'insieme delle chiamate di `lib/payment-hold.ts` è invariato: `checkout.sessions.retrieve`, `paymentIntents.retrieve` (due punti), `checkout.sessions.expire` (guardia statica L21, che confronta l'elenco esatto). Provato anche **a runtime**: (1) la tabella R1–R19 fissa, per ogni forma di tentativo, **le chiamate esatte** (metodo, id, `expand`, timeout 8000, ordine) e l'arresto al primo denaro, e passa **identica sul cancello di HEAD** (sotto); (2) il differenziale sul cancello (sotto): a dati ben formati le sequenze di chiamate del vecchio e del nuovo cancello sono **identiche** in 89.544 mondi su 100.000, e in quelli fuori contratto il nuovo ne fa **meno** (170.347 chiamate contro 188.074) e **non chiede mai** a Stripe un id che non abbia la forma di un id Stripe (il vecchio lo fece in 7.300 mondi); (3) i test C1 e C4 contano le letture (due: la sincronizzazione e il controllo; nessuna sotto lock né dopo). Il nuovo cancello può, in un mondo fuori contratto, leggere un tentativo **successivo** a quello su cui il vecchio si era fermato (perché il vecchio si ferma al primo denaro, anche su un tentativo che il nuovo non considera leggibile): è lo stesso tipo di chiamata per un tentativo che il vecchio avrebbe letto comunque.

### Risultati

Tutto ciò che segue è stato ottenuto sul **codice definitivo** (impronte SHA-256 dei quattro file di codice e di test registrate all'inizio e alla fine della catena di verifica: identiche; HEAD invariato `5d1e866…`; `git status --porcelain` = soli i quattro file di codice e di test, prima della scrittura dei tre file di documentazione).

#### Prove rosso → verde

- **Rosso.** I test sono stati scritti per primi. Contro il codice di HEAD: il file puro **18 test, 0 verdi, 18 rossi** (il modulo non esiste: importazione pigra, ogni test cade da solo); il file `payment-hold.sec.ts` di allora (37 test: i 16 esistenti più 21 nuovi) **21 verdi, 16 rossi** — i rossi sono quelli che pretendono il comportamento nuovo (`200` al posto di `409`; cancellazione dell'ordine con tentativi cambiati sotto i piedi).
- **Verde.** Dopo il modulo e la modifica minima del cancello: file puro 18/18, `payment-hold.sec.ts` 38/38 (con C6b), `tsc` e lint a 0.
- **Dopo il banco di mutazioni** (sotto) il file di sicurezza è passato da 38 a **67 test** (tabella R1–R19, H13 ×4, C7 su due tentativi, C7b, C8, C9 ×2, C10) e il file puro ha avuto nuove asserzioni; ogni aggiunta è giustificata da una mutazione sopravvissuta (elenco sotto). Questi test **non** hanno avuto una propria fase rossa «contro HEAD»: la loro prova è che le mutazioni che li giustificano ora cadono. **Rosso informativo** dei file definitivi contro il cancello di HEAD (copia fuori dal repository, database clonato): il file di sicurezza **67 test, 45 verdi, 22 rossi** — rossi: H1–H4 (6), H5, H10, H11, C1, C1b, C2, C2b, C3, C3b, C7 (2), C8, H13 (4); verdi: i 16 esistenti, H6, H7, H8, C4, C6b, H9, C7b, C9 (2), C10 e **tutte e 19 le R** (cioè la tabella delle letture fissa il comportamento che HEAD aveva già); il file puro **17 verdi, 1 rosso** (L21, la guardia statica sul cancello nuovo).

#### Test eseguiti (sul codice definitivo)

`tests/payment-attempt-legs.test.ts` — **18 test**, offline: L1–L3 (leggibile: sessione, pagamento, entrambi; l'altro id assente in ogni modo, anche come proprietà mancante) · L4–L6 (nessun identificativo, a ogni stato/motivo/scadenza: nessuna eccezione) · L7 (valori non stringa: presenti e mai validi) · L8 (un canale per tentativo, in ordine) · L12 (forme non Stripe: spazi, altri prefissi, prefisso dell'altro campo, caratteri estranei, lunghezza 255/256, qualcosa **prima** del prefisso) · L13 (contraddizioni) · L14 (dati fuori contratto: contenitori, righe che non sono oggetti — anche un array con i campi di un tentativo —, getter che lanciano, `Proxy` revocati) · L9 (combinazione: 19 casi con conteggi) · L15 (la combinazione non si fida di ciò che non è nel contratto: liste di canali illeggibili, gemelli con due basi **con i conteggi**, esiti non `Map`) · L16–L19 (copia immutabile, valori non stringa, confronto dell'insieme: inserzione, cancellazione, `id`/identificativo/stato cambiato, **sostituzione a parità di numero**, conservativo su tutto ciò che non si fida) · L20 (puro e totale) · **L10** (differenziale di monotonia contro la regola vecchia su mondi casuali con semi fissi `1..N`) · L11/L11b (purezza e superficie fissa) · L21 (isolamento; elenco esatto delle quattro chiamate Stripe; ogni parte del modulo è usata dal cancello; passa solo `evidence.verdict !== 'none'`).

`tests/security/payment-hold.sec.ts` — **67 test** su database isolato, Stripe finto, rete rifiutata: i 16 preesistenti (invariati) più 51 nuovi — **H1–H4** (sei origini di tentativo senza identificativi: `creating`, prenotazione scaduta, errore del fornitore, `session_mismatch`, `open_without_session`, scaduto da un giorno → `409`, nessuna lettura, nulla scritto) · **H5** (uno interrogato senza denaro + uno senza identificativi → `409`, due letture e non una di più) · **H6/C5** (denaro + un tentativo senza identificativi → resta `CHARGE_EXISTS`, col messaggio del denaro) · **H7/C4** (tutti interrogabili, nessun denaro → `200 confirmed_no_charge` come prima, tre letture) · **H8/C6** (`accepted` invariato con un tentativo senza identificativi) · **C6b** (F03 aperta, fissata) · **H9** (tentativo interrogabile con Stripe muto + uno senza identificativi) · **H10** (due decisioni simultanee, entrambe rifiutate) · **H11** (una volta aggiunto l'identificativo la stessa richiesta si decide su Stripe) · **C1/C1b** (compare / sparisce un tentativo durante la lettura) · **C2/C2b** (cambia l'id di sessione / compare un id di pagamento) · **C3** (stesso numero di righe, tentativi diversi) · **C3b** (cambia lo stato) · **C4** (cambiano colonne non esaminate: scadenza, nota → `200`) · **C7** ×2 (uno scrittore **che non prende il lock dell'ordine** tiene il tentativo più recente / quello più vecchio: la decisione **attende** — attesa dimostrata interrogando `pg_stat_activity`, mai con un ritardo fisso — poi vede la modifica e rifiuta) · **C7b** (`accepted` non attende uno scrittore dei tentativi: non prende alcun lock su di essi) · **C8** (un writer che segue l'ordine ordine→tentativi non finisce mai in stallo con la decisione) · **C9** ×2 (pagamento incassato durante la lettura, con e senza modifica del tentativo → `PAYMENT_COLLECTED`, ordine mai cancellato) · **C10** (rimborso richiesto durante la lettura → `REFUND_IN_PROGRESS`) · **R1–R19** (le letture del controllo, con Stripe **scritturato**: sessione pagata, pagamento espanso in `processing`/`requires_capture`/`succeeded`/`canceled`, pagamento ricevuto come id e letto direttamente, tentativo con solo il pagamento, tentativo con entrambi gli id letto **solo** dalla sessione, lettura che fallisce, denaro trovato dopo un fallimento, arresto al primo denaro, nessun denaro ovunque con ogni tentativo letto una volta, in ordine) · **H13** ×4 (id non Stripe: sessione, pagamento, sessione con prefisso di pagamento, sessione buona accanto a un pagamento malformato → `409`, **e Stripe non viene interrogato** su di essi). Tutte le modifiche «durante la lettura» sono fatte dal gancio `afterSnapshot` del finto Stripe, mai da ritardi. Una decisione rifiutata **non introduce scritture proprie**: i test distinguono i registri tecnici della sincronizzazione che la precede (lease, orario dell'ultima lettura) dalle scritture della decisione (stato, motivo di revisione, risoluzione, cancellazione, tentativi `admin_released`, pagine chiuse, audit).

#### Prove differenziali

- **L10 (puro, monotonia contro la regola di HEAD):** mondi casuali con semi fissi `1..N` (`mulberry32`, nessun `Math.random`), tentativi con identificativi buoni, assenti e immondizia, esiti di lettura (denaro, nessun denaro, fallita, mancante) dati **solo** ai canali leggibili (come fa il cancello). Il nuovo non concede mai ciò che il vecchio rifiutava; il denaro che il vecchio vedeva è denaro; su dati ben formati la differenza è esattamente `none → unknown` quando c'è un tentativo senza identificativi. Esiti: **4.000** mondi (predefinito, in `npm test`) 18/18; **20.000** 18/18 (0,5 s); **100.000** 18/18 (1,1 s).
- **Cancello contro cancello (fuori dal repository, non è un test committato):** la `readChargeEvidence` di HEAD **verbatim** e quella nuova (copia di sandbox con la sola parola `export` in più) sugli stessi mondi, con lo stesso Stripe finto e la rete rifiutata dall'esterno. Proprietà: G1 il nuovo concede (`none`) solo ciò che il vecchio concedeva; G2 il nuovo vede denaro solo dove lo vedrebbe il vecchio; G3 ogni chiamata del nuovo è una chiamata che il vecchio avrebbe fatto leggendo **ogni** tentativo; G4–G5 su dati ben formati il verdetto è **uguale** (salvo `none → unknown` con un tentativo senza identificativi) e le **sequenze di chiamate sono identiche**; G7 il conteggio dei tentativi senza identificativi è esatto; G8 il nuovo non chiede mai un id che non sia nella forma Stripe. **100.000 mondi (semi `1..100.000`): 0 divergenze** (anche il sotto-insieme `1..20.000`: 0). Numeri: 89.544 mondi ben formati e 10.456 fuori contratto; 48.669 mondi con almeno un tentativo senza identificativi; il vecchio diceva `none` in 33.863 mondi e il nuovo in 21.426 (**12.437** `none → unknown`, tutti con almeno un tentativo non verificabile: senza identificativi, con identificativi malformati o contraddetto); il vecchio vedeva denaro in 44.329 mondi, il nuovo in 42.952: i **1.377** mondi di differenza sono tutti **fuori contratto** (denaro su un tentativo con un id buono accanto a un id malformato, che il nuovo non legge: risposta `unknown`, rifiutata comunque) — **a dati ben formati il denaro non si perde mai**. Sensibilità: delle 34 mutazioni del cancello e del modulo provate sul differenziale, **33 lo fanno fallire** (l'unica che no, SN07 — la copia che non copia —, è equivalente a runtime ed è fissata da L16).

#### Mutazioni (su copie fuori dal repository, una per volta, ripristino verificato)

Il banco ha ora **180 mutazioni** — classificatore 48, combinazione 37, copia 8, confronto dell'insieme 16 (modulo puro: 109); ramo `no_charge` 21, ciclo di lettura 11, copia e controllo sotto lock 22, letture spostate 14, `accepted` 3 (cancello: 71) — provate con il file puro e, per quelle che sopravvivono, con `payment-hold.sec.ts` su un database clonato per ciascuno dei quattro lavoratori e, per le ultime sopravvissute, con gli altri quattro file di sicurezza che passano da `payment-hold` (`cart-after-payment`, `s6-refund-block`, `s6-revision-events`, `production-release-routes`); la linea di base è verde in tutte le copie, tutte insieme, prima di cominciare.

| Passata | Mutazioni | Rilevate | Sopravvissute |
|---|---:|---:|---:|
| Prima (173 mutazioni, test al momento del verde) | 173 | 131 | **42** |
| **Finale (180 mutazioni, sui file definitivi)** | **180** | **168** (105 dal file puro, 63 dalla sicurezza) | **12** |

Per famiglia (finale): classificatore 43/48, combinazione 34/37, copia 8/8, confronto 16/16, ramo `no_charge` 21/21, ciclo di lettura 10/11, copia e lock 20/22, letture spostate 14/14, `accepted` 2/3.

**Le 42 della prima passata** sono state analizzate **una per una**: **30** hanno richiesto un test (o, per una, un affinamento del codice) e ora sono rilevate, **12** sono equivalenti. Test aggiunti per le 30: nel file puro — l'altro id assente come proprietà mancante o `undefined` (CL18), prefissi **prima** dell'id di pagamento (CL08), un array con i campi di un tentativo (CL20), una lista di canali illeggibile e i conteggi dei gemelli e del getter che lancia (CB02, CB07, CB16, CB17), due non-liste a confronto (SM09), la guardia statica che il cancello usa ogni parte del modulo (LK20); nella sicurezza — la tabella R1–R19 (MV01–MV10, RD07, RD09), i messaggi di «Stripe non ha risposto» (GT06, GT08), H13: Stripe non è interrogato per un id malformato (GT16), C7b (LK11), C8 (LK13), C9/C10 (LK16, LK17, LK18). **GT04** ha dato un affinamento del codice: il cancello proseguiva con `verdict === 'unknown'` (equivalente, dopo il controllo del denaro); ora prosegue **solo** se `verdict` è esattamente `'none'` (qualunque altro valore rifiuta, anche uno futuro), fissato dalla guardia statica L21. Il catalogo della seconda passata aggiunge LK21 e LK22 («blocca solo il tentativo più recente / solo il più vecchio»: le rileva C7 eseguito su **entrambi** i tentativi), MV12–MV14 (timeout ed espansione delle letture: le rileva la tabella R1–R19) e GT20–GT21 (un cancello che salta la lettura o elude il rifiuto), tutte rilevate.

**Le 12 sopravvissute finali sono equivalenti** (nessun test le uccide perché il comportamento osservabile non cambia):
- **AC02** — tolto il primo controllo `NOT_PAID` di `accepted`: è ridondante con quello sotto lock (stesso `409 NOT_PAID`; cambia solo il testo del messaggio); il ramo è invariato e la mutazione sopravvivrebbe anche su HEAD.
- **CB11, CB12** — `outcomeOf` accetta qualunque stringa / non riconosce `unreadable`: la combinazione confronta un esito soltanto con `money` e `no_money`, e ogni altro valore, riconosciuto o no, vale «non letto»: nessuna differenza osservabile.
- **CB18** — i canali senza `id` partecipano al controllo dei gemelli: `legOf` fa già di ogni canale senza `id` un canale non leggibile, quindi non esistono gemelli con due basi sull'`id` vuoto.
- **CL21** — un elemento `null` non è intercettato prima: la lettura di una proprietà di `null` lancia, il `catch` produce la stessa riga.
- **CL22** — un elemento primitivo letto come riga: la riga che ne esce non ha `id` proprio, quindi non è né leggibile né confrontabile comunque; cambiano solo i campi del segnaposto (`null` al posto del marcatore), che nessuno legge.
- **CL25** — uno stato non stringa tenuto com'è: lo stato è una colonna `String` non nulla dello schema; la variante sarebbe solo più severa su un valore che non può esistere.
- **CL47** — **mutazione malformata** (il `else if (false)` inserito non interrompe la catena): nessun effetto per costruzione. Errore mio nel catalogo, dichiarato.
- **CL48** — il controllo delle contraddizioni include le righe con `id` vuoto: quelle righe non sono mai leggibili comunque.
- **LK03** — tolto il controllo `examined === null`: è codice difensivo **irraggiungibile** (`examined` è assegnato prima della transazione nel solo ramo `no_charge`, l'unico in cui il controllo si valuta); serve al compilatore e a far fallire chiuso una modifica futura.
- **LK15** — `FOR SHARE` al posto di `FOR UPDATE` sui tentativi: entrambi escludono `UPDATE` e `DELETE` concorrenti delle righe, che è tutto ciò che serve (nessuna tabella referenzia `PaymentAttempt`; le inserzioni sono fermate dal lock dell'ordine, non da quello delle righe).
- **RD02** — un errore di lettura non registrato affatto: la combinazione tratta un tentativo leggibile senza esito come «non letto», lo stesso risultato della registrazione esplicita.

Contabilità onesta: i test della seconda passata sono stati aggiunti **dopo** aver visto le sopravvissute della prima (non prima, non «contro HEAD»); il banco finale è stato rieseguito per intero sui file definitivi, che non sono più cambiati (impronte uguali a quelle della catena di verifica); nessuna passata è stata scartata. Errori **miei** emersi lungo la strada: in fase rossa un controllo troppo stretto in H6 (`assertUntouched` non teneva conto che la sincronizzazione che precede la decisione registra di nuovo un pagamento reale), corretto nel test; in fase verde il test L9 ha rivelato un **difetto del modulo** (un esito `money` contava anche come lettura fallita nel conteggio `unreadable`), corretto nel modulo, e L10 un difetto del generatore del test (esiti assegnati anche a canali non leggibili), corretto nel test.

#### Altri risultati (catena finale sul codice definitivo)

- `npx tsc --noEmit`: **0 errori** (include i test). `npm run lint` (`--max-warnings=0`): **0 avvisi**. `git diff --check`: pulito.
- `npm test`: **1716 test, 1716 verdi, 0 falliti** (1698 della baseline di HEAD + 18 del file nuovo).
- `npm run test:security` su database isolato `mkw_sectest` (`127.0.0.1`, nome che finisce con `_sectest`, dati finti): **1365 test, 1365 verdi, 0 falliti** (baseline di HEAD: 1314; i 51 in più sono i nuovi di `payment-hold.sec.ts`). `payment-hold.sec.ts` da solo: 67/67 in 9,4 s.
- P1 `tests/payment-hold-evidence.test.ts`: **587/587, invariato**. Lettore `tests/stripe-funds-reader.test.ts`: **161/161, invariato**.
- **Rete rifiutata, da fuori e due volte.** (1) Il file puro eseguito con un preload che sostituisce `net.Socket.connect`, `net.connect`, `tls.connect`, `dns.*`, `http(s).request/get` e `fetch` con un rifiuto che registra ogni tentativo: **18/18**; il registro contiene soltanto **2 `net.connect` verso la pipe locale del caricatore `tsx`** (un socket di file) e nessun tentativo verso un host; il controllo negativo (stesso preload, sette tentativi) li rifiuta e registra **7/7**. (2) `payment-hold.sec.ts` eseguito con un preload che ammette **solo** il database locale e i socket di file locali: **67/67**; il registro contiene **142 tentativi di `fetch` verso `http://127.0.0.1:9/api/stockworks/filament-colors`** (la porta morta che l'harness imposta apposta come `BASE_URL` perché ogni chiamata HTTP all'applicazione stessa fallisca subito: il codice del checkout prova, la chiamata fallisce e il checkout prosegue, comportamento preesistente e identico a un'esecuzione senza preload) e 4 connessioni alla pipe di `tsx`, **nessun tentativo verso Stripe o altri host, nessuna ricerca DNS**; controllo negativo del preload: **9/9** rifiutati e registrati (compreso un `https.request` verso `api.stripe.com`). Le connessioni al database passano dal motore nativo di Prisma, che i ganci di Node non vedono: il database è quello isolato.
- **Nessuna chiave Stripe nell'ambiente**: nessuna variabile `STRIPE_*` era impostata; l'unica chiave che compare è quella fittizia `sk_test_FAKE_not_a_real_key_…` dell'harness dei test, che non apre alcuna connessione (i metodi del client sono sostituiti dal finto).
- **Isolamento e perimetro:** nessun file di `app/`, `lib/`, `components/`, `scripts/`, `prisma/` o della radice nomina `payment-hold-evidence` o `stripe-funds-reader` (guardie A4 di P1 e del lettore, verdi); solo `lib/payment-hold.ts` nomina il modulo nuovo (L21); `git status --porcelain` prima del commit mostra i soli sette percorsi del pacchetto.

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **F02 non è formalmente chiusa.** Il comportamento pericoloso — «nessun tentativo con identificativi, quindi nessun denaro» — non c'è più; restano da decidere, dal titolare (DP-3 del piano P3b.0), le eventuali **eccezioni** (un'attestazione dell'applicazione per i rifiuti definitivi del fornitore; la scadenza «per costruzione» con un margine; un'enumerazione lato Stripe, mai come prova di assenza) e manca l'accettazione scritta. **Nessuna eccezione è implementata.**
- **Il lock è nostro, non di Stripe.** Fra l'ultima lettura di ogni tentativo e il commit passano da pochi millisecondi a qualche secondo (le letture sono sequenziali, con un timeout di 8 s per chiamata): in quella finestra un cliente può completare una pagina aperta. Il controllo sotto lock garantisce che **l'insieme dei tentativi** sia quello letto; non garantisce nulla su Stripe. Rimborsi e contestazioni non sono letti da questo controllo (lo stato di sessione/pagamento soltanto): la posizione dei fondi di P1/P3a.1 **non** è collegata (P3b-6, da autorizzare).
- **Rifiuti prudenti anche per cambiamenti innocui.** Qualunque cambiamento di `id`, identificativi o stato di un qualunque tentativo fra la copia e la rilettura rifiuta, anche se innocuo (una sincronizzazione tecnica che sposta un tentativo da `open` a `processing`): si chiede di nuovo. Le colonne fuori dall'esame (scadenza, nota, motivo, importi) non contano (C4). Le letture normali non ne risentono.
- **Attesa sotto lock.** La decisione attende, nella sua transazione (`timeout` di 20 s, invariato), uno scrittore che tiene una riga di tentativo (i due `updateMany` senza transazione sono brevissimi); se l'attesa superasse il timeout, la transazione è annullata e la rotta risponde con un errore, **senza scrivere nulla**. Nessuna transazione nuova, nessun lock lungo, nessuna chiamata esterna sotto lock.
- **Dati fuori contratto.** Un tentativo con un id buono accanto a uno malformato **non è letto** (non si «ripara»): se quell'id buono mostrasse denaro la risposta è `unknown` (rifiutata comunque) e non `CHARGE_EXISTS`. Le righe vere non possono avere questa forma (gli id vengono dalle risposte di Stripe; le colonne sono `@unique`): è una scelta di prudenza fissata da L7, L10 e dal differenziale (1.377 mondi su 100.000, tutti fuori contratto).
- **`accepted` invariato (F03 aperta).** Verifica ancora solo il database, azzera il motivo di revisione qualunque sia e registra `payment_collected` senza una lettura al momento della decisione: C6b lo fissa. Una contestazione in sospeso non ha ancora una via d'uscita sicura.
- **F12 aperta** (il vicolo cieco di un pagamento rimborsato) e **R1** (il doppio primo acquisto degli ospiti, 1.38): non toccati. Il rimborso governato (P5), le sette ipotesi di P1, il caso `latest_charge: null` (P1-ter, da decidere dopo un'osservazione autorizzata), la riconciliazione, l'audit del rifiuto (§15.10 punto 6) e l'interfaccia per il nuovo `409` (1.37) restano **da fare**.
- **I test con database non sono in `npm test`.** Una regressione del cancello può sfuggire a `npm test`; serve eseguire `npm run test:security` con un database `_sectest` (come per ogni pacchetto che tocca `payment-hold`). La proposta di un job dedicato è nel registro del piano P3b.0.
- **Fixture simulate ≠ Stripe reale.** Ogni risposta dei test è costruita sul modello di ciò che l'SDK dichiara e che i collaudi in Test Mode hanno osservato (S6a.17–S6a.19); nessuna chiamata a Stripe è stata fatta, nemmeno in Test Mode. Test Mode non è Live.

### Casi eccezionali che restano bloccati e richiedono assistenza

Un ordine con anche **un solo** tentativo senza identificativi Stripe (le cinque origini sopra, a qualunque età e per qualunque motivo) **non può più essere rilasciato come «nessun addebito» da `payment-hold`**: la risposta è `409 STRIPE_UNVERIFIABLE`, «A payment attempt of this order has no Stripe identifier… This order needs assistance». Non c'è un modo di decidere comunque (F01 resta chiusa) e ripetere la richiesta non aiuta, a meno che l'identificativo non compaia. L'uscita è una **verifica umana fuori dall'applicazione** (procedura di assistenza, 1.36: controllare nel Dashboard di Stripe se esistono sessioni o pagamenti dell'ordine; ricordare che la ricerca per metadato **scopre ma non esclude**, T12 di S6a.17), e qualunque eccezione automatica è una decisione del titolare (DP-3), non un comportamento di questo pacchetto. Fuori da `payment-hold` esistono altre rotte che cambiano lo stato di un ordine (la rotta di stato dell'amministrazione non controlla il denaro: area di F12, elencata fra i punti da verificare nel piano P3b.0, **non toccata**); questo pacchetto non le modifica e non le raccomanda come scorciatoia.

### Come riprodurre

`node --test --import tsx tests/payment-attempt-legs.test.ts` (offline, nessuna chiave, 4.000 mondi); `ATTEMPT_LEGS_WORLDS=20000 …` e `ATTEMPT_LEGS_WORLDS=100000 …` per le prove grandi (semi `1..N` fissi); `SEC_TEST_DATABASE_URL=postgresql://…@127.0.0.1:<porta>/<nome>_sectest node --test --test-concurrency=1 --import tsx tests/security/payment-hold.sec.ts` (database locale **isolato**, dati finti, Stripe finto), `npm run test:security` per l'intera suite; `node --test --import tsx tests/payment-hold-evidence.test.ts` (587); `node --test --import tsx tests/stripe-funds-reader.test.ts` (161); `npx tsc --noEmit`; `npm run lint`; `npm test`. Il rosso informativo si riproduce eseguendo i file definitivi contro `lib/payment-hold.ts` di HEAD (`git show 5d1e866:lib/payment-hold.ts`) in una copia fuori dal repository con un database clonato (`createdb -T <nome>_sectest <altro>_sectest`); le mutazioni, il differenziale cancello-contro-cancello e i preload di rete sono rimasti nella cartella di lavoro della sessione, non nel repository (non c'è un comando nel progetto). Nessun passo richiede Stripe o una chiave.

## R1-1a Contratto sicuro della chiave di checkout nel browser (`lib/checkout-key-format.ts`, `lib/checkout-client.ts`, `lib/checkout-copy.ts`)

Questo pacchetto rende **sicura, deterministica e verificabile la generazione e la gestione, nel browser, della chiave di ripetizione del pagamento** (`checkoutKey`): da dove nasce, quando viene tenuta, riutilizzata e inviata, e che cosa succede quando non si può produrre. **Non chiude e non risolve R1**: il server **non ha ancora alcuna guardia per acquisto** (la tabella `GuestPurchaseKey` e il legame K → ordine sono R1-1b, che richiede una migrazione additiva separata); due prime richieste con sessioni diverse possono ancora creare due ordini. Punto di partenza: HEAD `3cca0272584ec514fc59f0726e9de471984a6428` (P3b-1), ramo `claude/stampa3d-fase1`, albero pulito. L'architettura del piano R1-0 R3 è approvata; di esso è autorizzato **solo** R1-1a. Le parti di R0 e R2 superate da R3 non sono usate come specifica.

### Ambito e confine

- **File del pacchetto (solo questi dieci):** `lib/checkout-key-format.ts` (nuovo, **puro, zero import**), `lib/checkout-client.ts`, `lib/checkout-copy.ts`, `tests/checkout-key-format.test.ts` (nuovo), `tests/checkout-client.test.ts`, `tests/e2e/checkout-crypto-guard.responsive.spec.ts` (nuovo), `tests/real-run/guest-session.ts` (solo la fixture della «stessa chiave»), questa sezione, `docs/SESSIONE-OSPITE.md` (§7, un punto) e `docs/CHECKLIST-PRELANCIO.md` (righe 1.38 e 1.52, più una riga delle verifiche automatiche già eseguite).
- **Non toccati:** le rotte (`app/api/checkout/*`), `lib/checkout-orders.ts`, `lib/checkout-sessions.ts`, `lib/payment-hold.ts`, `lib/payment-sync.ts`, P1 (587 test), il lettore (161), `prisma/` (nessuna migrazione, nessuna `GuestPurchaseKey`), i componenti React (`HostedCheckout.tsx` e gli altri), configurazioni, dipendenze. Nessuna chiamata a Stripe, nemmeno in Test Mode; nessun database di produzione; nessun deploy.

### Che cosa è cambiato

| Regola | Prima (HEAD `3cca027`) | Ora |
|---|---|---|
| **Fonte** | `crypto.getRandomValues` se c'è, **altrimenti `Math.random()`** (`lib/checkout-client.ts:104`): una chiave prevedibile con la stessa forma di una buona | **solo** `crypto.getRandomValues`, 24 byte (192 bit), nessun ripiego di alcun tipo: il codice non contiene più `Math.random` (lo prova un test sul codice senza i commenti e uno a runtime) |
| **Forma forte** | qualunque stringa `[A-Za-z0-9_-]{16,64}` (il modello del server) | `k` + **esattamente** 32 caratteri base64url, **almeno 16 diversi** (`lib/checkout-key-format.ts`): un **filtro** contro le chiavi degeneri (costante, ciclo breve, `fill(7)`), **non** una prova di casualità |
| **Nessuna chiave** | senza Web Crypto una chiave comunque; con un Web Crypto che lancia, **un'eccezione dentro «Paga»** (il pulsante resta bloccato) | **`""`**: nessuna chiave, mai una chiave che «sembra» valida; **nessuna eccezione** |
| **Estrazioni** | una | fino a **4**: se la prima non supera il filtro si estrae di nuovo (con byte casuali veri il filtro fallisce circa 1,5 volte su 10 milioni); un generatore che non passa mai si ferma e dà «nessuna chiave» |
| **`resolveCheckoutKey`** | riutilizzava ogni valore salvato che avesse la forma larga del server; salvava ciò che il generatore dava | riutilizza **solo** una chiave forte per lo stesso carrello e totale; **non salva** (né in memoria né nello storage) una chiave vuota, debole o malformata; un generatore che lancia vale «nessuna chiave»; non tocca altro che la propria voce |
| **`requestSession`** | inviava qualunque chiave | **prima di qualunque `fetch`** controlla che la chiave sia forte: se no, **nessuna richiesta e nessun giro di 428**, ritorna un errore tipizzato (`crypto_unavailable`, `retry: false`, un oggetto nuovo a ogni volta) e **non lancia**: «Paga» si sblocca da sé |
| **Errore** | — | nuovo `FailureKind` `crypto_unavailable` (codice interno `CHECKOUT_KEY_UNAVAILABLE`): lo produce **solo** la pagina; nessuna risposta del server è mai classificata così |
| **Chi ne è toccato** | — | il **client** di ospiti e account (la funzione è una sola); le regole del server per gli account **non** cambiano |

### La frase mostrata

> Il tuo browser non riesce a usare la funzione di sicurezza che serve per avviare il pagamento senza rischio di doppio ordine, quindi da questa pagina non è partita nessuna richiesta di pagamento. Il carrello è rimasto com'è. Aggiorna il browser o provane un altro, poi ricarica la pagina. Questo avviso non riguarda eventuali pagamenti avviati in precedenza.

È in italiano, dice che **da questa pagina** non è partito nulla (vero: il rifiuto precede qualunque richiesta), che il carrello è intatto e che cosa fare; **non dice nulla sugli addebiti** (né «nessun addebito» né altro: per i tentativi precedenti non può saperlo), **non invita a ripetere un pagamento** e dichiara espressamente che non riguarda i pagamenti già avviati. Nessuna modifica React: la frase passa dal punto in cui la pagina già mostra gli errori di pagamento (`failureMessage`, area `checkout-error`).

### Risultati

Tutto ciò che segue è stato ottenuto sul **codice definitivo**; HEAD invariato fino al commit; nessuna chiamata a Stripe.

#### Prove rosso → verde

- **Rosso** (test scritti per primi, contro il codice di HEAD). `tests/checkout-key-format.test.ts` (15 test): **il file non si carica** (il modulo non esiste). `tests/checkout-client.test.ts`: dei **13 nuovi test «R1-1a»** (A–L, N) i **9 che esigono il comportamento nuovo erano rossi** — B (`Math.random` nel codice e a runtime), C (senza Web Crypto esisteva una chiave), D (un Web Crypto che lancia faceva lanciare), E (un generatore degenere dava una chiave), F (una chiave debole salvata veniva riutilizzata), H, J, L (la richiesta partiva senza chiave forte), N (nessuna frase dedicata) — e **4 fissano ciò che deve restare** (A: 24 byte da `getRandomValues`; G: una chiave forte salvata è riutilizzata identica; I: la chiave non cambia dopo errori e pagamenti in dubbio; K: una chiave forte passa come prima). G era comparso rosso per un difetto **mio** del test (usava la stessa chiave come «salvata» e come «nuova»), corretto prima del verde. e2e `checkout-crypto-guard.responsive.spec.ts` su `chromium`, `mobile`, `mobile-small`: **12 rossi su 15** (la pagina inviava la richiesta o restava bloccata); i 3 test di controllo erano verdi.
- **Verde.** 56/56 (15 + 41) nei due file; e2e 15/15; `tsc` a 0 errori.

#### Test eseguiti (sul codice definitivo)

`tests/checkout-key-format.test.ts` — **15 test**, offline: costanti · forma accettata · forme rifiutate (prefisso, lunghezza, alfabeto, padding, spazi, a capo, non-stringhe) · soglia di diversità a 15/16 · chiavi dei vecchi test e della vecchia fixture rifiutate · **limite scritto apposta** (un contatore passa: la forma non è una prova) · differenziale con un giudice indipendente su 40.000 stringhe · probabilità esatta di falso rifiuto (**1,48×10⁻⁷** per estrazione; quattro di seguito 4,8×10⁻²⁸; media 25,3 caratteri diversi: calcolo esatto, nessun campionamento, nessun test instabile) · encoder uguale al `base64url` di Node su 2.000 estrazioni, `""` per tutto ciò che non sono 24 byte, mai un'eccezione · `distinctBodyChars` · **modulo puro e portabile** (nessun `import`, API di Node, orologio, fonte casuale o stato, controllato sul codice senza commenti e con `verbatimModuleSyntax`, così anche un `import` inutilizzato si vede) · **eseguito in un contesto senza alcun globale di Node** (né `Buffer`, né `process`, né `require`) con lo stesso risultato che dà in Node e nessuna fuga nello scope globale · immutabilità degli ingressi e ogni chiave forte già accettata dalla forma larga del server (`CHECKOUT_KEY_PATTERN`: la futura importazione lato server non richiede di allargare la rotta) · il client usa il modulo condiviso.

`tests/checkout-client.test.ts` — **41 test** (28 esistenti, adattati dove usavano chiavi deboli come `kKEYKEYKEYKEYKEYKEY` o `key-0000…`, più i **13 nuovi «R1-1a A–L, N»**): **A** 24 byte da `getRandomValues`, una sola richiesta · **B** nessun ripiego: né nel codice (`Math.random` assente da entrambi i file, commenti esclusi) né a runtime (`Math.random` sostituito da una trappola: zero chiamate con Web Crypto assente, nullo, vuoto, con `getRandomValues` non funzione, che lancia, degenere) · **C** senza Web Crypto: `""`, nulla salvato, **zero richieste e nessun giro di 428** · **D** un Web Crypto che lancia (`DOMException`) e un generatore che lancia: nessuna eccezione, nulla salvato, errore tipizzato, **nulla avvelenato** (con Web Crypto di nuovo disponibile la stessa chiamata dà una chiave forte e la tiene) · **E** cinque generatori degeneri (zero, `fill(7)`, `0xFF`, due byte alternati, tre byte alternati): «nessuna chiave» dopo un numero **limitato** di richieste (da 2 a 8); degenere una volta e poi buono → chiave forte alla seconda; chiavi deboli iniettate in `resolveCheckoutKey`: né salvate né inviate · **F** diciassette forme di valore salvato debole o vecchio (la forma larga del server, corte, ripetitive, prefisso sbagliato, non stringhe…): mai riutilizzate, sostituite da una forte; senza Web Crypto non si scrive nulla · **G** una chiave forte salvata è riutilizzata **identica**, senza chiedere byte e senza scrivere · **H** storage bloccato o assente: stessa chiave in memoria per lo stesso acquisto; senza Web Crypto ancora nessuna chiave, e la risposta vuota non viene ricordata · **I** la chiave **non cambia** dopo errore di rete, 503, 502, 429, prezzo cambiato, **pagamento in conferma** e **ordine non pagabile (forse già pagato)**: una richiesta, nessuna ripetizione, stessa chiave alla pressione successiva, nulla riscritto; e i **soli tre file** del codice che dimenticano una chiave sono quelli di prima (la pagina di pagamento solo per `conflict`; gli altri due a pagamento **verificato**) · **J** il carrello non si tocca: la voce della chiave è l'unica scritta e letta, con uno storage «severo» che lancia per qualunque altro uso · **K** una funzione sola per ospite e account: una richiesta; dopo un 428 una ripetizione con lo stesso corpo; **e la rotta del server non è stata toccata** (accetta ancora la forma larga e non nomina il modulo: nessuna protezione lato server è dichiarata né presente) · **L** **nessuna richiesta di alcun tipo, quindi nulla verso Stripe**, nemmeno attraverso il `fetch` globale e nemmeno per una richiesta annullata, per chiavi vuote, corte, ripetitive, non stringhe · **N** la frase (italiana, nessuna parola inglese, nessun «addebit», nessun «riprova», con carrello e avvertenza sui pagamenti precedenti) e il fatto che nessuna risposta del server sia classificata `crypto_unavailable`.

`tests/e2e/checkout-crypto-guard.responsive.spec.ts` — **5 test × 3 progetti = 15** (`chromium`; `mobile`, Pixel 5; `mobile-small`, 360×640), con le risposte del server sostituite (`page.route`) e Web Crypto guastato **dopo** il caricamento (così non si prova l'avvio dell'applicazione): senza Web Crypto · Web Crypto che lancia (nessun errore non gestito nella pagina) · generatore degenere (`fill(7)`) · **dopo il rifiuto nulla resta bloccato**: con Web Crypto di nuovo disponibile lo stesso pulsante paga, con una chiave forte · controllo con Web Crypto funzionante. Per ogni rifiuto: la frase è visibile; **la pagina non ha inviato nulla** (letto **dentro la pagina**, con un `fetch` avvolto prima di ogni script, non dal livello di rete: nessuna dipendenza dai tempi e nessuna pausa fissa) e il livello di rete nemmeno; il carrello è identico byte per byte; nessuna chiave è stata salvata; «Paga» è di nuovo attivo (`aria-busy="false"`), alto almeno 44 px; nessuno scorrimento orizzontale; il link «Torna al carrello» è ≥ 44 px. **Chromium emulato non è Safari né un telefono vero.**

#### Mutazioni (su una copia fuori dal repository, una per volta, ripristino verificato)

Il banco ha **61 mutazioni** — forma e codifica 26 (`lib/checkout-key-format.ts`), generazione e riuso della chiave 15, `requestSession` e l'errore tipizzato 12, la frase 6, i due punti che non devono cambiare 2 (la pagina di pagamento che dimenticherebbe la chiave dopo un pagamento in dubbio; la rotta del server che comincerebbe a nominare il modulo) — provate con i due file di test su una **copia** del repository fuori dalla cartella di lavoro (con `node_modules` collegato), una per volta, con la linea di base verde prima di cominciare e il ripristino della copia dopo ciascuna.

| Passata | Mutazioni | Rilevate | Sopravvissute |
|---|---:|---:|---:|
| Prima (test al momento del verde) | 61 | 59 | 2 |
| **Finale (test definitivi)** | **61** | **60** | **1** |

Per famiglia (finale): forma e codifica 26/26, generazione e riuso 14/15, `requestSession` e errore 12/12, frase 6/6, punti che non devono cambiare 2/2.

**Una sopravvissuta della prima passata è stata uccisa dopo un affinamento del test:** F24 (un `import` di Node inutilizzato nel modulo condiviso) era invisibile alla scansione statica, perché il compilatore elimina un `import` che nessuno usa; ora la scansione compila con `verbatimModuleSyntax`, l'`import` resta nel codice emesso e viene visto.

**La sopravvissuta finale è equivalente.** C09 — «dopo `getRandomValues`, se tutti i byte sono uguali se ne ritocca uno» — non cambia nulla di osservabile: un array costante con un byte ritoccato produce al massimo 8 caratteri diversi e il filtro lo rifiuta esattamente come prima.

Contabilità onesta: i test sono stati scritti **prima** del codice (fase rossa) e rafforzati **dopo** aver visto la sopravvissuta della prima passata (non «contro HEAD»); il banco finale è stato rieseguito per intero sui file definitivi; nessuna passata è stata scartata. Errori **miei** emersi lungo la strada, corretti nei test e non nel codice: in fase rossa il test G usava la stessa chiave come «salvata» e come «nuova»; in fase verde un caso del test sulle forme rifiutate (`kk` + 31 caratteri) era in realtà una chiave ben formata.

#### Altri risultati

- `npm test`: **1744 test, 1744 verdi, 0 falliti** (1716 della baseline + 15 del file nuovo + 13 nuovi di `checkout-client.test.ts`).
- `npm run test:security` su database isolato `mkw_sectest` (`127.0.0.1`, nome che finisce con `_sectest`, dati finti): **1365 test, 1365 verdi, 0 falliti** (221 s): come la baseline, perché il server non è toccato.
- P1 `tests/payment-hold-evidence.test.ts`: **587/587, invariato**. Lettore `tests/stripe-funds-reader.test.ts`: **161/161, invariato**.
- `npx tsc --noEmit`: **0 errori** (include i test). `npm run lint` (`--max-warnings=0`): **0 avvisi**. `git diff --check`: pulito.
- **End-to-end** (server di sviluppo di prova su `127.0.0.1`, risposte del server sostituite, Chromium con emulazione): il file nuovo **15/15**; i file esistenti che attraversano il pagamento (`guest-session`, `checkout`, `payment-return`, tre progetti): **97 verdi, 2 saltati dai test stessi, 0 falliti**.
- **Real-run `tests/real-run/guest-session.ts`** (browser vero contro `next start` in produzione, proxy TLS di prova, SDK Stripe vero davanti a un Stripe simulato senza rete, database isolato; desktop, telefono 393×851 e telefono piccolo 360×640, **Chromium emulato**), eseguito su una **nuova build** con il codice del pacchetto: **114 controlli, 114 verdi, 0 falliti** (lo stesso totale di S5). La fixture dello scenario [5] «due browser, stessa chiave» non poteva più usare `fill(7)`: la chiave che ne esce è degenere e il client ora la rifiuta (non partirebbe alcuna richiesta). È sostituita da una sequenza fissa, `byte[i] = (i·37 + 11) & 255`, che dà la chiave `kCzBVep_E6Q4zWH2ix-wRNluApcrvFDle` (28 caratteri diversi). **L'esito atteso dello scenario non è cambiato:** due browser con la stessa chiave fanno **due ordini e due pagine di pagamento** (è il comportamento che R1-1b dovrà cambiare). Una prova a parte, fuori dal repository, ha confermato che i due browser con la nuova fixture inviano **la stessa chiave forte**.
- **Perimetro:** `git status --porcelain` prima del commit mostra i soli dieci percorsi del pacchetto; `next-env.d.ts`, che il server di sviluppo di Next riscrive, è stato riportato al contenuto di HEAD (la build di produzione lo ripristina da sé).

### Limiti e cose NON chiuse (nessuna presentata come risolta)

- **R1 resta aperto e bloccante** (checklist 1.38, 1.52, 1.56; decisione del titolare del 2026-10-17). Questo pacchetto non cambia che cosa fa il server con due richieste che non condividono alcun dato verificabile.
- **Il server NON ha ancora la guardia `GuestPurchaseKey`.** La rotta `POST /api/checkout/session` accetta ancora qualunque chiave di forma `[A-Za-z0-9_-]{16,64}`: un client vecchio, una pagina in cache o una richiesta fatta a mano può ancora inviare una chiave debole, e nessuna garanzia fra sessioni diverse esiste. La validazione obbligatoria lato server per gli ospiti, il legame atomico K → ordine e la **migrazione additiva** che li serve sono **R1-1b**, con mandato e prove proprie. Il test K tiene fermo che la rotta non è stata toccata; R1-1b dovrà cambiarlo di proposito.
- **La forma non è una prova di casualità.** Una sequenza prevedibile ma varia (un contatore) supera il filtro: lo dice un test. La sicurezza della chiave sta nella **fonte** (`crypto.getRandomValues`), non nel formato; nessun codice deve leggere «forte» come «imprevedibile».
- **Chiavi già salvate con la vecchia forma.** Una chiave generata in passato con il ripiego `Math.random` (possibile solo in un browser senza Web Crypto, praticamente inesistente [I]) ha la stessa forma di una buona e supera il filtro: non è distinguibile e, se è ancora nello storage, viene riutilizzata. Le chiavi che soddisfano **solo** la forma larga del server (corte, ripetitive, di un altro formato) **non** sono più riutilizzate.
- **Coordinamento fra schede (R1-2).** Lettura, generazione, rotazione e dimenticanza della chiave non sono atomiche fra schede: due schede con lo storage vuoto possono ancora generare due chiavi diverse. Il lucchetto (Web Locks) che le racchiude insieme alla richiesta è R1-2; non è stato toccato.
- **Pagamento incerto.** Nessun caso di pagamento incerto riceve un'autorizzazione al ritentativo finanziario: la chiave non ruota dopo errori di rete, temporanei o pagamenti in dubbio (test I); l'unico punto della pagina che dimentica una chiave durante il pagamento è il «conflitto» (`CHECKOUT_KEY_CONFLICT`), invariato; la frase del nuovo errore non invita a ripetere un pagamento.
- **Conseguenza di conversione, dichiarata.** Un browser **senza** Web Crypto (o con uno guasto) non può più pagare, da ospite **né da account**: è il comportamento voluto (R3, «fail-closed»), perché una chiave debole non protegge e non va inviata; non esiste un percorso alternativo nel client. `crypto.getRandomValues` è presente in tutti i browser moderni [D, non verificato qui su dispositivi veri]: **il supporto reale (iPhone Safari, Android Chrome, browser integrati delle app) resta da validare** (checklist 1.38 e 1.52); Chromium emulato non lo dimostra.
- **Una stima di R2 va corretta.** Il piano R2 diceva che la probabilità che byte casuali veri non superino il filtro era «dell'ordine di 10⁻⁹ o meno [da verificare]»; il calcolo esatto dà **1,48×10⁻⁷** per estrazione (nulla cambia per questo: quattro fallimenti di fila sono 4,8×10⁻²⁸).

### Come riprodurre

`node --test --import tsx tests/checkout-key-format.test.ts tests/checkout-client.test.ts` (offline, nessuna chiave: 15 + 41); `npm test`; `SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<porta>/<nome>_sectest npm run test:security` (database locale **isolato**, dati finti, Stripe finto); `node --test --import tsx tests/payment-hold-evidence.test.ts` (587) e `tests/stripe-funds-reader.test.ts` (161); `npx tsc --noEmit`; `npm run lint`. E2E: un server di sviluppo con una configurazione di prova (nessuna chiave Stripe vera) e `E2E_BASE_URL=http://127.0.0.1:<porta> E2E_CHROMIUM_PATH=<percorso di Chromium> npx playwright test tests/e2e/checkout-crypto-guard.responsive.spec.ts` (i tre progetti); lo stesso per `guest-session`, `checkout` e `payment-return`. Il rosso si riproduce eseguendo i test nuovi contro `lib/checkout-client.ts` e `lib/checkout-copy.ts` di HEAD (`git show 3cca027:lib/checkout-client.ts`). Le mutazioni sono rimaste nella cartella di lavoro della sessione, non nel repository (non c'è un comando nel progetto). Nessun passo richiede Stripe o una chiave.
