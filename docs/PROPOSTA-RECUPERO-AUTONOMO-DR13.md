# DR-13 — recupero autonomo dopo un crash: analisi dei punti di ripresa e PROPOSTA tecnica

**Stato: PROPOSTA. Nulla di quanto segue è implementato.** Nessuno scheduler, cron, coda, processo residente o altra infrastruttura persistente è stato creato o modificato. Crearli richiede un'**autorizzazione specifica** del titolare (decisione D-REC, §7), da prendere dopo l'audit di ChatGPT. Questo documento fornisce ciò che serve per decidere: che cosa esiste, che cosa manca davvero, la soluzione minima affidabile, costi e dipendenze, e le prove di accettazione.

## 1. Che cosa intendiamo per «recupero autonomo»

Dopo un crash (o una risposta persa, o un webhook mai arrivato) un ordine può restare in uno stato che DR-13 non risolve da sola, perché non ha regole per risolverlo «col tempo»: una riserva `creating`, una pagina `open` su un ordine che non si può più pagare, una riga chiusa senza la parola del provider. Oggi **si riprende solo se qualcuno si fa vivo**. «Autonomo» vuol dire: si riprende anche se nessun cliente torna e nessun webhook arriva.

DR-13 vieta tre scorciatoie, e il recupero autonomo non le riapre: **nessuna chiusura per tempo** di una riserva, **nessun rilascio per assenza** di una pagina da un elenco (E-B), **nessuna modifica a mano** di una riga. Tutto ciò che un processo autonomo può fare è ripetere, in modo idempotente, ciò che la richiesta del cliente farebbe, **con la prova del provider**.

## 2. I punti di ripresa che esistono oggi

| # | Segno di vita | Dove | Che cosa riprende | Chi lo provoca |
|---|---|---|---|---|
| P1 | Il cliente preme «Paga» o ricarica | `lib/checkout-sessions.ts` (`openCheckoutSession`) | replay della riserva (dove sicuro), prova delle righe chiuse senza prova (`prove`), chiusura con prova e sostituzione delle pagine (`retire`), riconsegna | il cliente |
| P2 | La pagina di stato / il ritorno da Stripe | `app/api/checkout/status/route.ts` → `closePagesSoon` (limitato da `allowPageClosure`) | chiusura con prova delle pagine vive di un ordine non pagabile | il cliente |
| P3 | Un webhook `checkout.session.completed` / `expired` | `app/api/stripe/webhook`, `lib/payment-sync.ts` | registra pagamento o scadenza **con prova**; scrive l'identificativo sulla riga che porta `metadata.attemptId`; chiude le gemelle | **Stripe** (riprova la consegna per giorni **[D: documentazione di Stripe, non osservato qui]**) |
| P4 | `stripe-sync` (admin) | `app/api/admin/orders/[orderId]/stripe-sync` | rilegge e tratta una sessione/pagamento | un amministratore |
| P5 | La decisione sul pagamento trattenuto | `lib/payment-hold.ts` | chiude con prova le pagine, poi decide | un amministratore |
| P6 | Lo strumento D10 | `scripts/checkout-reconcile.ts` | adotta una sessione nominata dal provider e lascia decidere al pianificatore | un amministratore |
| P7 | Il rapporto | `scripts/checkout-pages-check.sql` | **nulla**: elenca (Q1–Q6) | una persona |

Solo **P3** parte senza una persona (Stripe), ed è l'unico recupero già autonomo. Che cosa fa davvero, e che cosa **nessun** punto di ripresa fa, è fissato da `tests/security/dr13-resume-points.sec.ts` (RP1: una riserva orfana riceve da sola identificativo e prova dall'annuncio di scadenza del provider; RP2: la gemella non chiusa di un ordine pagato resta pagabile e in Q6 finché il provider non annuncia la sua fine, poi riceve la prova; RP3: una riserva la cui richiesta non è mai arrivata non viene rilasciata da niente, nemmeno dopo 25 ore, una lettura di stato, il giro delle pagine dell'ordine o un elenco completo e vuoto).

## 3. Che cosa manca davvero — e quanto pesa

