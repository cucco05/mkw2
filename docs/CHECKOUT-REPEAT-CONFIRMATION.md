# Conferma di un riacquisto (R1-3 / KLOSS P3) – contratto API per P4

Ramo `claude/dr13-single-page`. Questo documento descrive **che cosa chiede il server** quando lo stesso carrello viene acquistato di nuovo poco dopo un pagamento verificato, **che cosa deve fare la pagina** (P4, non ancora scritta) e **che cosa la conferma garantisce e che cosa no**.

Codice: `lib/owner-intent.ts` (regole pure), `lib/checkout-owner-guard.ts` (l'unica porta), `lib/checkout-orders.ts` (prima di creare un ordine, S2), `lib/checkout-sessions.ts` (prima di dare una pagina, S3), `app/api/checkout/session/route.ts`.

Test: `tests/security/kloss-repeat*.sec.ts`, `tests/checkout-repeat-guard.test.ts`, `tests/owner-intent.test.ts`; registro `tests/red/kloss/RED-LEDGER.md`.

## 1. Quando si applica

Flag `CHECKOUT_REPEAT_GUARD = off | shadow | on`, **default `off`**. È efficace **solo con `CHECKOUT_OWNER_GUARD=on`**:

| `CHECKOUT_OWNER_GUARD` | `CHECKOUT_REPEAT_GUARD` | Effetto |
|---|---|---|
| `off` | qualsiasi | spento (detto una volta nel log e in un contatore) |
| `shadow` | `off` / `shadow` / `on` | spento / contato / contato |
| `on` | `off` / `shadow` / `on` | spento / contato / **applicato** |

`on` **non è autorizzato fuori dai test locali** e richiede la pagina di P4: il client attuale (`lib/checkout-client.ts`) non conosce il codice `PURCHASE_REPEAT_CONFIRMATION_REQUIRED` e lo tratta come esito sconosciuto.

Con il cancello applicato, la conferma si chiede quando **tutte** queste condizioni sono vere:

- esiste almeno un altro ordine a carta dello **stesso proprietario e dello stesso carrello** (G), con pagamento **verificato**, non annullato, non rimborsato, non in dubbio;
- quel pagamento è stato verificato **meno di 60 minuti fa**. L'istante è `paidAt`; se manca, il `completedAt` della pagina che portava il pagamento dell'ordine. Se non c'è nessuno dei due, l'istante è **sconosciuto** e il pagamento conta come recente. La data di creazione dell'ordine **non conta mai**;
- la richiesta prova quell'ordine pagato con l'**account** o con il **cookie d'accesso** verificato per quell'ordine;
- P2 dice "procedi": un **pagamento in dubbio**, una **pagina di un'altra sorella ancora pagabile** o una **lista incompleta** danno sempre `409 PAYMENT_IN_PROGRESS`, anche con una conferma valida.

**Sola sessione o lineage:** nessun cancello, nessuna parola sull'ordine pagato, i campi della conferma vengono ignorati. La risposta è identica a quella di un primo acquisto.

## 2. Richiesta

`POST /api/checkout/session`: i campi di oggi, più due campi accettati **solo** con il cancello applicato (altrimenti `400 INVALID_REQUEST`, come prima):

| Campo | Valore | Regola |
|---|---|---|
| `confirmRepeat` | `true` | facoltativo |
| `repeatContext` | `rc1_` seguito da 64 cifre esadecimali minuscole | solo insieme a `confirmRepeat: true`; da solo o malformato → 400 |

`confirmRepeat: true` senza `repeatContext`, o con un valore che non è quello del contesto attuale, **non conferma nulla**: la risposta è la proposta.

## 3. Risposte

**Proposta**, `409`:

```json
{ "error": "A payment for this cart was completed a short while ago. Confirm that you want to buy it again.",
  "code": "PURCHASE_REPEAT_CONFIRMATION_REQUIRED",
  "orderId": "<l'ordine pagato più recente di G>", "orderNumber": 123,
  "repeatCount": 2,
  "repeatContext": "rc1_…" }
```

- `orderId` e `orderNumber` riguardano un ordine che la stessa prova può già leggere da `/api/checkout/status`; `repeatCount` è il numero di ordini di G. Nient'altro: niente date, importi, stati, identificativi Stripe.
- `pendingOrder: true`: per questo acquisto **esiste già un ordine non pagato** che aspetta la conferma. Può essere stato creato poco prima dalla stessa richiesta (vedi §5) oppure prima. Il suo id (`pendingOrderId`, `pendingOrderNumber`) è indicato solo se la richiesta lo prova con l'account o con il cookie d'accesso. Senza `pendingOrder`, la richiesta non ha scritto nulla.
- La dimensione della risposta è fissa, qualunque sia il numero di ordini in G.

**Conferma riuscita:** `200`, come oggi (ordine e pagina Stripe). Un ordine nuovo creato da una conferma riporta in `metadata.checkout.repeatOf` gli ordini che ripete.

**Altre risposte, in ordine di precedenza:**

1. rifiuto della chiave (R1-1b, `PURCHASE_KEY_IN_USE`);
2. `PAYMENT_IN_PROGRESS` (pagamento in dubbio, P2);
3. `PRICE_CHANGED` (il totale non è quello mostrato);
4. la proposta;
5. per una chiave di un ordine già pagato, `ORDER_NOT_PAYABLE`, prima di ogni cancello.

## 4. Il contesto e il valore `repeatContext`

Il server descrive ciò su cui il cliente decide con un oggetto canonico:

- chi chiede (account od ospite);
- il carrello: impronta canonica v2 e versione del formato;
- gli importi: totale, valuta, righe, spedizione, imposta;
- per un ordine che esiste: il suo id e la sua revisione finanziaria;
- G, con la revisione finanziaria di ogni ordine.

Il valore è `rc1_` + SHA-256 del JSON canonico di questo oggetto. **Qualsiasi** differenza dà un altro valore: un prezzo, un'imposta, una spedizione, un pagamento verificato in più, un ordine uscito dalla finestra, un evento finanziario su un ordine. A quel punto la conferma precedente non autorizza più nulla e arriva una nuova proposta.

Il server **ricalcola il contesto sotto i suoi lock**, in S2 e in S3, e accetta solo l'uguaglianza esatta.

**Prezzo o preventivo che cambiano durante una richiesta:**

- prima del preventivo, con un totale diverso: `PRICE_CHANGED`;
- prima del preventivo, con lo stesso totale e imposte o spedizione diverse: nuova proposta;
- dopo il preventivo: la richiesta usa la sua istantanea, e l'ordine nasce con gli importi confermati.

**Modello di fiducia.** Il valore dice soltanto che il client ha rimandato il contesto descritto dal server. **Non è una firma**, non autentica nessuno e **non prova un gesto umano**: il gesto è compito della pagina (P4). Non serve un segreto, perché il valore non autorizza nulla da solo: decidono le prove di proprietà e i lock. Non va scritto nei log.

## 5. Accettazione, retry, recupero

Una conferma valida lascia sull'ordine, in `metadata.checkout`:

- `repeatOf`: gli id di G;
- `repeatAcceptance`: `{ v, g, n, rev, context, via, at }`, cioè impronta e numero di G, revisione finanziaria dell'ordine, valore confermato, prova usata e istante.

L'accettazione vale finché G è lo stesso insieme con le stesse revisioni e l'ordine ha ancora la stessa revisione. Non tocca dati finanziari: la revisione non sale. Viene scritta in due modi:

- **ordine nuovo**: nello stesso INSERT che lo crea (revisione 0);
- **ordine esistente**: in S3, sotto i lock del proprietario e il lock di riga.

| Situazione | Esito |
|---|---|
| Risposta persa, retry con la stessa chiave o con una nuova | stesso ordine, stessa pagina, nessuna seconda conferma |
| Crash dopo la creazione dell'ordine, prima della pagina | il retry, anche senza valore, ottiene la pagina |
| Provider irraggiungibile dopo l'accettazione | il retry ottiene la pagina |
| G cambia **dopo** la creazione dell'ordine e **prima** della pagina (per esempio un rimborso) | `409` con `pendingOrder: true` e nessuna pagina; il retry ritrova lo stesso ordine; con il nuovo valore si completa |
| Contesto cambiato | nuova proposta, anche se esiste un'accettazione |

**Garanzia:** una conferma autorizza al più **un pagamento**. Un ordine creato o continuato con quel valore si paga solo dall'unica pagina pagabile che P2 consente. Una volta pagato, entra in G e il valore non vale più. Il valore scade da solo quando l'ordine più recente di G esce dalla finestra.

## 6. Concorrenza (che cosa è garantito e che cosa no)

- Gli ordini di G **non sono bloccati**. Chi ne scrive il denaro blocca la riga del **suo** ordine, non i lock del checkout:
  - `lib/payment-sync.ts` per un pagamento verificato, un rimborso o una contestazione;
  - `lib/payment-hold.ts`;
  - le rotte amministrative.
- Per questo G può cambiare dopo essere stato letto. Il contesto viene riletto a ogni decisione: in S2, in S3 prima di scrivere una prenotazione e di nuovo prima di consegnare una pagina appena creata. Una pagina non viene mai consegnata su un contesto cambiato.
- Un cambiamento **dopo** l'ultima verifica (pagina già consegnata) non viene impedito. Non crea un doppio pagamento, perché un nuovo pagamento richiede una pagina pagabile e P2 la vieta. Il caso in cui un amministratore collega un pagamento a un ordine senza pagina è fuori da questa garanzia.
- Richieste confermate in parallelo, anche da processi diversi: un solo ordine. I lock del proprietario sono consultivi di PostgreSQL e valgono tra processi.

## 7. Obblighi della pagina (P4)

- Mostrare una scelta comprensibile: **continuare con un nuovo acquisto** oppure **rinunciare**. Il riepilogo dell'ordine precedente si legge da `/api/checkout/status` con le stesse prove.
- Per confermare, rimandare la stessa richiesta con la stessa `checkoutKey`, `confirmRepeat: true` e il `repeatContext` ricevuto, così com'è. Per rinunciare, non inviare nulla.
- Tenere il valore solo nella memoria della pagina. Dopo un ricaricamento, l'accettazione salvata sul server copre gli ordini già confermati; altrimenti arriva una nuova proposta.
- A una seconda proposta, mostrare di nuovo la scelta: il contesto è cambiato.
- Con `pendingOrder: true`, dire che un ordine è già pronto e attende la conferma.
- Revisione UX prima del lancio: ChatGPT.

## 8. Limiti noti

- Nessun cancello per sola sessione e lineage (scelta di riservatezza).
- La conferma non prova un gesto umano.
- **E2** e il caso **ospite → account** (`KL-E2-login`, ancora RED) restano aperti fino a P2b: l'account non vede l'ordine fatto poco prima da ospite.
- Un riacquisto involontario oltre i 60 minuti non è coperto. Un riacquisto voluto entro i 60 minuti costa una conferma in più. Un clic in più anche quando G cambia (un ordine esce dalla finestra, un evento finanziario).
- La cancellazione dell'account (`lib/privacy.ts`) azzera i metadata e quindi anche l'accettazione: è l'hardening E.
- Hardening A: il guard legge solo le sorelle che possono cambiarne la decisione, e il limite di 200 vale su quelle (`docs/RILASCIO-PRODUZIONE.md` §22). Con l'indice A-idx (§21) la lettura per account costa 1,3 ms a 1M ordini (17,7 ms con 1.000 ordini dello stesso carrello).
- Hardening B: le versioni dell'impronta del carrello hanno un registro; il contesto porta la versione corrente; una versione nuova si introduce in due fasi (`docs/RILASCIO-PRODUZIONE.md` §23).
- Restano aperti l'hardening D–E prima dell'attivazione di `on`, la flotta mista e P6. Non sono stati provati Stripe reale né dispositivi reali.
