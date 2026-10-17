# Verifica del Passo 4.6 (S0–S3, primo punto di arresto; S4 e S5, secondo e terzo punto di arresto, in fondo)

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

- **R1 — NON eliminato:** due *prime* richieste simultanee di un browser nuovo possono ricevere due sessioni diverse e creare due ordini con due pagine Stripe. Fotografato da due test (in processo e con due processi reali) e ridotto (cookie al primo preventivo, 428 solo come rete di sicurezza, 300 ms prima dell'unica ripetizione); **non dimostrabile come nullo**; rilevabile a posteriori (Passo 5, checklist 1.56).
- **R2** cookie perso o scaduto (senza cookie d'accesso, una ripetizione crea un secondo ordine; l'ordine non pagato si ritrova dal cookie d'accesso per 72 h). **R3** sessione copiata: non apre nulla; può solo, con lo stesso carrello e lo stesso totale entro un'ora, ottenere la pagina di pagamento di un ordine **non pagato** di quella sessione. **R4** due dispositivi/due browser: identità indipendenti. **R5** carrello modificato dopo un primo ordine non pagato: pagine Stripe gemelle (Passo 5). **R6** Safari/ITP e browser integrati nelle app: da provare su dispositivi veri. **R7** (nuovo, non realizzato) sessione imposta al browser da un sottodominio gemello o da una rete http: stessa portata di R3, mitigata da `Secure`/`HttpOnly`/`SameSite=Lax`; il prefisso `__Host-` e HSTS sono proposte (`docs/SESSIONE-OSPITE.md`, §7).
- **Ambito (scelta dichiarata, da confermare):** la sessione protegge il percorso **con pagamento**. Le due strade che creano un ordine **senza pagamento e senza sessione Stripe** — la richiesta di preventivo manuale (`/api/checkout/manual-request`) e il metodo `quote` della rotta vecchia — non la richiedono e i loro ordini non hanno `guestSessionHash`; la carta della rotta vecchia è spenta in produzione. Il requisito «niente ordini né sessioni Stripe senza sessione valida» vale per ogni ordine che può essere pagato. Estenderlo ai preventivi (per limitarne i duplicati) è una decisione separata.
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
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session.ts            # 77 controlli, 3 formati
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