Un fatto limita il problema: **una pagina di Stripe vive al più `SESSION_TTL_MS` = 32 minuti** e poi Stripe la chiude da sé (e lo annuncia con `checkout.session.expired`, P3). Quindi anche senza nessun recupero autonomo, *una pagina pagabile non resta pagabile oltre ~32 minuti*. Quello che un recupero autonomo aggiunge non è «la pagina si chiude» (si chiude comunque), ma:

| Stato da recuperare | Senza nessuno che si fa vivo | Esposizione | Che cosa aggiungerebbe un processo autonomo |
|---|---|---|---|
| **A.** Pagina `open` (o riserva con sessione esistente) su un ordine **non più pagabile** (gemella di un ordine pagato, ordine annullato) la cui chiusura non è stata provata | scade da sola entro ~32 min; il webhook `expired` (P3) scrive la prova sulla riga; fino ad allora un secondo pagamento è possibile (rilevato come `duplicate_payment`, mai rimborsato da solo) | finestra ≤ 32 min di una pagina pagabile su un ordine che non dovrebbe esserlo | chiuderla in **minuti**, con prova; la riga esce da Q6 senza aspettare il webhook |
| **B.** Riga chiusa **con** identificativo e **senza** prova (dati storici, `payment_failed`, `session_mismatch:` del codice pubblicato) su un ordine ancora pagabile | niente: blocca la nuova pagina solo quando il cliente torna, e allora P1 la risolve | nessuna per il cliente che non torna | pulizia: scrivere la prova prima del ritorno; azzerare Q5 con identificativo |
| **C.** Riserva `creating` **senza identificativo** la cui richiesta **è arrivata** a Stripe (risposta persa) e il cliente non torna | la sessione scade da sola (~32 min) e il webhook `expired` porta `metadata.attemptId`: se arriva, la riga riceve identificativo e prova (P3). Se il webhook non arriva, resta `creating` | nessuna (la pagina non è mai stata consegnata e scade) | recuperare la prova senza aspettare il webhook; allarme se resta |
| **D.** Riserva `creating` **senza identificativo** la cui richiesta **non è mai arrivata** | resta `creating` per sempre: nessun webhook, nessun elenco prova l'assenza | l'ordine non si può più pagare (il cliente vede «ancora in controllo»); nessun rischio di doppio addebito | **nulla, per progetto**: non si rilascia per assenza (E-B). Solo allarme e intervento (D10 se compare una prova) |
| **E.** `processing` fermo (pagamento in conferma) | status poll / `stripe-sync` quando qualcuno guarda | il cliente ha pagato e non vede la conferma finché non torna, ma il webhook (P3) lo registra | allarme di età; la rilettura periodica è un «`stripe-sync` automatico» |
| **F.** Webhook perso (Stripe smette di riprovare dopo giorni) | A–C restano com'erano | come sopra | rilettura periodica |
| **G.** Effetti post-pagamento falliti (`recoverPostPaymentEffects`) | non riprovati da soli (residuo del Passo 5, **fuori da DR-13**) | fuori perimetro | fuori perimetro: ricordato perché usa lo stesso meccanismo |

**Conclusione.** Il recupero autonomo non protegge denaro che non sia già protetto dalla scadenza naturale delle pagine e da P3: accorcia la finestra A, ripulisce B e C e **fa suonare un allarme per D**. Il caso D (richiesta mai arrivata) **non è risolvibile autonomamente senza un'ipotesi sul provider che oggi non possiamo provare** (E-B; checklist 1.75): resta un intervento umano, ed è il motivo per cui il processo proposto **segnala** invece di sbloccare.

## 4. Soluzione minima affidabile

Un **passaggio di recupero** (nome indicativo: `checkout-pages-sweep`) che, a ogni esecuzione:

1. sceglie, **in sola lettura**, un numero **limitato** di ordini con lavoro da fare (ordinati dal più vecchio):
   * **A** = le righe di Q6 (pagine vive o chiuse-senza-prova con identificativo su ordini non pagabili);
   * **B** = le righe di Q5 con identificativo su ordini ancora pagabili;
   * **C** = le riserve (Q2) con identificativo, o più vecchie della finestra del webhook (es. > 40 min) senza;
   * **E** = gli ordini `processing`/`attention` più vecchi di una soglia;
