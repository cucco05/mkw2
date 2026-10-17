# Verifica del Passo 4.6 (S0–S3, primo punto di arresto; S4, secondo punto di arresto, in fondo)

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro e delle decisioni: `docs/CHECKOUT-S2-S3.md`, «Passo 4.6 – S0–S3». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre, che cosa è cambiato nei prezzi e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale in modalità test o con telefoni veri: restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (1.1–1.4, 1.26–1.29, 1.41–1.44). Le prove con **Stripe simulato** (rete simulata a livello HTTP con l'SDK Stripe vero, oppure un client Stripe finto nei test in processo) e con **Chromium emulato** sono tenute distinte da quelle necessarie con Stripe reale e dispositivi fisici (sezione 8).

**Ambito autorizzato (primo punto di arresto):** solo S0, S1, S2, S3. **Non iniziati allora:** S4 (rilascio in produzione), S5 (sessione ospite), S6 (pagamenti in verifica), S7 (anteprima e testi), S8, Passo 5. **Il secondo punto di arresto (S4) è in fondo a questo documento; S5, S6, S7, S8 e il Passo 5 restano non iniziati.**

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
