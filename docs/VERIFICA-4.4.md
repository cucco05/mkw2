# Verifica del Passo 4.4 – il carrello dopo Stripe, il minimo per pezzo, la barra superiore, i materiali

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro e delle decisioni: `docs/CHECKOUT-S2-S3.md`, «Passo 4.4». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale o con telefoni veri: restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (righe 1.26–1.29, 1.33, 1.35, 1.36). Le prove con **Stripe simulato** (rete simulata a livello HTTP, SDK Stripe vero) e con **Chromium emulato** sono tenute distinte da quelle ancora necessarie con Stripe reale e dispositivi fisici (sezione 6).

## 1. Ambiente delle prove

PostgreSQL 16 locale (`mkw_sectest`, porta 55432); `next start` in produzione (build con `NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR`); SDK Stripe vero davanti a un Stripe simulato (`tests/real-run/fake-stripe-http-preload.js`, nessuna rete); Chromium con emulazione: `chromium` 1280×720, `mobile` 393×851 (tocco), `mobile-small` 360×640 (tocco). Dati fittizi.

## 2. Risultati

| Verifica | Mezzo | Esito |
|---|---|---|
| Tipi (`tsc --noEmit`), `eslint` (0 avvisi), `next build` | locale | OK |
| Unitari nuovi/rifatti: `pricing-minimum` (6), `order-status-client` (13: la parte sulla memoria dell'ordine è stata riscritta) | `node --test` | 19/19 |
| Sicurezza nuova: `minimum-after-scale` (18), `cart-after-payment` (16), `a1-mini-materials` (7) + 1 in `s2s3-step4` (pagina di stato) + 1 in `minimum-amounts` + 4 casi stampante nuovi (P14–P17) | `node --test` | tutte passano |
| `npm test` | `node --test` | 308/310 — i 2 fallimenti sono **preesistenti** e non riguardano questo passo (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`) |
| `npm run test:api` / `test:contracts` | `node --test` | 7/7 / 14/14 |
| `npm run test:security` (serie) | `node --test --test-concurrency=1` | **403/403** (0 `todo`) |
| Intera suite nel browser (`npx playwright test`, 3 formati) | Playwright | **190 passati, 3 saltati, 0 falliti** (i 3 saltati: la prova da tastiera del checkout è solo per desktop e salta i due formati telefono; la prova della ricerca su telefono salta su desktop) |
| Percorso reale `tests/real-run/checkout-return.ts` (10 scenari × desktop e telefono) | `next start` + Stripe simulato + Chromium | **86/86** |
| Matrice `tests/real-run/checkout-matrix.ts` (18 scenari + 17 casi stampante = 35 × 2 formati; `STRICT_CART=1`) | come sopra | **70/70**, 0 differenze preventivo/ordine/Stripe, 0 differenze carrello/preventivo |
| Guardie di produzione `tests/real-run/production-guards.ts` | `next start` | **8/8** |
| Migrazione dei materiali su un database **vuoto** con tutte le migrazioni (`prisma migrate deploy`) | PostgreSQL | A1 mini `{PLA,PETG}`, 180 × 180 × 180 mm, ugello 0,4 |

## 3. Per punto della richiesta

### 3.1 Il carrello dopo Stripe (punto 1)

- **Il server rifiuta il secondo pagamento** (`tests/security/cart-after-payment.sec.ts`, 16): pagamento in conferma → `409 PAYMENT_IN_PROGRESS` con altra chiave e da altra scheda (ordine unico, nessuna nuova pagina di Stripe); ricevuto-in-verifica; tentativo «in elaborazione» presso Stripe; non ancora pagato → stessa pagina di pagamento (anche **ospite**, con il cookie); ordine pagato e in produzione → nuovo ordine consentito; pagina scaduta → nuovo ordine; **altro carrello, altro cliente, cookie falso, cookie di un altro ordine, accesso scaduto, ospite che non può bloccare l'ordine di un account** → mai bloccato né riusato; finestra di blocco; due schede con la **stessa chiave** a pari istante → un solo ordine e una sola pagina; limite scritto (due **prime** richieste simultanee con chiavi diverse e senza cookie non si conoscono).
- **Nel browser, a 3 formati** (`tests/e2e/payment-return.responsive.spec.ts`, 19 scenari): in conferma e in verifica (il carrello resta, avviso, «Paga»/«Checkout» spenti, nessun «non completato»); pagamento verificato (carrello svuotato, memoria dimenticata, conferma che resta a schermo); pagina di Stripe lasciata, scaduta, **cookie ospite assente o scaduto (404)**, servizio di stato giù, **carrello cambiato dopo**; «Paga» che scrive la memoria con l'impronta del carrello e la chiave condivisa in `localStorage`; rifiuto `PAYMENT_IN_PROGRESS`; **più schede** (una conferma di pagamento che svuota il carrello e l'altra scheda che lo **segue** senza riscrivere il vecchio carrello; una scheda che manda l'ordine a Stripe e l'altra che lo scopre; una modifica del carrello in una scheda che compare nell'altra); **tasto Indietro** (dalla pagina di stato, e da Stripe dopo aver pagato); **scheda di nuovo visibile** dopo un pagamento fatto altrove. La pagina di ritorno (`checkout-success.responsive.spec.ts`, 14 × 3) ha le stesse regole.
- **Con server reale e Stripe simulato** (`checkout-return.ts`, 86): pagato senza webhook; Stripe irraggiungibile («in conferma», il carrello **resta**, poi «pagato» e solo allora il carrello si svuota, al massimo 8 richieste); pagina scaduta; indirizzo di un vecchio ordine; **scheda chiusa su Stripe, il carrello trova il pagamento alla visita successiva**; **stesso carrello pagato di nuovo con la memoria persa** (il server rifiuta, nomina l'ordine, nessun secondo ordine); **cookie ospite perso** (nessun avviso, nessuna supposizione, il carrello resta); **tasto Indietro** prima e dopo aver pagato; cliente registrato e area ordini.
- **Correzione trovata dalle prove** (`tests/security/s2s3-step4.sec.ts`, nuovo test): la pagina di stato rispondeva «non completato» a chi era appena tornato da Stripe se Stripe era stato interrogato da meno di 4 secondi (anche da una seconda scheda) e la pagina smetteva di chiedere; ora «in conferma» e richiede dopo 2,5 secondi.

### 3.2 Minimo commerciale per pezzo (punto 2)

- **Analisi**: tre significati distinti del «minimo» (per pezzo, dell'ordine, di Stripe), solo il primo toccato; il minimo per pezzo è già nel motore del prezzo ma veniva applicato **prima** della scala (`docs/CHECKOUT-S2-S3.md`, «Passo 4.4», punto 2).
- **Correzione** nel motore autorevole (`lib/checkout-quote.ts` con `lib/pricing.ts`): dopo la scala il prezzo base del pezzo è `max(prezzo base × volume, minimo)`; nulla cambia a scala 1, in ingrandimento o senza minimo; nessuna cifra nuova.
- **Prove** (`tests/security/minimum-after-scale.sec.ts`, 18; `tests/pricing-minimum.test.ts`, 6; calcoli fatti nel test, non letti dal codice): a dimensione originale invariato; ridimensionamento sopra il minimo invariato; **scenario 06: 5,00 € invece di 1,35 €**; nessuna scala tra 0,1 e 5 porta un pezzo sotto il minimo e un pezzo più grande non costa mai meno di uno più piccolo; una scala per asse; **quantità** (il minimo è per pezzo); **sconto quantità** (5 % da 10 pezzi e 10 % da 25, sopra il minimo); **sconto del cliente**; colori; tolleranza; modello a prezzo fisso; **prezzo fisso a mano pari o sopra il minimo** (floorato) e **sotto il minimo** (lasciato com'è); **parti multiple** (lasciate come prima, anche con parti il cui prezzo supera il minimo: la prova che *scoprirebbe* un'applicazione del minimo alle parti); **prodotto con scala bloccata** (lasciato); **negozio senza minimo**; e la catena **preventivo = ordine = Stripe** (2 pezzi a scala 0,5 = 2 × 5,00 €, riga inviata a Stripe 5,00 €). Matrice nel browser: scenario 06 **500 = 500 = 500 = 500** (carrello, preventivo, ordine, Stripe), P16 (scala 0,1: 500), P17 (3 pezzi a scala 0,5 con IVA aggiunta: 2684), P12 (negozio senza minimo per pezzo: ancora rifiutato dal minimo di Stripe).
- **Fermato come richiesto**: il significato del minimo per **una parte** di un modello a più parti (e per parti scalate in modo diverso) è ambiguo: comportamento invariato, decisione richiesta (checklist 1.30).

### 3.3 La prova `buyer-journey` (punto 3)

Causa: **prova obsoleta** (non un componente modificato né un problema del percorso). Evidenza: il pulsante «Add» è sempre stato solo nell'elenco di Discover (verificato con la storia del repository, `c3e64fb`); la prova **fallisce identica, alla stessa riga, anche su una compilazione del commit precedente a questo passo** (`deca0dd`, worktree separato, stessa seed); la pagina del modello mostra «Save to cart» (spento finché non si sceglie un colore). Riscritta sul percorso vero (home → Discover → modello → «Add» da Discover → carrello che rifiuta il checkout senza colore → colore → «Checkout» → `/checkout`); passa su 3 formati. Cosa **non** è reale in quella prova: il solo campo `canCheckout` della risposta del preventivo (un server di prova locale non può prendere pagamenti con carta); il pagamento è coperto dalle prove con server reale e Stripe simulato.

### 3.4 Barra superiore e compatibilità (punto 4)

- Diagnosi del 4.3 **corretta** (era sbagliata): la «sbordatura di 13 px» era l'effetto di due pagine più larghe dello schermo (`/settings/profile` +44 px e `/upload` +25 px per il selettore di file). Una regola per ogni selettore di file e una classe sul blocco dell'avatar le correggono.
- Difetti veri della barra per chi è registrato su telefono: ricerca sotto il pulsante del menu e controlli da 36 px. Ora ≥ 44 px, due righe fino a 640 px, la pagina parte sotto la barra.
- `tests/e2e/top-bar.responsive.spec.ts` (3 × 3, registrato/visitatore, 9 pagine): nessuno scorrimento orizzontale, controlli dentro lo schermo, mai sovrapposti, ≥ 44 px su telefono, il titolo parte sotto la barra, la ricerca è usabile (≥ 150 px, si può scrivere).
- **Carrello, checkout, conferma pagamento e area ordini sui tre formati**: `cart` (13 per formato, con le nuove prove sulla corsa delle risposte, sulle modifiche rapide e su `429`), `checkout`, `checkout-success`, `payment-return`, `customer-orders`, `top-bar`: nessuno scorrimento orizzontale, bersagli ≥ 44 px, nessun elemento oltre lo schermo.

### 3.5 Materiali della A1 mini (punto 5)

`tests/security/a1-mini-materials.sec.ts` (7): la migrazione toglie TPU **solo** se l'elenco è ancora `PLA, PETG, TPU`; **7 elenchi personalizzati** (materiale aggiunto, già PLA/PETG, PETG tolto, ordine diverso, più materiali, scritti in minuscolo, vuoto) **non vengono toccati**, nemmeno l'ora dell'ultima modifica; riapplicarla non cambia nulla; volume 180 × 180 × 180 mm, margini, ugello 0,4, finiture, nome e le altre macchine invariati; con la configurazione di una nuova installazione PLA e PETG sono quotati e pagabili online (anche `petg` in minuscolo) e **TPU va a valutazione manuale** (`MATERIAL_NOT_AVAILABLE`); il supporto agli altri materiali non è stato rimosso (riaggiunto TPU o ABS dall'admin, tornano in vendita).

## 4. Mutazioni (si rompe una cosa alla volta e si verifica che almeno un test fallisca)

- **Sul codice di server e logica del browser, 21 su 21 rilevate** (più 1 equivalente documentata): minimo per pezzo (nessun minimo dopo la scala; applicato alle parti o ai prodotti con scala bloccata; prezzo fissato a mano sotto il minimo alzato; scarto di un centesimo; minimo configurato ignorato; minimo applicato dopo colori e tolleranza); protezione del server (nessuna protezione; «in verifica» non bloccante; cookie ospite non verificato; finestra di un minuto; ospite che non riusa l'ordine; impronta del carrello che ignora le righe; la rotta che non chiama la protezione; la lettura recente di Stripe che dice «non pagato»); memoria e regole del browser (carrello svuotato a «in conferma»; svuotato qualunque sia il carrello; memoria che non scade; «in verifica» non incerto; un altro carrello che corrisponde alla memoria). *Equivalente documentata*: togliere **solo** il filtro per cliente dalla ricerca del server non cambia il risultato perché il cliente è già nell'impronta del carrello (doppia protezione); togliendo **entrambe** la prova fallisce.
- **Su build vere, 13 su 13 rilevate**: carrello che non segue le altre schede; «Paga» non spento in conferma; carrello che non si svuota a pagamento verificato; avviso «non completato» sempre mostrato; memoria dell'ordine non scritta; pagina di ritorno che svuota a «in conferma»; regola dei selettori di file tolta; regola della ricerca su due righe tolta; chiamata alla visibilità della scheda tolta; avviso che non si ferma mentre si parte per Stripe; campanella da 36 px; **risposta vecchia che sostituisce la nuova** (tolti insieme l'annullamento e il contatore di sequenza: la prova sulla corsa delle risposte fallisce); **debounce tolto** (la prova sulle modifiche rapide fallisce). Due non venivano rilevate al primo giro e hanno portato a correggere la prova: la prova sulla corsa delle risposte cliccava prima che la prima richiesta fosse partita (nessuna corsa) e la prova sulle parti multiple usava parti sotto il minimo (il minimo non sarebbe scattato).

## 5. Distinzione tra Stripe simulato e Stripe reale

| Fatto con Stripe **simulato** (SDK vero, rete simulata, webhook firmati) | Ancora necessario con Stripe **reale** in modalità test e dispositivi fisici |
|---|---|
| Pagamento confermato, in attesa, annullato/scaduto, in verifica; webhook mai arrivato; Stripe irraggiungibile; ritorno dalla pagina di Stripe; cookie ospite assente o scaduto; più schede; tasto Indietro; prezzo minimo dopo ridimensionamento fino a Stripe; compatibilità responsive su Chromium emulato | Tutto ciò, di nuovo, con Stripe vero (parametri accettati, pagina ospitata, tempi reali di webhook, importo minimo di 0,50 €) e su **iPhone/Safari e Android veri** (cookie `mw_checkout` con prevenzione del tracciamento, cache delle pagine al tasto Indietro, zona sicura/tacca, tastiera, browser interni delle app): checklist 1.26–1.29, 1.33, 1.35 |

## 6. Non provato

Stripe reale; telefoni veri (in particolare **Safari/iOS e il tasto Indietro con la cache delle pagine**: Chromium non è Safari); lettori di schermo reali; dietro il proxy/CDN di produzione; più istanze; traffico reale. Rischio residuo noto: un ospite **senza cookie** non può essere riconosciuto dal server (un nuovo «Paga» crea un nuovo ordine).

## 7. Rischi residui e decisioni aperte

1. **Modelli a più parti**: significato del minimo per una parte (decisione richiesta, checklist 1.30); prezzi fissati a mano sotto il minimo e prodotti con scala bloccata: lasciati come sono (da confermare).
2. **Pagamento «in verifica» che blocca lo stesso carrello per 72 ore** (scelta prudente): serve una procedura dell'assistenza (1.36).
3. Ospite senza cookie; due prime richieste simultanee con chiavi diverse; `localStorage` bloccato (nessuna memoria: resta la difesa del server).
4. Colori amministrabili senza StockWorks, notifiche dei preventivi manuali, margini tecnici della stampante, unità ambigue nel caricamento, importo minimo dell'ordine: **non toccati** (fuori dal perimetro del 4.4, registrati nella checklist).
5. Le pagine dell'area cliente e il carrello restano in inglese fino alla fase di traduzione (testi centralizzati).

## 8. Come rifare le prove

```
# build (la valuta va nota alla build)
NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run build

# unitari, sicurezza (database di prova locale)
DATABASE_URL=… JWT_SECRET=… npm test
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security

# server reale + Stripe simulato (avviano loro `next start`)
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/checkout-return.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts

# browser su 3 formati: PRIMA la seed (scrive E2E_FIXTURE), POI il server, POI le prove
SEC_TEST_DATABASE_URL=… E2E_FIXTURE=/tmp/fixture.json node --import tsx tests/e2e/seed-customer-orders.ts
NODE_ENV=production PORT=3097 DATABASE_URL=… BASE_URL=http://127.0.0.1:3097 CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR TAX_MODE=none \
  SHIPPING_FLAT_RATE_CENTS=700 STRIPE_SECRET_KEY=sk_test_FAKE_not_a_real_key_000000000000 STRIPE_WEBHOOK_SECRET=whsec_FAKE \
  JWT_SECRET=sectest-jwt-secret-0123456789abcdefghijklmnop next start -p 3097
E2E_FIXTURE=/tmp/fixture.json E2E_ADMIN_TOKEN=<adminToken del seme> E2E_BASE_URL=http://127.0.0.1:3097 E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test
```

Avvertenza: `tests/real-run/*` e `tests/security/*` cancellano i modelli del database di prova (`resetDb`): rifare la seed **prima** di avviare il server per le prove nel browser (l'elenco Discover tiene la lista 90 secondi).