2. per ciascuno chiama **soltanto funzioni già esistenti e idempotenti**, ognuna delle quali agisce solo con la parola del provider:
   * A → `closePagesOfOrder(orderId)` (`lib/checkout-pages.ts`: sceglie con lo stesso pianificatore, chiude con `expire`, scrive la prova solo se il provider la dà; non ricorre; non propaga errori);
   * B → il passo `prove` dell'orchestratore (oggi interno a `openCheckoutSession`; andrebbe esposto come funzione che non può creare né consegnare nulla, come `applyKnownSession`);
   * C → rilettura di una sessione già nominata (`retrieve` → `applyKnownSession`) e, **solo se la riserva non ha identificativo e il replay è in modalità `EVIDENCE_ONLY`**, il replay «solo per imparare» già limitato per ordine (`EVIDENCE_REPLAY_PACE`); **mai** un replay `FRESH_OK` (potrebbe creare una pagina che nessuno ha chiesto);
   * E → `syncPayment` come `stripe-sync`;
3. **non fa mai**: aprire o consegnare una pagina; chiudere una riserva per tempo; rilasciare per assenza o per un elenco; modificare una riga se non attraverso il percorso che ne dà la prova; muovere denaro; segnare un ordine pagato;
4. registra metriche e log, e alza gli **allarmi** del §6.

È la soluzione minima perché **non aggiunge nessuna regola nuova**: è un chiamante periodico delle regole che DR-13 già impone e già prova.

### 4.1 Quattro modi di farlo girare — e che cosa ciascuno richiede

| Opzione | Come | Infrastruttura nuova | Pro | Contro |
|---|---|---|---|---|
| **O0 — Nessun processo** | Un operatore esegue il rapporto (Q2/Q5/Q6) a intervalli, e D10 quando serve; allarmi sulle metriche esistenti | nessuna | zero costo e zero superficie nuova | dipende da una persona; la finestra A resta ≤ 32 min; B/C si puliscono solo a mano |
| **O1 — Pianificazione esterna** | il passaggio come script (`npm run checkout:sweep`) lanciato ogni ~5 min dallo scheduler **dell'host/Unraid** (come già va pianificato `retention:run`, checklist 1.55, e il backup) | uno script + una voce nello scheduler dell'host | niente processo residente nuovo; semplice da fermare | lo scheduler dell'host non è nel repository (va documentato e controllato); una voce dimenticata = nessun recupero |
| **O2 — Processo residente come il worker esistente** | un ciclo (`worker:checkout-pages`) avviato da `scripts/start-production.js` con un interruttore (`START_CHECKOUT_PAGES_WORKER=1`), come `START_PROCESSING_WORKER` | un processo figlio nel contenitore esistente | segue lo schema già presente; parte e muore con l'applicazione; versionato nel repository | un processo in più nel contenitore (memoria, riavvii); con più istanze serve il blocco di §5 |
| **O3 — Coda o scheduler dedicato** (pg-boss, BullMQ, pg_cron…) | | una dipendenza e/o un'estensione nuova | ripetizioni e osservabilità più ricche | la dipendenza maggiore per un lavoro piccolo; **sconsigliata** per questo bisogno |

**Raccomandazione:** **O0 subito** (costa solo il runbook e gli allarmi) e **O2** se il titolare vuole un recupero davvero autonomo, perché è l'unica opzione che vive nel repository ed è provabile con i test di accettazione di §8. **O1** è un compromesso accettabile se si preferisce non avere un processo residente. **Non** serve O3.

## 5. Frequenza, idempotenza e protezioni di concorrenza

