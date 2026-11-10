# R1-3 / KLOSS — Registro delle prove P0 (RED, controlli, limite E2, misure)

Stato: **P0 del PLAN REV3** eseguita sul HEAD `bf256f035aea609d9cb5616d21ebf8dec8f2d58e`. Nessun codice di produzione è cambiato: il checkout opera come prima. PostgreSQL isolato, Stripe **simulato** (`tests/security/_stripe-sim.ts`), nessuna chiamata a Stripe reale né in Test Mode.

Le prove sotto descrivono difetti **non ancora corretti**: restano ROSSE di proposito e **non** fanno parte delle suite ordinarie (`npm test`, `npm run test:security`). Non si cancellano e non si indeboliscono: la guardia `tests/kloss-red-separation.test.ts` (in `npm test`) fallisce se una sparisce, cambia id o finisce in una suite ordinaria. Quando P2 corregge un difetto, il suo test passa nella suite ordinaria **insieme** alla chiusura della riga qui sotto.

## Come si eseguono

| Cosa | Comando (stesso database isolato di `test:security`) | Atteso oggi |
|---|---|---|
| RED | `SEC_TEST_DATABASE_URL=postgresql://…/<db isolato> npm run test:kloss-red` | **18 test, 18 falliti** (15 id) |
| Controlli | fanno parte di `npm run test:security` (`tests/security/kloss-controls.sec.ts`) | 12 test, 12 verdi |
| Guardia | `npm test` (`tests/kloss-red-separation.test.ts`) | verde |
| EXPLAIN | `tests/red/kloss/explain.sh <ordini>` (database temporaneo, eliminato a fine corsa) | numeri sotto |

Verifica di riproducibilità: i RED sono stati eseguiti **due volte** di seguito con valori effettivi identici (stesso diff atteso/effettivo in tutte le righe).

## RED: atteso, effettivo, causa

Il "motivo" è sempre una discrepanza **dopo** che le premesse dello scenario sono state verificate dal test stesso (pagina viva, pagamento verificato, totale diverso, …): nessun RED fallisce per un errore di preparazione.

| Id | Scenario | Atteso (PLAN REV3) | Effettivo oggi | Causa nel codice |
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
| `KL-D3-confirm` | `confirmRepeat:true` dopo un pagamento verificato | 200; il nuovo ordine ricorda `repeatOf = [ordine pagato]` | **400 `INVALID_REQUEST`** | il corpo di `POST /api/checkout/session` è `.strict()` e non conosce il campo (`route.ts:55-62`) |
| `KL-D-cookie` | H1 crea l'ordine con pagina aperta; H2 (altra sessione) con il cookie verificato di H1; totale diverso | 409 `PAYMENT_IN_PROGRESS` con l'ordine di H1 nominato; 1 ordine; 1 pagina | **200; nessun codice; 2 ordini; 2 pagine** | la ricerca cerca per sessione corrente e id del cookie *con* l'impronta che include il totale: l'ordine di H1 non si trova |
| `KL-E1-concurrent` | H1 e H2 (entrambe con il cookie dell'ordine precedente, terminale e pulito), chiavi diverse, la prima tenuta nel lock | la seconda attende; [200, 409]; 2 ordini totali; 1 pagina | **la seconda attende (premessa: lock per-carrello legacy condiviso); [200, 200]; 3 ordini; 2 pagine** | il lock c'è, ma la seconda, quando gira, cerca gli ordini di H2 e degli id del cookie, non quelli di H1 che il cookie prova essere dello stesso browser |
| `KL-LOCK-owner` | lock `checkout:owner:h:{hash}:{cartFingerprint}` tenuto da fuori | la richiesta attende, poi 200 | **non attende (poi 200)** | quel nome non esiste: oggi si prendono solo `checkout:guest-session:…`, `checkout:guest:…`, `checkout:purchase-key:…` |

## Controlli (verdi oggi e dopo ogni fase; nessun RED preteso)

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

## E2: limite non risolto (non dichiarato verde)

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
* `KL-LOCK-owner` fissa il nome del lock del PLAN (`checkout:owner:h:{hash}:{cartFingerprint}`): se P2 sceglie un altro nome si aggiorna questo test e la riga.
* Nessuna prova di crash nuova: i punti di morte con chiave persa sono coperti dalle suite DR-13 esistenti; non è emerso alcun difetto ulteriore non previsto.
