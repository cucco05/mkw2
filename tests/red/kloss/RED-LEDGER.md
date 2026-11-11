# R1-3 / KLOSS — Registro delle prove (P0 RED, stato dopo P2, controlli, limite E2, misure)

Stato: **P2 del PLAN REV3 eseguita in locale** (flag `CHECKOUT_OWNER_GUARD=off|shadow|on`, **default `off`**). Le prove sono state scritte in P0 sul HEAD `bf256f0…` come RED. PostgreSQL isolato, Stripe **simulato** (`tests/security/_stripe-sim.ts`), nessuna chiamata a Stripe reale né in Test Mode.

* **15 prove (12 id) sono diventate VERDI in P2** e fanno parte della suite ordinaria `npm run test:security`, con gli stessi id e le stesse asserzioni di P0; girano con il flag `on`.
* **3 prove (D3, il riacquisto dopo un pagamento) restano ROSSE**: appartengono a P3 e restano fuori dalle suite ordinarie.
* **P3 (PLAN REV2), commit 0**: prima di ogni correzione sono state aggiunte **4 prove RED**: tre di D3 (`KL-D3-confirm-incomplete`, `KL-D3-stale-order`, `KL-D3-older-reuse`) e una del limite E2 (`KL-E2-login`, destinata a **restare rossa** dopo P3). `KL-D3-confirm` riceve prima la proposta e poi rimanda il suo `repeatContext`: asserzione e valori fissati sono quelli di P0.
* **P3 eseguita in locale** (flag `CHECKOUT_REPEAT_GUARD=off|shadow|on`, **default `off`**, efficace solo con `CHECKOUT_OWNER_GUARD=on`): le **6 prove D3 sono VERDI** e fanno parte della suite ordinaria (`tests/security/kloss-repeat.sec.ts`, stessi id e stesse asserzioni, con i due flag `on`). **Resta rossa 1 prova: `KL-E2-login`** (limite E2).
* **E2 resta un limite non risolto** (vedi sotto): P2 non lo chiude, P3 neppure.

Nessuna prova si cancella o si indebolisce: la guardia `tests/kloss-red-separation.test.ts` (in `npm test`) fissa, per ogni id, dove sta il test e **i valori attesi di P0**; fallisce se una prova sparisce, cambia id, cambia attesa, perde una variante o finisce nel posto sbagliato. Con il flag `off` (default) gli stessi scenari finiscono ancora come nella colonna "Effettivo prima di P2" (`tests/security/kloss-guard-flags.sec.ts` lo dimostra).

## Come si eseguono

| Cosa | Comando (stesso database isolato di `test:security`) | Atteso oggi |
|---|---|---|
| Prove diventate verdi in P2 | fanno parte di `npm run test:security`: `kloss-cross-order.sec.ts` (11), `kloss-sessions-and-locks.sec.ts` (3), `kloss-window.sec.ts` (1) | 15 test, 15 verdi |
| Prove diventate verdi in P3 | fanno parte di `npm run test:security`: `kloss-repeat.sec.ts` (6) | 6 test, 6 verdi |
| RED rimasto (E2-login) | `SEC_TEST_DATABASE_URL=postgresql://…/<db isolato> npm run test:kloss-red` | **1 test, 1 fallito** (con i flag spenti e con i due flag `on`) |
| Controlli | `npm run test:security`: `kloss-controls.sec.ts` (flag `off`) e `kloss-controls-on.sec.ts` (flag `on`) | 12 + 12 verdi |
| Guardia | `npm test` (`tests/kloss-red-separation.test.ts`) | verde |
| EXPLAIN | `tests/red/kloss/explain.sh <ordini>` (database temporaneo, eliminato a fine corsa) | numeri sotto |

## Stato di ogni prova dopo P2