* **Frequenza:** ogni 5 minuti (A è la più sensibile: porta la finestra da ≤ 32 a ~5–10 min). Un passaggio ha un **budget** (es. 50 ordini, 100 chiamate al provider, 60 s) e si ferma tra un ordine e l'altro, mai a metà di uno: se il budget finisce, il resto è al passaggio successivo.
* **Selezione con un'età minima:** non si tocca un ordine il cui ultimo cambiamento è più recente di ~2 minuti (la richiesta del cliente è probabilmente ancora in corso); il passaggio non compete con il cliente: se lo incontra, entrambi convergono (le scritture sono condizionali).
* **Idempotenza:** ogni funzione chiamata lo è già (provato da DR-13: interleaving, processi reali, crash a ogni passo). Ripetere un passaggio è sicuro; un passaggio interrotto si riprende al successivo.
* **Un solo passaggio alla volta:** un blocco consultivo di PostgreSQL (`pg_try_advisory_lock` con una chiave fissa): se un altro passaggio è in corso, quello nuovo esce subito (con più istanze o con O1+O2 insieme). Il blocco si rilascia da solo se il processo muore.
* **Con il cliente e con i webhook:** tutte le scritture passano dall'**accomodamento sotto blocco dell'ordine** (`settleAndPlan`, `FOR UPDATE` su `PrintOrder`), con aggiornamenti condizionali e conteggio letto; nessuna transazione resta aperta durante una chiamata a Stripe. Non c'è un secondo percorso di scrittura.
* **Contro il limite di Stripe:** il passaggio è limitato per budget e per ordine (`EVIDENCE_REPLAY_PACE` per i replay); su errore 429/5xx esce e riprova al giro dopo (nessuna ripetizione stretta).
* **Interruttore:** `CHECKOUT_PAGES_SWEEP_ENABLED` (spento di serie in produzione, come `HOSTED_CHECKOUT_ENABLED`) e un'opzione `--dry-run` che elenca che cosa farebbe senza chiamare nulla di scrittura.

## 6. Osservabilità e allarmi

**Metriche nuove:** `checkout_sweep_runs_total{outcome}`, `checkout_sweep_orders_total{class,outcome}` (class = A/B/C/E), `checkout_sweep_duration_ms`, `checkout_sweep_budget_exhausted_total`, e due **misure di età** calcolate dal rapporto: `checkout_unresolved_oldest_age_seconds{class}` e `checkout_unresolved_count{class}`. **Log** strutturati `checkout.sweep` con `orderId`/`attemptId`/`sessionId`.

**Allarmi** (da configurare dove si leggono le metriche del progetto):

| Condizione | Gravità | Perché |
|---|---|---|
| nessun passaggio riuscito da > 15 min (con O1/O2 attivi) | alta | il recupero non gira |
| `checkout_unresolved_oldest_age_seconds{class="A"}` > 15 min | alta | una pagina pagabile su un ordine non pagabile non si chiude |
| qualunque riserva di classe D (`creating` senza identificativo > 40 min) | media, **sempre** | non si risolve da sola: serve una persona (D10) |
| `checkout_page_close_unconfirmed_total` o `checkout_reservation_unresolved_total` in crescita per > 10 min | media | Stripe non risponde / dati incoerenti |
| `duplicate_payment` registrato | alta | un doppio incasso da rimborsare a mano |
| `checkout_session_identifier_not_recorded_total` > 0 | alta | una sessione nominata dal provider non è stata scritta |

## 7. Costi, dipendenze e decisione richiesta

