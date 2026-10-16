# Verifica del Passo 4.6 (S0–S3, primo punto di arresto)

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro e delle decisioni: `docs/CHECKOUT-S2-S3.md`, «Passo 4.6 – S0–S3». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre, che cosa è cambiato nei prezzi e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale in modalità test o con telefoni veri: restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (1.1–1.4, 1.26–1.29, 1.41–1.44). Le prove con **Stripe simulato** (rete simulata a livello HTTP con l'SDK Stripe vero, oppure un client Stripe finto nei test in processo) e con **Chromium emulato** sono tenute distinte da quelle necessarie con Stripe reale e dispositivi fisici (sezione 8).

**Ambito autorizzato:** solo S0, S1, S2, S3. **Non iniziati:** S4 (rilascio in produzione), S5 (sessione ospite), S6 (pagamenti in verifica), S7 (anteprima e testi), S8, Passo 5.

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
| `npm run prisma:migrate:drift` | `prisma migrate diff` | **una differenza preesistente** (indice `ModelComment_partId_idx`: in una migrazione, non nello schema), **identica** sullo schema e sulle migrazioni di `HEAD`; nulla dovuto a M1 |
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
13. **Drift preesistente** `ModelComment_partId_idx` (sezione 2): correzione proposta (`@@index([partId])`), non fatta.
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