| Id | Test | Stato | Dove |
|---|---|---|---|
| `KL-D1-price` | 1 | VERDE da P2 | `tests/security/kloss-cross-order.sec.ts` |
| `KL-D1-uncertain` | 2 | VERDE da P2 | idem |
| `KL-D1-stale` | 1 | VERDE da P2 | idem |
| `KL-D1-concurrent` | 1 | VERDE da P2 | idem |
| `KL-HOLD-uniform` | 1 | VERDE da P2 | idem |
| `KL-A-legacy` | 3 | VERDE da P2 | idem |
| `KL-A-unreachable` | 1 | VERDE da P2 | idem |
| `KL-B-paid-hidden` | 1 | VERDE da P2 | idem |
| `KL-D2-window` | 1 | VERDE da P2 | `tests/security/kloss-window.sec.ts` |
| `KL-D-cookie` | 1 | VERDE da P2 | `tests/security/kloss-sessions-and-locks.sec.ts` |
| `KL-E1-concurrent` | 1 | VERDE da P2 | idem |
| `KL-LOCK-owner` | 1 | VERDE da P2 | idem |
| `KL-D3-account` | 1 | VERDE da P3 | `tests/security/kloss-repeat.sec.ts` |
| `KL-D3-cookie` | 1 | VERDE da P3 | idem |
| `KL-D3-confirm` | 1 | VERDE da P3 | idem |
| `KL-D3-confirm-incomplete` | 1 | VERDE da P3 (scritta RED in P3) | idem |
| `KL-D3-stale-order` | 1 | VERDE da P3 (scritta RED in P3) | idem |
| `KL-D3-older-reuse` | 1 | VERDE da P3 (scritta RED in P3) | idem |
| `KL-E2-login` | 1 | **RED (limite E2: resta rossa dopo P3)** | `tests/red/kloss/identity-change.red.ts` |

Come P2 le ha rese verdi (senza toccarne le asserzioni): il planner puro `lib/owner-intent.ts` è collegato al checkout attraverso `lib/checkout-owner-guard.ts` — prima di creare un ordine (lock additivi `checkout:owner:…`, tutte le sorelle di ogni stato, lista troncata = HOLD, lineage blocca ma non riconsegna, un ordine appena creato trattiene) e prima di **dare una pagina** di un ordine (nuova prenotazione, reinvio di una prenotazione orfana, riconsegna della pagina esistente), comunque l'ordine sia stato trovato. Un HOLD è un'unica risposta (409 `PAYMENT_IN_PROGRESS`) e non scrive nulla; **dopo** il HOLD, fuori da ogni transazione, le pagine non provate di ordini non più pagabili vengono chiuse al provider con prova (meccanismo DR-13 esistente) e la pagina aperta di un ordine ancora pagabile viene solo interrogata. Nessuna pagina di un normale ordine non pagato viene chiusa per fare posto a un nuovo checkout (sarebbe P6).

Come P3 ha reso verdi le sei prove D3 (senza toccarne le asserzioni): dove P2 dice "procedi", il cancello di riacquisto chiede una conferma alle sole richieste che provano l'ordine pagato con il cookie d'accesso o con l'account. La conferma è legata al **contesto** proposto: l'insieme G degli ordini pagati di recente con la loro revisione finanziaria, il carrello canonico, gli importi e, per un ordine che esiste, la sua revisione. Il valore `rc1_…` è uguale solo se il contesto è esattamente lo stesso. Il cancello sta sia prima di creare un ordine (S2) sia prima di dare una pagina (S3), compreso un ordine trovato per chiave o da continuare. Una conferma valida lascia sull'ordine un'accettazione (`metadata.checkout.repeatAcceptance`), che il retry ritrova senza chiedere di nuovo.

## La suite ordinaria nelle tre configurazioni dei flag (bonifica dopo P3)

La suite di sicurezza si esegue in tre configurazioni: `CHECKOUT_OWNER_GUARD` / `CHECKOUT_REPEAT_GUARD` = `off`/`off` (il default), `on`/`off`, `on`/`on`. Fino a P3 (`e1ecb1e`) la seconda aveva 5 fallimenti (1896/1901) e la terza 9 (1892/1901). Erano tutti test preesistenti, nessuno una regressione di R1-1b, DR-13 o D10. La bonifica ha toccato **solo i test**, e i fallimenti sono zero in tutte e tre: **1915/1915** in `off`/`off`, in `on`/`off` e in `on`/`on` (14 test in più: gli scenari sono stati suddivisi, nessuno è stato tolto); unitari 2057/2057; `npm run test:kloss-red` → 1 test, 1 fallito (`KL-E2-login`), con i flag spenti e con entrambi `on`.