| Voce | O0 | O1 | O2 | O3 |
|---|---|---|---|---|
| Codice nuovo | nessuno (solo runbook/allarmi) | ~1 script + 1 funzione per il passo `prove` esposta + metriche | come O1 + un ciclo e l'avvio nel `start-production.js` | come O1 + integrazione della coda |
| Dipendenze nuove | nessuna | nessuna (voce nello scheduler dell'host) | nessuna | **sì** (libreria/estensione) |
| Rischio operativo | dimenticanza umana | voce di scheduler dimenticata | un processo in più nel contenitore | superficie e aggiornamenti |
| Chiamate a Stripe | solo a mano | ≤ budget ogni 5 min (solo ordini con lavoro) | idem | idem |
| Costo Stripe | nullo | trascurabile: letture e `expire` solo su ordini con lavoro; non risulta un costo per chiamata API **[D: da confermare con il piano Stripe]**, il limite è la frequenza delle richieste | idem | idem |
| Prove da scrivere | nessuna | §8 | §8 | §8 + prove della coda |

**Decisione D-REC (del titolare, dopo l'audit):** (1) accettare O0 con una frequenza di controllo del rapporto scritta e gli allarmi, **oppure** (2) autorizzare O1 o O2 e quindi un lavoro separato di implementazione con i test di accettazione di §8. Fino ad allora: **nessun codice, nessuno scheduler, nessuna coda**.

## 8. Prove di accettazione (da superare prima di abilitare O1/O2)

Tutte su PostgreSQL isolato con Stripe simulato, come le altre di DR-13; nessuna chiamata a Stripe reale né in modalità test.

1. **Classe A** — un ordine pagato con una gemella `open` (chiusura fallita): il passaggio la chiude con `expire`, scrive `closed_by_us:` e la riga esce da Q6; con `expire` irraggiungibile non scrive nulla, riprova al giro dopo e non propaga l'errore.
2. **Classe B** — riga `failed` con identificativo e `session_mismatch:` (forma del codice pubblicato) su un ordine pagabile: la pagina resta chiusa **con prova**, la causa si conserva; nessuna pagina nuova è stata aperta dal passaggio.
3. **Classe C** — riserva con sessione esistente e identificativo noto: `retrieve` → registrazione; senza identificativo e in `EVIDENCE_ONLY`: un solo replay per finestra; **mai** un replay `FRESH_OK` (la riserva giovane non si tocca: età minima).
4. **Classe D** — riserva la cui richiesta non è mai arrivata: il passaggio **non la tocca**, alza l'allarme, e un elenco completo e vuoto non cambia nulla (mutante «rilascia per assenza» ucciso).
5. **Classe E** — `processing` vecchio: rilettura tramite il percorso verificato; mai `paid` da altro che dalla sincronizzazione.
6. **Concorrenza** — due passaggi insieme: uno esce per il blocco consultivo; un passaggio e una richiesta del cliente insieme (barriere di `tests/security/_dr13-barrier.ts`): stesso stato finale, mai due pagine pagabili (monitor del simulatore), nessuna transazione aperta durante le chiamate.
7. **Crash** — il passaggio muore a ogni passo (come `dr13-crash.sec.ts`): il successivo converge; il blocco consultivo si libera.
8. **Budget e ritmo** — con N ordini oltre il budget il passaggio si ferma tra un ordine e l'altro e non supera il numero di chiamate; con 429 esce.
9. **Interruttore** — spento: nessuna lettura di Stripe, nessuna scrittura; `--dry-run`: elenca senza scrivere.
10. **Guardia sul sorgente** — il passaggio non contiene `sessions.create`, né scritture dirette di righe, né un'uscita che liberi per assenza (come la guardia di `dr13-reconcile.sec.ts`).
11. **Mutanti** — chiusura per tempo, rilascio per assenza, replay `FRESH_OK`, scrittura diretta, età minima ignorata, blocco consultivo ignorato: tutti uccisi.
12. **Non regressione** — suite DR-13, `payment-hold`, `s2s3-step2`, migrazione.

Quello che **non** proveranno: il comportamento di Stripe reale nei punti elencati in `docs/RUNBOOK-PAGINE-STRIPE.md` §8 (checklist 1.75).

## 9. Stato delle cose e prossimo cancello

* Implementato e provato (locale): pianificatore, orchestratore, chiusura con prova, riconciliazione D10 (adozione di una sessione nominata dal provider), runbook, migrazioni, rapporto.
* **Non implementato:** qualunque processo autonomo (questa proposta), il rilascio per assenza (E-B), un'interfaccia web per D10, un elenco operativo dei pagamenti senza ordine.
* **Prossimo cancello:** audit di ChatGPT → decisione D-REC del titolare → (se O1/O2) mandato di implementazione separato con le prove del §8 → protocollo in modalità test del titolare (1.75) → dispositivi veri (1.76) → solo allora il rilascio (`docs/RILASCIO-PRODUZIONE.md` §19).
