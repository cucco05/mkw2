# Runbook — le pagine di pagamento Stripe di un ordine (DR-13)

Per chi gestisce gli ordini e per chi è di turno quando un cliente dice «la pagina di pagamento non si apre» o quando un allarme segnala una pagina «da controllare». Spiega che cosa fa il sistema da solo, che cosa significano i messaggi, quali strumenti esistono e **che cosa non si fa mai**.

**Stato:** DR-13 è implementata e provata **solo in locale** (PostgreSQL isolato, Stripe simulato). Non è stata pubblicata né provata su Stripe reale o in modalità test, e il recupero **autonomo** dopo un crash non esiste ancora (§7). Questo documento descrive il comportamento del codice nel branch `claude/dr13-single-page`; vale in produzione solo dopo audit, prove del titolare e rilascio (`docs/RILASCIO-PRODUZIONE.md` §19, `docs/CHECKLIST-PRELANCIO.md` righe 1.73–1.77).

## 0. Le regole che non si discutono

1. **Una sola pagina pagabile per ordine.** Una pagina si sostituisce solo quando il provider ha **dimostrato** che quella vecchia è chiusa (`expire` risposto `expired`, o la sessione che si rilegge `expired`). Il tempo che passa, l'età di una riga, l'assenza di un webhook, l'assenza di una pagina da un elenco **non sono prove**.
2. **Una riserva (`creating`) non si chiude mai con l'orologio.** Si risolve rimandando la *sua* richiesta, solo dove è dimostrabilmente sicuro; altrimenti resta com'è e il cliente vede «ancora in controllo» (503).
3. **Nessun SQL a mano su `PaymentAttempt` o `PrintOrder`.** Nessun `UPDATE`, `DELETE`, «pulizia», «riapertura» o «sblocco» di una riga. Una riga è il registro: se è sbagliata, la corregge l'applicazione, con la prova del provider (§5).
4. **Il Dashboard di Stripe è un ausilio per cercare, non una prova di assenza.** Serve a trovare l'identificativo di una pagina che esiste. «Non la vedo nel Dashboard» non libera nulla.
5. **Nessun rimborso automatico.** Un doppio incasso viene rilevato e messo in attesa di una persona; il rimborso è una decisione umana, fatta in Stripe (il rimborso dall'app non è pronto: riga 1.62 della checklist).
6. **Fail-closed.** Ogni dubbio (provider irraggiungibile, risposta illeggibile, dati incoerenti) lascia l'ordine **esattamente com'è** e lo dice. Non si «forza» nulla.
7. **Mai Stripe reale o in modalità test per provare queste procedure** senza l'autorizzazione scritta del titolare.

## 1. Come funziona (in breve)

* Per ogni ordine esiste al più **un tentativo vivo** (`creating` = riserva, `open` = pagina consegnabile). Lo garantiscono il pianificatore (`lib/checkout-session-plan.ts`, puro e provato su ogni combinazione) e, come rete di sicurezza fisica, l'indice univoco parziale `PaymentAttempt_orderId_live_page_key` (`docs/DR13-MIGRAZIONI.md`).
* Il cliente preme «Paga»: se c'è una pagina valida con almeno 60 s di vita viene riconsegnata (dopo averla riletta da Stripe); se sta per scadere, viene **chiusa presso Stripe con prova** e poi sostituita nello stesso commit del database; se c'è una riserva, si risolve (replay con la stessa chiave di idempotenza) o resta bloccata.
* Una pagina **pagata** (`complete`) diventa `processing`, mai `expired` o `failed`; è il percorso verificato dei pagamenti (`lib/payment-sync.ts`) a registrare l'incasso. Quando una pagina è pagata, le **gemelle** dello stesso ordine vengono chiuse con prova; se una gemella risulta pagata è un `duplicate_payment`.
* Tutto quello che la richiesta del cliente non fa da sé viene **ripreso al prossimo segno di vita** dell'ordine (§7): non esiste un processo che giri da solo.

## 2. Che cosa vede il cliente, che cosa significa, che cosa si fa

| Risposta | Messaggio al cliente | Significato | Che cosa fare |
|---|---|---|---|
| `503 RESERVATION_UNRESOLVED` (`retry: true`) | «Una pagina di pagamento per questo ordine è ancora in controllo. Attendi qualche minuto e riprova; non avviare un altro pagamento.» | C'è una pagina (o una riserva) di cui non si può provare lo stato: esito di Stripe ambiguo, richiesta non rimandabile con sicurezza, riga storica senza identificativo… **Nulla è stato aperto né chiuso.** | §4.1. Di norma si risolve da sola al tentativo successivo (rete, 429, 5xx). Se resta, interviene una persona. **Non** dire al cliente di pagare di nuovo né di rifare l'ordine. |
| `503 PAYMENT_PAGE_CLOSE_UNCONFIRMED` (`retry: true`) | «La pagina di pagamento di questo ordine si sta rinnovando. Riprova tra poco.» | La pagina vecchia non è stata dimostrata chiusa (Stripe non ha risposto): nessuna nuova pagina è stata aperta. | §4.2. Riprovare. Se persiste, controllare Stripe e §4.3. |
| `502 PAYMENT_PROVIDER_UNAVAILABLE` (`retry: true`) | «Il provider di pagamento non è raggiungibile in questo momento. Riprova.» | Stripe non risponde. Ordine e riserva restano. | Controllare lo stato di Stripe; il cliente riprova. |
| `503 TEMPORARY_ERROR` (`retry: true`) | «Qualcosa è andato storto nel salvare il pagamento. Riprova.» / «Il pagamento non ha potuto essere preparato. Riprova.» | Il database non ha potuto registrare la risposta di Stripe (la transazione è tornata indietro) o il budget della richiesta è finito. | Il tentativo successivo ottiene la stessa pagina. Se ripetuto, guardare i log. |
| `500 PAYMENT_PROVIDER_ERROR` | «Il pagamento non ha potuto essere avviato.» | Stripe ha restituito una pagina che non corrisponde all'ordine (importo, valuta, riferimenti). La pagina è stata chiusa e **non** consegnata. | Guardare `checkout_session_mismatch_total` e il log (`outcome: session_mismatch`, campo `problem`). Non è un problema del cliente. |
| `blocked` (pagina di stato) «pagamento in verifica» / «in revisione» | testo della pagina di stato | L'ordine ha un pagamento in corso (`processing`), un pagamento non corrispondente (`paymentReviewReason`) o un tentativo `mismatch`. Nessuna pagina nuova. | §4.5–§4.6. |

**ATTENZIONE — verificato sul codice, NON risolto:** la colonna «Messaggio al cliente» è il testo che il **server** manda (`lib/checkout-sessions.ts`: `unresolvedError`, `closeUnconfirmed`, `providerUnavailable`). Il **client** però non lo mostra: `classifyFailure` (`lib/checkout-client.ts`) non ha una voce per `RESERVATION_UNRESOLVED` e `PAYMENT_PAGE_CLOSE_UNCONFIRMED`, li tratta come errore generico `temporary` (status ≥ 500) e `failureMessage` (`lib/checkout-copy.ts`) mostra per tutti: «Il servizio di pagamento non risponde in questo momento. **Non è stato addebitato nulla**: riprova tra qualche istante.» Provato con una sonda su `classifyFailure`/`failureMessage` (nessuna prova automatica lo fissa). In uno stato incerto — una pagina di pagamento che potrebbe esistere — «non è stato addebitato nulla» non è una frase che il sistema possa dimostrare, e contraddice il messaggio prudente del server («non avviare un altro pagamento»). **Correzione proposta, non implementata** (è codice del client di S-11/R1-2, fuori dal mandato di questa fase): due voci in `KIND_BY_CODE` verso un tipo dedicato («pagina in controllo»), con un testo che non nega addebiti e dice di non avviare un altro pagamento, e una prova in `tests/checkout-copy-claims.test.ts`. Finché non c'è, chi risponde a un cliente in questi stati **non ripete** quella frase e usa il testo di questa tabella; la riga 1.76(e) della checklist verifica la resa su dispositivi veri.

## 3. Gli strumenti

| Strumento | A che cosa serve | Scrive? |
|---|---|---|
| `scripts/checkout-pages-check.sql` | Rapporto in sola lettura (Q1–Q6): ordini con più pagine vive, riserve, pagine aperte oltre la scadenza, ordini pagati due volte, righe chiuse senza prova, pagine da chiudere su ordini non pagabili. Gira anche sullo schema precedente. | **No** (eseguirlo in sessione `default_transaction_read_only = on`) |
| Metriche | `checkout_reservation_unresolved_total{why}`, `checkout_page_close_unconfirmed_total`, `checkout_page_retired_total{reason}`, `checkout_reservation_replayed_total{mode}`, `checkout_reservation_replay_throttled_total`, `checkout_reservation_param_drift_total`, `checkout_session_mismatch_total{problem}`, `checkout_session_open_on_closed_row_total`, `checkout_complete_on_closed_attempt_total`, `checkout_session_discarded_total{outcome}`, `checkout_sibling_closed_total{outcome}`, `checkout_session_race_total`, `checkout_session_save_failures_total`, `checkout_reconcile_total{outcome,code,mode}` | — |
| Log | `checkout.session` (orchestratore), `checkout.pages` (chiusura delle gemelle), `checkout.reconcile` (strumento D10); sempre con `orderId`/`attemptId`/`sessionId` quando noti | — |
| `scripts/checkout-reconcile.ts` (D10) | Riconcilia **un** tentativo con la sessione che **il provider nomina** (§5). Prova a secco di serie. | Solo con `--apply`, con audit |
| Decisione sul pagamento trattenuto | `POST /api/admin/orders/<id>/payment-hold` (`no_charge` / `accepted`), solo amministratore | Sì, con audit (§4.7) |
| `stripe-sync` (admin) | Rilegge da Stripe una sessione/pagamento e lo tratta con il percorso verificato | Sì (percorso verificato) |

**Allarmi suggeriti** (da configurare in fase di rilascio, non esistono ancora regole): qualunque incremento di `checkout_reservation_unresolved_total{why!="replay_throttled"}` mantenuto per più di 10 minuti; `checkout_page_close_unconfirmed_total` > 0 per più di 10 minuti; qualunque `checkout_session_mismatch_total`; qualunque riga in Q1 (deve essere vuota dopo la migrazione) o in Q6 più vecchia di 15 minuti; `checkout_session_identifier_not_recorded_total` > 0.

## 4. Procedure

### 4.1 Una riserva non si risolve (503 `RESERVATION_UNRESOLVED`)

1. **Non toccare il database.** Identificare l'ordine (log con `orderId`/`attemptId`; il cliente dà il numero ordine).
2. Eseguire il rapporto (sola lettura) e guardare **Q2** (la riserva, la sua età, se ha identificativo e richiesta salvata) e **Q5/Q6** (righe chiuse senza prova, pagine da chiudere dello stesso ordine).
3. Capire il perché dal log/metrica `checkout_reservation_unresolved_total{why}`:

| `why` | Significa | Si risolve? |
|---|---|---|
| `ambiguous_answer` | `create` ha dato un errore che non prova né l'esistenza né l'assenza di una sessione (rete, timeout, 409, 429, 5xx, ogni 4xx) | di norma da sola al tentativo successivo (stessa chiave) |
| `replay_throttled` | un replay «solo per imparare» è già partito da meno di 30 s per quell'ordine | da sola, dopo la finestra |
| `no_replay` | la riserva ha ≥ 23 h (la chiave potrebbe essere stata dimenticata) o la sua età non è leggibile | **no**: solo con prova positiva (§5) |
| `param_drift` | la richiesta come verrebbe costruita ora non è quella salvata (configurazione, ordine modificato, riga storica senza impronta) | **no**: solo con prova positiva (§5) |
| `session_state_unreadable`, `session_differs_from_registered`, `session_id_taken`, `request_cannot_be_rebuilt`, `replayed_once`, `replay_pace_unavailable`, `retire_without_identifier` | incoerenze o impossibilità di leggere lo stato | dipende: log e §5; se i dati sono incoerenti, **non** forzare |
| `uncertain_history`, `open_without_session`, `unknown_attempt_status` | una riga chiusa senza prova e senza identificativo, una pagina «aperta» senza identificativo, uno stato sconosciuto | **no**: solo con prova positiva (§5) |

4. Il cliente può riprovare con la **stessa chiave**; non deve ricominciare. Un nuovo ordine non risolve nulla e può creare un secondo incasso.
5. Se serve una persona: §5 (strumento D10). **Senza una prova positiva la riserva resta bloccata a tempo indeterminato**: è voluto.

### 4.2 La chiusura di una pagina non è confermata (503 `PAYMENT_PAGE_CLOSE_UNCONFIRMED`)

La pagina vecchia non è stata dimostrata chiusa (Stripe non ha risposto a `expire` né a `retrieve`, o ha risposto `open` dopo un `expire` fallito). **Nessuna pagina nuova è stata creata.** Il cliente riprova; ogni tentativo ripete la chiusura (idempotente). Se dura: controllare lo stato di Stripe, cercare nel log `close_unconfirmed` e usare §5 con la sessione per rileggerla e chiuderla.

### 4.3 Righe chiuse senza prova (Q5) e pagine da chiudere (Q6)

* **Q5** elenca ciò che il codice precedente (o una rete di errori) ha chiuso **senza** la parola del provider: `stale_reservation`, `session_mismatch:` (non è una prova: la pagina restava aperta), qualunque riga chiusa con identificativo ma senza `closed_by_us:`/`provider_status:expired` all'inizio del motivo, qualunque riga chiusa senza identificativo e senza `local_refusal:`/`provider_rejected:`. Finché ne esiste una su un ordine che aspetta il pagamento, **nessuna pagina nuova** si apre.
  * *Con identificativo:* al prossimo ritorno del cliente (pagina di stato, «Paga») il sistema chiede a Stripe, chiude la pagina se è aperta e scrive la prova **davanti** al motivo vecchio, che si conserva (`closed_by_us:… (was session_mismatch:…)`). Non serve fare nulla.
  * *Senza identificativo:* una pagina può esistere che il database non conosce. Serve la prova positiva (§5).
* **Q6** elenca le pagine ancora da chiudere su ordini che non si possono più pagare (pagati, in conferma, annullati, in revisione). Si riprendono al prossimo segno di vita dell'ordine (evento di pagamento, pagina di conferma). Una riga che resta in Q6 per più di qualche minuto significa che la chiusura non è stata dimostrata: guardare `checkout_sibling_closed_total{outcome=error|unknown}` e rilanciare §5.

### 4.4 Pagamento doppio, orfano, in revisione

* **Doppio pagamento** (`paymentReviewReason = duplicate_payment`, ordine in `attention`): la rilevazione è immediata (le gemelle si chiudono appena una è pagata; se una gemella risulta pagata viene registrata subito). Gli effetti (PrintLab, notifiche, inventario, ricevuta) partono **una sola volta**. **Nessun rimborso automatico.** Procedura: verificare nel Dashboard i due pagamenti → rimborsare il duplicato **in Stripe** (il rimborso dall'app non è pronto: riga 1.62) → registrare la decisione `accepted` con il motivo (§4.7). Elenco: Q4.
* **Pagamento su una pagina che il database non conosce** (la risposta di `create` si è persa e il cliente ha pagato): il webhook (`checkout.session.completed`) porta `metadata.attemptId`; il percorso verificato lo abbina al tentativo se i dati coincidono; se non coincidono diventa revisione (`order_reference`, `session_reference`…). Un pagamento che **nessun ordine rivendica** viene registrato con `orderId = null` ed è elencabile con `findUnmatchedPaymentEvents` (**nessuno script lo mostra ancora**: residuo del Passo 5; oggi si trova dal Dashboard di Stripe e dai log). Non si «assegna» a mano.
* **Pagamento non corrispondente / in revisione** (`paymentReviewReason`: `amount`, `currency`, `order_reference`, `session_reference`, `mode`, `payment_intent_missing`, `unpaid_completion`, `payment_already_used`, `duplicate_payment`, `paid_after_cancel`, `status_regression`, `dispute`, `shipping_country`, `shipping_address_missing`, `external_order`: elenco completo in `lib/payment-verification.ts`): nessuna pagina nuova finché una persona decide (§4.7).
* **Soldi arrivati e ordine annullato** (`paid_after_cancel`): è denaro: si accetta o si rimborsa, non si rilascia come «nessun addebito».

### 4.5 Pagamento in corso (`processing`)

Una pagina `complete` presso Stripe diventa `processing` e il percorso verificato la tratta. Finché è in corso nessuna pagina nuova si apre. Di norma si risolve da solo (webhook, pagina di stato, `stripe-sync`). Se resta fermo: `stripe-sync` sull'ordine; poi §4.7.

### 4.6 Un tentativo `mismatch`

È stato verificato un pagamento che non coincide con l'ordine: l'ordine è in revisione e il pianificatore blocca. Decide una persona (§4.7).

### 4.7 La decisione amministrativa sul pagamento trattenuto (`no_charge` / `accepted`)

`POST /api/admin/orders/<orderId>/payment-hold` con `{ "outcome": "no_charge" | "accepted", "reason": "<da 10 a 300 caratteri>" }`. **Solo amministratore** (non staff), stessa origine, corpo rigoroso (nessun campo in più).

* **`accepted`**: il denaro è verificato e il motivo della sospensione è stato gestito (rimborso del duplicato, indirizzo corretto…). Toglie la sospensione.
* **`no_charge`** («non è stato addebitato nulla»): **non è una dichiarazione**. Il server:
  1. rilegge da Stripe **ogni** pagina/tentativo dell'ordine; rifiuta se Stripe non risponde per tutte, o se un tentativo non ha identificativo (nulla da chiedere → non è prova di «nessun addebito»);
  2. rifiuta se qualunque pagamento è incassato o in arrivo;
  3. **chiude presso Stripe, con prova, ogni pagina ancora pagabile PRIMA di decidere**, fuori da ogni transazione; rifiuta se una non si chiude o si legge, o se è già `complete` (denaro);
  4. rilegge ordine, tentativi e prove sotto il blocco dell'ordine e rifiuta se la base è cambiata; solo allora annulla l'ordine (il cliente può pagare di nuovo) e scrive decisione, motivo e prove (audit + `metadata`).
* Errori e che cosa fare:

| Codice | Significa | Che cosa fare |
|---|---|---|
| `409 STRIPE_UNVERIFIABLE` | Stripe non risponde per tutte le pagine, o un tentativo non ha identificativo, o i tentativi sono cambiati mentre si chiedeva | riprovare quando Stripe risponde; per un tentativo **senza identificativo** trovare la sessione (Dashboard) e usare §5 per registrarla, poi riprovare. Nessun campo «forza» esiste. |
| `409 CHARGE_EXISTS` | un pagamento è incassato o in arrivo | non è «nessun addebito»: `accepted` oppure rimborso |
| `409 PAGES_NOT_CLOSED` | una pagina non si è chiusa/letta, o è `complete` | riprovare; le pagine già chiuse restano chiuse e la richiesta successiva le riconcilia |
| `409 NOT_ON_HOLD` | l'ordine non è (più) trattenuto — spesso la sincronizzazione l'ha sciolto | rileggere lo stato dell'ordine |
| `409 PAYMENT_COLLECTED` | il pagamento è stato incassato nel frattempo | `accepted` o rimborso |
| `400 REASON_REQUIRED` | motivo mancante o troppo corto | scrivere il motivo (≥ 10 caratteri) |

## 5. Riconciliazione con prova positiva (strumento D10)

È l'**unico** modo di sbloccare una riserva o una riga senza identificativo, e funziona solo se **il provider nomina la pagina**.

```bash
# prova a secco (di serie): legge il tentativo e la sessione, dice che cosa farebbe, non scrive nulla e non registra audit
npx tsx scripts/checkout-reconcile.ts --attempt <attemptId> --operator <e-mail o id dell'amministratore> --session cs_...

# applica (registra la richiesta nell'audit PRIMA di agire e il risultato dopo)
npx tsx scripts/checkout-reconcile.ts --attempt <attemptId> --operator <...> --session cs_... --apply

# senza conoscere la sessione: cerca tra le sessioni create attorno alla riserva quelle che nominano il tentativo (solo corrispondenze positive)
npx tsx scripts/checkout-reconcile.ts --attempt <attemptId> --operator <...> --discover
```

* **Prima di ogni uso su dati reali:** autorizzazione scritta del titolare, backup verificato, stessa `DATABASE_URL`/`STRIPE_SECRET_KEY` dell'applicazione. Mai in sessioni di prova contro dati reali.
* **Che cosa verifica** (tutto, nessun controllo è un indizio): l'operatore è un **amministratore** esistente e non sospeso; il tentativo esiste e non è già un pagamento; la sessione ha la forma `cs_…`, viene **riletta ora** dal provider, nomina **questo** tentativo e **questo** ordine (metadati e riferimento cliente), è in modalità pagamento, e nessun altro tentativo la possiede; con `--discover` una sola sessione deve nominare il tentativo (due → rifiutato).
* **Che cosa fa** (stesse regole della richiesta del cliente, sotto il blocco dell'ordine): scrive l'identificativo sul tentativo e lascia decidere al pianificatore: pagina aperta di un ordine ancora pagabile → diventa la pagina dell'ordine; pagata (`complete`) → `processing` e percorso verificato (mai «pagato» da qui); scaduta → prova `provider_status:expired` sulla riga; pagina che non deve restare aperta (ordine annullato, importo non coincidente, gemella) → **chiusa presso Stripe con prova**.
* **Esiti** (JSON su stdout, log su stderr): `planned` (prova a secco, uscita 0) · `applied` (0) · `already_done` (0) · `partial` (3: qualcosa è stato scritto e qualcosa resta: rilanciare; tipico: la chiusura presso Stripe non è stata dimostrata) · `refused` (2: nulla è cambiato; il `code` dice perché) · `no_evidence` (2: `--discover` non ha trovato nulla). Uscita 64: uso errato.
* **`no_evidence` NON libera niente.** Un elenco che non mostra la pagina, anche completo, non prova che non esista (l'elenco può ritardare, essere incompleto, e il suo comportamento reale non è stato verificato). La riserva resta bloccata. Non esiste, e non va aggiunta, un'opzione «rilascia per assenza» (il caso «E-B»): richiede una prova di Stripe in modalità test accettata dal titolare e una decisione scritta.
* È **idempotente**: rilanciarlo non cambia nulla se il tentativo e l'ordine sono già come il provider li mostra (`already_done`); più esecuzioni insieme finiscono nello stesso punto.
* **Non fa mai:** cancellare o modificare a mano una riga, creare una pagina, consegnarne una al cliente, muovere denaro, segnare un ordine pagato, aprire qualcosa «per sbloccare».
* L'audit (`AdminAuditEvent`, catena di hash) registra `checkout.page.reconcile.requested` e `…finished` con operatore, tentativo, ordine, sessione, controlli, azioni, stato prima e dopo e (con `--discover`) finestra, pagine, richieste ed esaminate.
* Quando il codice dice `AUDIT_UNAVAILABLE` non è stato fatto nulla.

## 6. Rilascio con il checkout sospeso

La procedura completa (sospensione, controllo preliminare Q1, avvio dell'immagine che applica le migrazioni, verifiche, riaccensione, rientro) è in `docs/RILASCIO-PRODUZIONE.md` §19. Il punto da ricordare qui: **la riga Q1 va controllata sul database di destinazione PRIMA di avviare l'immagine nuova**, perché l'avvio applica le migrazioni e un'indice che non si può creare blocca l'avvio di qualunque immagine finché la migrazione fallita non è risolta (`docs/DR13-MIGRAZIONI.md` §2).

## 7. Crash e recupero

**Che cosa succede se il processo muore** (provato con crash simulati a ogni passo, `tests/security/dr13-crash.sec.ts`): il database resta coerente (ogni scrittura è condizionale e in una transazione sotto blocco dell'ordine; nessuna transazione è aperta mentre si chiama Stripe); al segno di vita successivo il passo interrotto si ripete in modo idempotente. Una sessione creata da Stripe di cui il database non ha mai saputo l'identificativo **può esistere** (finestra I-5): non è mai stata consegnata a nessuno e nessuna pagina nuova si apre finché non è riconciliata.

**I punti di ripresa che esistono oggi** (tutti richiedono che *qualcuno si faccia vivo* — tranne l'annuncio di Stripe; fissati da `tests/security/dr13-resume-points.sec.ts`):

| Segno di vita | Che cosa riprende |
|---|---|
| Il cliente preme «Paga» / ricarica | replay della riserva, prova delle righe chiuse senza prova, chiusura e sostituzione delle pagine |
| La pagina di stato dell'ordine (limitata da `allowPageClosure`) | chiusura delle pagine vive di un ordine non pagabile |
| Un webhook (`checkout.session.completed` / `expired`) o `stripe-sync` | registrazione del pagamento o della scadenza (con prova), chiusura delle gemelle |
| La decisione amministrativa sul pagamento trattenuto | chiusura con prova delle pagine, poi decisione |
| Il rapporto `checkout-pages-check.sql` + lo strumento D10 | **manuale**, a cura di una persona |

**Che cosa NON esiste: il recupero autonomo.** Se nessuno si fa vivo (il cliente se ne va, nessun webhook arriva), una riserva o una pagina da chiudere resta com'è finché qualcuno non la guarda. È un **bloccante prima del lancio** (checklist riga 1.74). La soluzione proposta (processo periodico idempotente, con protezioni di concorrenza, allarmi e prove) è una **proposta tecnica non implementata** in `docs/PROPOSTA-RECUPERO-AUTONOMO-DR13.md`: richiede un'autorizzazione separata per scheduler/coda/infrastruttura persistente.

## 8. Limiti delle garanzie del simulatore

Tutte le prove di DR-13 girano contro un **modello** di Stripe (`tests/security/_stripe-sim.ts`) e un PostgreSQL locale. Provano il **nostro** codice contro il modello; non provano il provider.

| Che cosa dà il simulatore | Che cosa NON dimostra |
|---|---|
| ordine esatto delle chiamate (`retrieve → expire → create`), nessuna transazione aperta durante una chiamata, un'unica pagina pagabile per ordine in ogni istante, crash a ogni passo, interleaving riproducibili, processi reali con provider condiviso su tabella SQL | che Stripe **reale** si comporti come il modello nei punti che il modello decide da solo |
| una `create` ripetuta con la stessa chiave restituisce la stessa sessione; con `expires_at` ormai troppo vicino il simulatore sa rispondere in **entrambi** i modi (`replayRevalidatesExpiresAt`) e il codice è sicuro con entrambi | quale dei due faccia davvero Stripe (A3) |
| `expire` su una sessione `open` la chiude; su una `complete` rifiuta | (A1 e A2 sono state osservate dal titolare in modalità test, run SP1; il resto no) |
| `sessions.list` per finestra di creazione, paginato, **senza** filtro per metadati | se l'elenco reale mostra **subito** una sessione appena creata (A6), l'ordine delle pagine e i limiti: per questo l'elenco serve **solo** a trovare corrispondenze positive, mai a provare un'assenza |
| `expire` e pagamento concorrenti arbitrati dal database | come Stripe arbitra davvero la corsa (A8), `expire` con 3-D Secure in corso (A9), ritardo fra `expires_at`, `status=expired` e webhook (A7) |
| risposte salvate (5xx, 4xx) per una chiave | quali errori reali **non** creano una sessione: l'elenco «provati» è **vuoto**, ogni errore del provider è ambiguo (fail-closed) |

Quello che resta ipotesi sul provider (A3, A6–A9, 5xx salvati) è gestito **fail-closed**: nel dubbio non si apre, non si chiude e non si rilascia nulla. Va verificato in modalità test dal titolare (protocollo `dr13`, non ancora scritto: checklist riga 1.75) **prima** di abilitare i pagamenti.