**Regola.** Un test la cui risposta dipende da un flag dichiara il valore di cui parla con `withCheckoutFlags` (`tests/security/_checkout-flags.ts`), invece di leggere il flag e scegliere cosa aspettarsi. Un flag non dichiarato resta quello della suite, e allora le asserzioni valgono per ogni valore con cui la suite gira. Prima di rimettere i flag, l'helper attende i job avviati in background (chiusura delle pagine dopo un HOLD, verifica di una pagina trovata pagata).

**I 5 fallimenti di P2** usavano uno stato che un pagamento non lascia: ordine **marcato a mano** pagato o annullato, con la pagina ancora `open` presso il provider e nessuna prova di chiusura. Ognuno è diventato due scenari distinti:
- **A, flusso reale:** il pagamento è verificato da `payment-sync`, a partire dal provider simulato, come fa il webhook; la scadenza di una pagina arriva dal provider, e il server la chiude con `provider_status:expired` e annulla l'ordine.
- **B, stato anomalo, con owner `on`:** HOLD; dopo il HOLD la pagina viene chiusa presso il provider con la prova `closed_by_us:` sulla riga; poi il checkout prosegue.

| Test di prima | Causa | Adesso |
|---|---|---|
| `cart-after-payment` "once the payment is verified… ordered again" | stato B | A: 200, nuovo ordine (repeat `off`, qualunque owner); A con repeat `on`: proposta, nessun ordine, conferma con il `repeatContext` ricevuto, 200, retry con la stessa chiave o con un'altra = stesso ordine e stessa pagina. B con repeat `off`: HOLD nominato, chiusura con prova, 200. B con repeat `on`: HOLD anche con una conferma, chiusura, proposta, conferma, 200 |
| `cart-after-payment` "a payment page that expired…" | stato B (annullato) | A: 200 in tutte e tre le configurazioni; B (owner `on`): HOLD, chiusura con prova, 200 (qualunque repeat: nulla è pagato) |
| `guest-session` "a second request with another key…" (ultima parte) | stato B | A: 200 in tutte e tre (una sola sessione non incontra mai il cancello e la risposta non nomina l'ordine pagato); B (owner `on`): HOLD senza nome, chiusura con prova, 200 |
| `s2s3-step2` "simultaneous requests (registered)…" (ultima parte) | stato B (senza `paidAt`) | la parte concorrente resta com'era; "pagato nel frattempo" passa a quattro test: A con repeat `off`; A con repeat `on` (proposta, conferma, retry); B con repeat `off` (HOLD nominato, chiusura, 200); B con repeat `on` (istante del pagamento sconosciuto = recente, audit D: proposta, conferma) |
| `purchase-key` "J1/J2 (the choice)…" | due pagine vive, raggiungibili dallo stesso browser | owner `off`: le asserzioni di prima, invariate. Owner `on`: HOLD per entrambe le chiavi, nulla creato né legato. La pagina concorrente scade presso il provider e dopo il HOLD il server la chiude con `provider_status:expired`. Allora K1 riceve **il proprio ordine e la stessa pagina** (nessun ordine né pagina nuovi). K2 riceve `ORDER_NOT_PAYABLE` sul **proprio** ordine, chiuso con la sua pagina; mai l'ordine di K1 |

**Le 4 differenze di P3** sono riacquisti voluti, dopo un pagamento verificato, entro 60 minuti e con prova forte. Il test con repeat `off` conserva le asserzioni di prima; la variante con owner e repeat `on` percorre proposta → conferma con il `repeatContext` ricevuto → 200 → retry idempotente.

| Test di prima | Adesso |
|---|---|
| `cart-after-payment` "4.5 confirming + Stripe says paid…" | variante `on`/`on`: `PAYMENT_IN_PROGRESS` anche a una richiesta con conferma, poi proposta, conferma, 200 |
| `kloss-guard-arbiter` `[P2-no-repeat-gate]` | repeat fissato a `off`: è l'enunciato di P2. In `kloss-repeat-interop` `[P3-after-a-paid-one]`: account e ospite con il cookie → proposta, nulla creato, conferma, 200, una pagina pagabile, retry = stesso ordine e pagina; sola sessione → 200 senza alcuna parola sull'ordine pagato |
| `payment-hold` "accepted…" | variante `on`/`on`: proposta; poi l'ordine va in revisione e una conferma **valida** non supera il HOLD; la decisione dell'amministratore alza la revisione finanziaria, quindi il vecchio valore non conferma più e arriva una nuova proposta; conferma, 200, retry |
| `s2s3-step4` "the answer never contains personal data…" | variante `on`/`on`: la proposta non contiene dati personali, identificativi Stripe né importi; conferma, 200; il pagamento con l'importo sbagliato appare come "attention" senza dettagli |

Il codice di produzione non è cambiato. Mutazioni mirate dei nuovi test: 6/6 uccise. Le mutazioni: l'helper che non fissa i flag; nessuna attesa dei job in background; nessun recupero dopo un HOLD; cancello di riacquisto mai applicato; accettazione mai valida; HOLD solo per ordini non pagati. Ognuna è stata applicata a un file alla volta e poi ripristinata. Con i flag non fissati, in `on`/`on` tornano esattamente i 9 fallimenti di prima, nelle loro nuove forme.

## Le prove di P0: atteso, effettivo prima di P2, causa

Il "motivo" è sempre una discrepanza **dopo** che le premesse dello scenario sono state verificate dal test stesso (pagina viva, pagamento verificato, totale diverso, …): nessun RED fallisce per un errore di preparazione.

| Id | Scenario | Atteso (PLAN REV3) | Effettivo prima di P2 (e ancora oggi con flag `off`; per D3 anche con `on`) | Causa nel codice |
|---|---|---|---|---|
| `KL-D1-price` | stesso proprietario e carrello, totale cambiato (margine 20→40), pagina precedente pagabile | 409; 1 ordine; 1 pagina pagabile; 1 sessione al provider | **200; 2 ordini; 2 pagine pagabili; 2 sessioni** | il confronto di "stesso acquisto" include il totale (`checkoutFingerprint` v2, `lib/checkout-orders.ts:89-107,496-511`); nessun controllo guarda le pagine degli *altri* ordini |
| `KL-D1-uncertain` ×2 | pagina precedente incerta: (a) prenotazione senza id con la pagina viva al provider; (b) riga chiusa con id e senza prova (`payment_failed`) con la pagina ancora aperta | 409; 1 ordine; 1 pagina; 1 sessione | **200; 2; 2; 2** (entrambe) | un tentativo "non provatamente chiuso" è già "possibilmente pagabile" per DR-13 (`closedWithoutProof`/`closedWithIdUnproven`) ma solo il pianificatore dello *stesso* ordine lo guarda |
| `KL-D1-stale` | scheda obsoleta con la chiave dell'ordine 1 (pagina chiusa con prova) mentre l'ordine 2 (totale nuovo) ha una pagina viva | 409; 1 pagina pagabile | **200; 2 pagine pagabili** | una richiesta che trova il proprio ordine per chiave salta ogni controllo sugli altri ordini; DR-13 riapre una pagina per l'ordine 1 accanto a quella dell'ordine 2 |
| `KL-D1-concurrent` | due richieste con chiavi e totali diversi, la prima tenuta dentro il lock (`afterLock`) | la seconda attende; stati [200, 409]; 1 ordine; 1 pagina | **la seconda non attende; [200, 200]; 2 ordini; 2 pagine** | i lock sono nominati con l'impronta *con* totale (`checkout-orders.ts:481-486`): totali diversi ⇒ nessun lock in comune |
| `KL-HOLD-uniform` | sola sessione; tre cause di blocco: in dubbio, pagina viva a totale diverso, pagina nascosta di ordine annullato | tre risposte identiche (409 `PAYMENT_IN_PROGRESS`, stessa forma) | **409, 200, 200** | solo "in dubbio" è un blocco oggi |
| `KL-A-legacy` ×3 | ordine annullato dal codice vecchio con pagina ancora aperta (motivo riga: nessuno; `session_mismatch:`; `stale_reservation`), nuovo acquisto dello stesso proprietario/carrello | ≤ 1 pagina pagabile; una 2ª sessione solo dopo chiusura **al provider** della vecchia | **2 pagine pagabili; 2 sessioni; nessuna chiusura** (tutte e tre) | un ordine annullato non è "pagabile": nessun controllo guarda le sue pagine; la prenotazione nuova si scrive accanto a una pagina mai provata chiusa |
| `KL-A-unreachable` | come sopra con provider non interrogabile (`expire` e `retrieve` irraggiungibili) | fail-closed: 409; 1 sessione; 1 ordine; righe identiche | **200; 2 sessioni; 2 ordini; righe cambiate** | la chiusura della pagina nascosta di un ordine terminale non viene mai tentata prima di prenotare |
| `KL-B-paid-hidden` | ordine pagato (portatore verificato) con una seconda pagina aperta non chiusa da nessuno; nuovo acquisto | ≤ 1 pagina pagabile (nascosta chiusa con prova prima di aprirne un'altra, o nulla aperto) | **2 pagine pagabili; 3 sessioni; nascosta non chiusa** | "ordine pagato" è preso per "pagine chiuse": una pagina si chiude solo quando qualcosa tocca di nuovo *quell'*ordine |
| `KL-D2-window` | ordine di 61 min con pagina rinnovata nell'ultimo minuto (viva fino a ~63,5 min), chiave persa | stesso ordine, stessa pagina; 1 ordine; 1 pagina | **200 ma 2° ordine (`sameOrder=false`); 2 ordini; 2 pagine** | finestra di riconoscimento = 1 h dalla creazione dell'*ordine* (`DUPLICATE_ORDER_WINDOW_MS`, `:257,464,503`), non dalla vita della sua pagina |
| `KL-D3-account` | account; acquisto pagato (verificato) pochi minuti prima; chiave nuova, stesso carrello | 409 `PURCHASE_REPEAT_CONFIRMATION_REQUIRED`; 1 ordine; 1 sessione | **200; nessun codice; 2 ordini; 2 sessioni** | "un ordine pagato non assorbe il successivo" (`cart-after-payment.sec.ts:144`, `guest-session.sec.ts:491`): voluto e involontario indistinguibili |
| `KL-D3-cookie` | ospite con il cookie d'accesso dell'ordine pagato (prova forte) | come l'account, con l'ordine nominato | **200; 2 ordini; 2 sessioni** | idem |
| `KL-D3-confirm` | `confirmRepeat:true` dopo un pagamento verificato (da P3: la stessa richiesta riceve prima la proposta, poi rimanda il suo `repeatContext`) | 200; il nuovo ordine ricorda `repeatOf = [ordine pagato]` | **400 `INVALID_REQUEST`** (la prima richiesta crea già un ordine) | il corpo di `POST /api/checkout/session` è `.strict()` e non conosce il campo (`route.ts:56-63`); nessuna proposta nomina un contesto |
| `KL-D-cookie` | H1 crea l'ordine con pagina aperta; H2 (altra sessione) con il cookie verificato di H1; totale diverso | 409 `PAYMENT_IN_PROGRESS` con l'ordine di H1 nominato; 1 ordine; 1 pagina | **200; nessun codice; 2 ordini; 2 pagine** | la ricerca cerca per sessione corrente e id del cookie *con* l'impronta che include il totale: l'ordine di H1 non si trova |
| `KL-E1-concurrent` | H1 e H2 (entrambe con il cookie dell'ordine precedente, terminale e pulito), chiavi diverse, la prima tenuta nel lock | la seconda attende; [200, 409]; 2 ordini totali; 1 pagina | **la seconda attende (premessa: lock per-carrello legacy condiviso); [200, 200]; 3 ordini; 2 pagine** | il lock c'è, ma la seconda, quando gira, cerca gli ordini di H2 e degli id del cookie, non quelli di H1 che il cookie prova essere dello stesso browser |
| `KL-LOCK-owner` | lock `checkout:owner:h:{hash}:{cartFingerprint}` tenuto da fuori | la richiesta attende, poi 200 | **non attende (poi 200)** | quel nome non esiste: oggi si prendono solo `checkout:guest-session:…`, `checkout:guest:…`, `checkout:purchase-key:…` |

## Prove aggiunte in P3 (PLAN REV2), scritte RED prima della correzione

Misurate sul HEAD `b1d2698…` con i flag spenti **e** con `CHECKOUT_OWNER_GUARD=on`: stessi valori effettivi nelle due modalità; ogni prova fallisce sull'asserzione principale (messaggio `CAUSE:`), dopo che le sue premesse sono state verificate.

| Id | Scenario | Atteso (P3) | Effettivo prima di P3 | Causa nel codice |
|---|---|---|---|---|
| `KL-D3-confirm-incomplete` | account, pagato da poco; (a) `confirmRepeat:true` senza contesto; (b) con un valore ben formato che non è il contesto | 409 `PURCHASE_REPEAT_CONFIRMATION_REQUIRED` in entrambi i casi; 1 ordine; 1 sessione | **400 `INVALID_REQUEST`, 400 `INVALID_REQUEST`**; 1 ordine; 1 sessione | lo schema `.strict()` non conosce i campi: una conferma che non nomina nulla non è distinta da una che nomina il contesto |
| `KL-D3-stale-order` | account; ordine A (pagina chiusa con prova), poi ordine B a un altro totale, pagato; la scheda di A chiede la sua pagina con la sua chiave | 409 di conferma; 0 pagine pagabili; 0 sessioni nuove | **200; 1 pagina pagabile; 1 sessione nuova** | un ordine trovato per chiave va dritto alla sua pagina (`route.ts:162-173`): nessuno guarda il pagamento dello stesso carrello fatto da un ALTRO ordine |
| `KL-D3-older-reuse` | ospite con il cookie che apre A e B; A non pagato (pagina chiusa con prova), B pagato; chiave nuova al totale di A | 409 di conferma; 0 pagine; 0 sessioni nuove; nessun legame della chiave nuova | **200; 1 pagina; 1 sessione nuova; chiave nuova legata ad A** | l'ordine da continuare è scelto prima di guardare gli ordini pagati (ricerca duplicati / `reuse` del planner) |
| `KL-E2-login` | stesso browser: prima ospite con pagina pagabile, poi dall'account | al più 1 pagina pagabile | **2 pagine pagabili** (anche con `on`) | la richiesta di un account prova solo l'account (`route.ts:92`, `:134`): l'ordine fatto poco prima da ospite è fuori ambito. **Resta rossa dopo P3** (chiuderla richiede P2b) |

## Controlli (verdi prima e dopo P2, con flag `off` e con flag `on`; nessun RED preteso)

| Id | Cosa protegge |
|---|---|
| `KL-C-paid` | ordine pagato (unico portatore): nuovo acquisto consentito, **zero** letture/chiusure al provider sulla vecchia pagina, 1 sola pagina pagabile |
| `KL-C-cancelled` | ordine annullato con pagina chiusa **al provider** e prova sulla riga: nuovo acquisto consentito, zero operazioni sulla vecchia pagina |
| `KL-D2-ctrl` | ordine oltre la finestra e senza nulla di vivo: è un nuovo acquisto |
| `KL-D3-ctrl-session` | con la sola sessione, dopo un pagamento, la risposta è **identica** a quella di un primo acquisto (stesso stato, codice, forma) e non nomina l'ordine: nessun cancello, nessuna divulgazione |
| `KL-D3-ctrl-account` | un altro cliente non è mai trattenuto; un account a distanza di un giorno non deve confermare nulla |
| `KL-F-independent` ×4 | un altro ospite indipendente con pagina viva / pagato / in revisione / annullato-nascosto per lo stesso carrello: questo ospite non è trattenuto, non è gated, non sa nulla; l'ordine dell'altro non è toccato |
| `KL-G-invalid-cookies` | cookie assente, falsificato, con token di un altro ordine, spazzatura, scaduto: risposta identica a "nessun cookie", nessun id nominato, nessun legame scritto |
| `KL-E2-limit` | **limite non risolto**, vedi sotto |
| `KL-LK-legacy-locks` | i lock per sessione e per chiave di oggi continuano a essere presi (il PLAN aggiunge nomi, non ne rinomina nessuno) |

Restano verdi e **non sono stati duplicati** i controlli già esistenti: chiave persa con sessione e stesso totale (`guest-session.sec.ts:491`), A→B→A, account multi-scheda e pagamento in dubbio senza limite di tempo (`cart-after-payment.sec.ts`), "conosce ma non nomina" con la sola sessione (`:362`), R1-1b completo (`purchase-key.sec.ts`, multiprocess H/I/J), residuo R1 (`guest-session*.sec.ts`), DR-13 (`dr13-*`), D10 (`dr13-reconcile`).

## E2: limite non risolto (non dichiarato verde; P2 non lo chiude)

Stesso browser dopo un cambio di sessione: la richiesta che portava **più prove** (`{H2, H1}`, sessione nuova più cookie dell'ordine di H1) crea l'ordine con hash H2; una richiesta successiva che porta **meno prove** (`{H1}`) non può provare quell'ordine e crea il suo. Risultato oggi: 2 pagine pagabili, 3 ordini. Il test `KL-E2-limit` lo **fotografa come limite** (stile "RESIDUO R1"): passa perché il limite esiste, e fallisce solo se qualcuno lo chiude *di proposito* — nel qual caso va aggiornato insieme al PLAN. P2 senza P2b **non lo chiude**: la prova (`H1`) sta solo nella prima richiesta e non è persistita; chiuderlo richiede persistere il legame alla creazione (migrazione additiva P2b, **non autorizzata**).

## Misure EXPLAIN (database temporaneo, righe sintetiche, `tests/red/kloss/explain.sh`)

Dati: 20% degli ordini di account (4 ciascuno), 80% di ospiti (~1,5 per sessione), 4000 carrelli distinti, 2 tentativi per ordine. Migliore di 3 esecuzioni, `EXPLAIN (ANALYZE, BUFFERS)`.

| Query | 100.000 ordini (127 MB) | 500.000 ordini (633 MB) | Piano |
|---|---|---|---|
| Ambito ospite: `guestSessionHash IN (H1,H2) OR id IN (…)` + stesso carrello, **tutti gli stati**, con tentativi | 0,24 ms | 0,22 ms | Bitmap su `PrintOrder_guestSessionHash_idx` + chiave primaria |
| `verifiedGuestOrderIds` (5 id) | 0,07 ms | 0,06 ms | indice su chiave primaria |
| Ambito **account**: `userId = X` + stesso carrello, tutti gli stati | **12,8 ms** | **36,9 ms** | **Parallel Seq Scan** su `PrintOrder`: **non esiste un indice su `userId`** |
| Tentativi degli ordini terminali (ids già noti, 20) | 0,12 ms | 0,11 ms | indice `PaymentAttempt_orderId_idx` |
| Tentativi degli ordini terminali (con la sotto-selezione per `userId`, 20) | 16,9 ms | 30,6 ms | dominata dalla scansione di `userId` |
| *Oggi*: ricerca duplicato account (`createPendingCardOrder`) | 4,3 ms | 20,9 ms | bitmap su `paymentStatus` |
| *Oggi*: ricerca duplicato ospite | 0,13 ms | 0,19 ms | indice `guestSessionHash` |
| *Oggi*: `findPurchaseInFlight` per account | **366 ms** | **462 ms** | scansione con sotto-piano correlato |

Lettura: le query previste dal PLAN restano **sotto la soglia di 50 ms** fissata come condizione di STOP (a 500.000 ordini l'ambito account costa ~37 ms; l'andamento è lineare, quindi si stima ~75 ms a 1 milione: stima, non misura): **nessun indice e nessuna migrazione sono necessari per P1/P2**. Due reperti, **preesistenti** e non causati da questo lavoro: (1) `PrintOrder` non ha un indice su `userId` (tutte le ricerche per account sono scansioni sequenziali, già oggi); (2) `findPurchaseInFlight` per gli account costa ~370-460 ms a 100-500k ordini a ogni checkout in cui la chiave non trova l'ordine. Sono rischi di prestazione, non di correttezza; un indice su `userId` sarebbe una migrazione additiva da decidere a parte.

## Premesse e limiti della P0

* I RED usano righe scritte "come il codice vecchio" (`cancelLikeTheOldCode`, `addLegacyTwin`) per i casi legacy: è la pratica già usata da DR-13, dichiarata nei commenti.
* Il simulatore giudica l'invariante "una pagina pagabile per **ordine**"; l'invariante tra ordini diversi (I-X) è misurata dal kit (`payableAcrossOrders`).
* `KL-LOCK-owner` fissa il nome del lock del PLAN (`checkout:owner:h:{hash}:{cartFingerprint}`): P2 ha adottato esattamente quel nome.
* Nessuna prova di crash nuova: i punti di morte con chiave persa sono coperti dalle suite DR-13 esistenti; non è emerso alcun difetto ulteriore non previsto.
