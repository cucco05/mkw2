# Verifica del Passo 4.5 – minimo per unità venduta, pagamenti in verifica, percorso nel browser

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro e delle decisioni: `docs/CHECKOUT-S2-S3.md`, «Passo 4.5». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale in modalità test o con telefoni veri: restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (righe 1.1–1.4, 1.26–1.29, 1.30, 1.35–1.39). Le prove con **Stripe simulato** (rete simulata a livello HTTP con l'SDK Stripe vero, oppure un client Stripe finto nei test in processo) e con **Chromium emulato** sono tenute distinte da quelle ancora necessarie con Stripe reale e dispositivi fisici (sezione 6).

## 1. Ambiente delle prove

PostgreSQL 16 locale (`mkw_sectest`, porta 55432); `next start` in produzione (build con `NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR`); SDK Stripe vero davanti a un Stripe simulato (`tests/real-run/fake-stripe-http-preload.js`, nessuna rete); Chromium con emulazione: `chromium` 1280×720, `mobile` 393×851 (Pixel 5, tocco), `mobile-small` 360×640 (tocco). Dati fittizi.

## 2. Risultati

| Verifica | Mezzo | Esito |
|---|---|---|
| Tipi (`tsc --noEmit`), `eslint` (0 avvisi), `next build` (due volte: prima e dopo la correzione del carrello) | locale | OK |
| Unitari nuovi/rifatti: `pricing-minimum` (16), `payment-processing-ended` (8) | `node --test` | 24/24 |
| Sicurezza nuova/rifatta: `minimum-after-scale` (26), `payment-hold` (13), `payment-confirmation-ended` (6), `cart-after-payment` (21: 6 nuovi, 1 sostituito), `multipart-pricing` (8, 2 aggiornati), golden snapshot (1 scenario aggiornato di proposito) | `node --test` | tutte passano |
| `npm run test:security` (serie) | `node --test --test-concurrency=1` | **429/429** (era 403 al 4.4; 0 `todo`) |
| `npm test` | `node --test` | 326/328 — i 2 fallimenti sono **preesistenti** e non riguardano questo passo (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`) |
| `npm run test:api` / `test:contracts` | `node --test` | 7/7 / 14/14 |
| Percorso reale `tests/real-run/checkout-return.ts` (10 scenari × desktop e telefono) | `next start` + Stripe simulato + Chromium | **86/86** |
| Matrice `tests/real-run/checkout-matrix.ts` (18 scenari + 17 casi stampante = 35 × 2 formati; `STRICT_CART=1`) | come sopra | **70/70**, 0 differenze preventivo/ordine/Stripe, 0 differenze carrello/preventivo |
| Guardie di produzione `tests/real-run/production-guards.ts` | `next start` | **8/8** |
| Intera suite nel browser (`npx playwright test`, 3 formati), compresa la nuova `journey-guards.responsive.spec.ts` | Playwright, Chromium emulato, server di produzione locale | **193 passati, 3 saltati, 0 falliti** (i 3 saltati sono gli stessi del 4.4) |
| Mutazioni sulle regole nuove | script fuori dal repository | **28 su 28 rilevate** (sezione 4) |

Matrice economica, scenari che il 4.5 ha cambiato (carrello = preventivo = ordine = Stripe, in centesimi): scenario 06 **500 = 500 = 500 = 500**; le parti (scenari 09, 15, P05) invariate perché la somma supera il minimo; un solo scenario del golden snapshot cambia («part with its own price»: una parte da sola, 4,42 € → 5,00 €).

## 3. Per punto della richiesta

### 3.1 Minimo per unità venduta, modelli a più parti (Decisione 1)

- **Verifica della rappresentazione nel database** (nessuna prova da eseguire, lettura del codice e dello schema; registrata in `docs/CHECKOUT-S2-S3.md`, «Passo 4.5», punto 1): `Model` + `ModelPart`, nessun identificativo di unità; le tre schermate che aggiungono un modello completo (`AddToCartButtons`, `InstantQuoteConfigurator`, «Add group to cart») lo aggiungono come **una riga per parte**; un modello completo e le sue parti comprate una per una sono **indistinguibili**. Per questo **non si sono inventate associazioni**: il server calcola un **limite inferiore** valido per ogni lettura del carrello.
- **Regola** (`lib/pricing.ts`: `countMultipartUnits`, `applyGroupMinimum`; `lib/checkout-quote.ts`): una copia di ogni parte = 1 set = 1 unità; ogni copia in più = 1 unità; stessa parte in più righe = si somma; i prezzi delle righe del gruppo, insieme, non scendono sotto *unità × minimo* (il resto è ripartito in proporzione). Righe che sono un'unità per copia (modello intero, a una parte, prodotto) = minimo per copia.
- **Prove** (`tests/security/minimum-after-scale.sec.ts`, 26 test; `tests/pricing-minimum.test.ts`, 16; `tests/security/multipart-pricing.sec.ts` aggiornato; calcoli fatti nel test, non letti dal codice): modello completo (una riga per parte) = somma delle parti, **il minimo non si applica a ogni parte**; modello completo ridimensionato sotto il minimo = **un** minimo; una parte da sola = 1 minimo (×3 = 3 minimi); 2 parti su 3 = 2 minimi; stessa parte in 3 righe (altri colori e scale) = stesso totale di una riga (**non aggirabile dividendo il carrello**); 2 set + 2 copie in più = 4 unità; riga di modello intero ×2 a scala 0,5 = 2 minimi; **sconto quantità e sconto del cliente dopo il minimo** (anche per le parti); parti il cui prezzo supera il minimo, ridimensionate sotto → minimo; negozio senza minimo → nessun cambiamento; catena preventivo = ordine = Stripe invariata.
- **Conseguenze note fissate da una prova:** effetto soglia (completare un set abbassa le unità), sottoinsieme «Add group to cart» letto come parti separate, una riga costosa può coprire il minimo delle economiche. **Proposta di intervento circoscritto** (identità di unità esplicita) in `docs/CHECKOUT-S2-S3.md`; **non realizzata**.

### 3.2 Prezzi fissi e scala bloccata (Decisione 2)

- Prezzo fissato a mano **sotto** il minimo: ora portato al minimo (prima restava com'era) — a scala 1 (3,00 → 5,00), ridimensionato (3,00 × 0,343 = 1,03 → 5,00), e per volume quando supera il minimo (3,00 × 1,728 = 5,18 resta 5,18). Prodotto con **scala bloccata** 0,5: 5,00 invece di 1,35. Prezzo fisso pari o sopra il minimo: come prima.
- **Nessuna deroga dedotta**: nessun campo, flag o configurazione esistente è stato letto come esenzione; il meccanismo di deroga autorizzata e tracciata è una **proposta non realizzata**.
- **Vetrina coerente** (`resolveModelPricing` e anteprima della pagina del modello): un prezzo fisso sotto il minimo è mostrato almeno al minimo; prova unitaria. Aggiornamento di `effectivePriceUsd`: al primo ricalcolo (nota in checklist 1.30).
- **Sconti dopo il minimo** (politica già concordata): confermato da prove (5 % da 10 pezzi, 10 % da 25, sconto del cliente, urgenza).
- **Golden snapshot** (`tests/fixtures/checkout-golden.json`): **un solo scenario cambia** («part with its own price»: una parte da sola da 4,42 € → 5,00 €), aggiornato di proposito; gli altri scenari sono invariati.
- **Da confermare con il negozio:** moltiplicatori di opzione < 1 (tolleranza «bozza» 0,94; prodotto con `lockedPriceMultiplier` < 1) si applicano **dopo** il minimo come gli sconti.

### 3.3 Pagamenti in verifica (Decisione 3)

- **Nessuno sblocco a tempo** (`tests/security/cart-after-payment.sec.ts`, 21 test): un pagamento in conferma di 30 giorni fa blocca ancora (409) se Stripe lo mostra in lavorazione; uno ricevuto-in-verifica di 90 giorni fa blocca ancora e Stripe non viene nemmeno interrogato; **Stripe dice «pagina scaduta»** → ordine chiuso e nuovo pagamento consentito (200, nuovo ordine, vecchio ordine annullato con tentativo scaduto); **Stripe dice «pagato»** → registrato come pagato e la richiesta riceve ancora `PAYMENT_IN_PROGRESS` (nessun secondo pagamento subito dopo il primo), poi il riordino è consentito; **Stripe non raggiungibile** → resta bloccato, nulla cambia; **al massimo una lettura ogni 4 secondi per ordine** (nessuna raffica da un cliente che preme «Paga»); lo stesso per un ospite con il cookie.
- **Difetto corretto** (`tests/payment-processing-ended.test.ts`, 8 test puri; `tests/security/payment-confirmation-ended.sec.ts`, 6 test sul database): un ordine «in conferma» torna in attesa di pagamento, e se nulla altro può portare denaro viene chiuso, **solo** se Stripe mostra che non c'è denaro in movimento, l'attempt è quello in conferma e nessun altro attempt è in conferma, pagato o in verifica; una pagina solo aperta, un pagamento in lavorazione o autorizzato, un ordine pagato o annullato non cambiano.
- **Procedura amministrativa** (`tests/security/payment-hold.sec.ts`, 13 test): solo amministratore (nessuno 401, cliente e staff 403), solo dal sito (origine estranea 403), motivo ≥ 10 caratteri e solo i campi previsti (qualsiasi altro campo → 400); nulla da risolvere → 409; **«nessun addebito»**: ordine annullato, tentativi chiusi, pagina chiusa presso Stripe, decisione conservata (chi, quando, perché, cosa ha detto Stripe, stato precedente), evento nel registro di audit, il cliente può pagare di nuovo; **rifiutato** se un pagamento è incassato presso Stripe (importo diverso: denaro presente, ordine tenuto) o se l'ordine è pagato; **Stripe non raggiungibile** → rifiutato, e con l'assunzione esplicita registrata come `unreachable_acknowledged`; Stripe che mostra l'incasso quando viene richiesto → registrato come pagato e «nessun addebito» rifiutato; **«accettato»**: toglie il blocco (stato dell'ordine invariato), il riordino resta bloccato finché l'ordine è in revisione e si sblocca quando esce; rifiutato se non incassato; non si risolve due volte; **due decisioni simultanee: una vince**.
- **Idempotenza lato server per due prime richieste da ospite** (`cart-after-payment.sec.ts`, prova «two FIRST requests…»): il limite resta **documentato e provato**; valutata la soluzione (identificativo del browser emesso dal server) e **proposta, non realizzata** perché richiede una migrazione, un cookie e approvazione.

### 3.4 Percorso nel browser (le voci mancanti del piano originario)

`tests/e2e/journey-guards.responsive.spec.ts` (nuova; 1 percorso × 3 formati: desktop 1280×720, `mobile` 393×851, `mobile-small` 360×640): home → Discover → modello → «Add» → carrello (serve un colore) → checkout → «Paga» (pagina di Stripe **simulata**) → pagina lasciata → ritorno «in conferma» poi «pagato» → pagina scaduta.
- A ogni passo: **nessuno scorrimento orizzontale**, nessun elemento più largo dello schermo e, su telefono, **bersagli ≥ 44 px** per i controlli principali (carrello, «Paga», controlli della pagina di ritorno).
- Su tutto il percorso: **nessun errore in console, nessuna eccezione non gestita, nessuna risposta 5xx, nessuna richiesta fuori dal sito** (unica eccezione dichiarata nel codice: la pagina di Stripe simulata).
- **Schermate** di ogni passo in `test-results/step-4.5/<progetto>/NN-passo.png` (11 per formato, 33 in tutto, ~17 MB; allegate anche al rapporto di Playwright). `test-results/` non è nel repository.
- **Provato che i controlli funzionano:** alla prima esecuzione la prova **ha fallito** per la richiesta `GET /api/presets` → 401 fatta dal carrello a un visitatore (riga rossa in console), e per l'anteprima 3D con un file non leggibile (seed con percorso non reale); una variante con una richiesta a `tracker.example` e un `console.error` iniettati **fallisce** sul controllo delle richieste esterne. Entrambi i difetti sono descritti e corretti in sezione 5.
- **Visto e non corretto:** su 360 px la scheda dell'articolo nel carrello lascia al titolo una colonna molto stretta (il titolo va a capo quasi lettera per lettera accanto a un segnaposto di miniatura vuoto): non è un errore dei controlli (nessuno scorrimento, bersagli ≥ 44 px) ma è brutto; nessun intervento, da valutare con il negozio. Il messaggio d'errore dell'anteprima 3D con file non leggibile non va a capo (sezione 5).
- **Limite:** Stripe simulato e Chromium emulato; non una carta di prova su Stripe, non un telefono vero.

## 4. Prove di mutazione

28 mutazioni sulle regole nuove (script fuori dal repository), **tutte rilevate**: minimo (prezzo a mano esente, prodotto esente, minimo per componente, parti senza minimo, set che ignora la parte mancante, copie contate per riga, pavimento non condiviso, riga di modello intero trattata come parte, vetrina senza minimo); pagamenti (blocco che scade di nuovo dopo 72 ore, nessuna interrogazione di Stripe, «pagato» che lascia passare, Stripe non raggiungibile letto come sbloccato, la conferma che non finisce mai, finisce per una pagina solo aperta, la scadenza che non la fa finire, altri attempt ignorati); procedura admin (staff ammesso, nessun motivo, nessun controllo dell'incasso, Stripe irraggiungibile senza assunzione di responsabilità, «accettato» su ordine non pagato, nessuna rilettura nella transazione, nessun controllo dell'origine, nessun registro di audit, pagine di pagamento non chiuse). **Due mutazioni erano all'inizio equivalenti** (la rilettura dopo una lettura fallita non cambia nulla; «accettato» ha una doppia protezione): rilevate con una variante che toglie l'effetto vero / entrambe le protezioni.

## 5. Problemi trovati strada facendo

1. Un ordine «in conferma» non tornava mai in attesa di pagamento se il pagamento finiva senza denaro (corretto; era nascosto dalla finestra di 72 ore).
2. L'attempt in conferma di un ordine con pagina scaduta restava «in conferma» (corretto: ammesso il passaggio a «scaduto»).
3. `paymentReviewReason` non veniva mai azzerato da nessun codice: un ordine pagato, accettato e spedito mostrava per sempre «in verifica» al cliente e, senza la finestra, avrebbe bloccato per sempre lo stesso carrello. Ora la procedura amministrativa lo azzera con traccia (l'etichetta del cliente si corregge di conseguenza).
4. **Il carrello chiedeva i preset a un visitatore** (`GET /api/presets` → 401): trovato dal controllo «nessun errore in console» sul percorso ospite, corretto in modo minimo (il layout passa `authed` a `CartProvider`, il carrello non li chiede ai visitatori). **Non corretto, segnalato:** il messaggio d'errore dell'anteprima 3D quando il file non si carica (indirizzo lungo, non va a capo, tagliato su telefono).
5. **La seed delle prove nel browser usava un percorso del file non reale** (`models/<id>/…`): l'anteprima 3D del carrello dava 401 a un ospite. Corretta la seed (percorso vero + un piccolo STL in `E2E_STORAGE_DIR`); non era un difetto del sito.
6. La proprietà «più copie = mai meno unità» che avevo ipotizzato per i modelli a più parti è **falsa** al completamento di un set: trovata da una prova di proprietà, ora documentata e fissata (effetto soglia).

## 6. Che cosa NON è stato provato

| Non provato | Perché conta | Dove resta |
|---|---|---|
| Stripe reale in modalità test: pagamento, annullamento, scadenza, rimborso, contestazione, `payment_intent.processing` (carte con elaborazione lenta) | Il comportamento di Stripe che il server interroga per sbloccare è simulato | checklist 1.1, 1.2, 1.36 |
| iPhone/Safari e Android veri; cookie ospite con prevenzione del tracciamento | Chromium emulato non è Safari | checklist 1.3, 1.4, 1.27–1.29, 1.33, 1.35 |
| La procedura amministrativa in uso reale con un'assistenza | Esiste solo come richiesta autenticata, senza pulsante | checklist 1.36, 1.37 |
| Scelte commerciali: identità di unità per i modelli a più parti, deroga autorizzata, moltiplicatori < 1 dopo il minimo, inventario dei prezzi fissi sotto il minimo | Decisioni del negozio | checklist 1.30 |
| Due prime richieste simultanee da ospite | Soluzione proposta, non realizzata | checklist 1.38 |
| Anteprima della pagina del modello = carrello | Calcolo separato dal motore del checkout (dal 4.5 non scende sotto il minimo per i prezzi fissi) | checklist 1.39 |

## 7. Come rifare le prove

```
# build (la valuta va nota alla build)
NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run build

# unitari e sicurezza (database di prova locale)
DATABASE_URL=… JWT_SECRET=… npm test
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security

# server reale + Stripe simulato (avviano loro `next start`)
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/checkout-return.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/production-guards.ts

# browser su 3 formati: PRIMA la seed (scrive E2E_FIXTURE e il file del modello in E2E_STORAGE_DIR), POI il server (STORAGE_DIR uguale), POI le prove (schermate in test-results/step-4.5/)
SEC_TEST_DATABASE_URL=… E2E_FIXTURE=/tmp/fixture.json E2E_STORAGE_DIR=/tmp/e2e-storage node --import tsx tests/e2e/seed-customer-orders.ts
STORAGE_DIR=/tmp/e2e-storage NODE_ENV=production PORT=3097 DATABASE_URL=… BASE_URL=http://127.0.0.1:3097 CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR TAX_MODE=none \
  SHIPPING_FLAT_RATE_CENTS=700 STRIPE_SECRET_KEY=sk_test_FAKE_not_a_real_key_000000000000 STRIPE_WEBHOOK_SECRET=whsec_FAKE \
  JWT_SECRET=sectest-jwt-secret-0123456789abcdefghijklmnop next start -p 3097
E2E_FIXTURE=/tmp/fixture.json E2E_ADMIN_TOKEN=<adminToken del seme> E2E_BASE_URL=http://127.0.0.1:3097 E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test

# la procedura amministrativa (richiesta autenticata; solo un amministratore; esempio)
curl -X POST https://<sito>/api/admin/orders/<orderId>/payment-hold -H 'content-type: application/json' -H 'origin: https://<sito>' \
  --cookie "<sessione dell'amministratore>" -d '{"outcome":"no_charge","reason":"Controllato nella dashboard di Stripe: nessun addebito per questo ordine."}'
```

Avvertenza: `tests/real-run/*` e `tests/security/*` cancellano i modelli del database di prova (`resetDb`): rifare la seed **prima** di avviare il server per le prove nel browser (l'elenco Discover tiene la lista 90 secondi).
