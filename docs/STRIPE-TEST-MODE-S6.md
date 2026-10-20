# Verifica dei fatti di Stripe in modalità di prova (S6) — guida passo passo

Questa guida è per il titolare. Non serve essere tecnici: ogni passo dice **cosa scrivere** e **cosa aspettarsi**. Il lavoro vero lo fa uno script (`scripts/stripe-test-mode-verify.ts`); tu lo avvii, rispondi a una sola domanda e mi mandi un file.

> **Chi fa che cosa.** Io (l'assistente) **non ho chiamato e non chiamo Stripe**, nemmeno in modalità di prova: lo script è stato soltanto scritto e provato **offline** con un Stripe finto. Lo esegui **tu**, con una **tua** chiave di prova. La chiave non va mai incollata in chat, nel repository o nei log.

## 1. A che cosa serve

Il progetto S6 (pagamenti in verifica e prova finanziaria) si basa su alcune **affermazioni su come funziona Stripe** (per esempio: «una pagina di pagamento già pagata non si può chiudere», «un rimborso ripetuto con la stessa chiave non paga due volte», «una contestazione persa lascia un ritiro di fondi che si legge dalle transazioni di saldo»). Sono contrassegnate come **fatti T1–T18**. Finché non sono verificate con Stripe vero, restano **ipotesi** e le parti del codice che ne dipendono (la posizione dei fondi, le decisioni «nessun addebito» e «accetta», il rimborso governato) **non vengono scritte**: la riga 1.44 della checklist resta **Bloccante** e il lancio resta bloccato.

Lo script fa fare a Stripe, in modalità **test**, piccole operazioni reali (un pagamento di prova, un rimborso, una contestazione di prova…) e annota che cosa succede davvero. Il risultato è un rapporto con, per ogni fatto, una di tre risposte:

| Risposta | Che cosa vuol dire | Che cosa succede al progetto |
|---|---|---|
| `confirmed` (confermato) | Stripe si è comportato come previsto. | La parte di codice che ne dipende può essere scritta. |
| `contradicted` (contraddetto) | Stripe si è comportato **diversamente**. **Non è un errore dello script**: è un'informazione preziosa. | Mi fermo e riferisco: la parte di progetto che ne dipende va ripensata (la tabella dei fatti, più sotto, dice che cosa cambia). |
| `not_confirmable` (non verificabile) | La prova non ha potuto rispondere (permesso mancante, nessuna carta di prova adatta, non riproducibile…). | Il codice resta nella forma **prudente** (rifiuta / blocca), la riga di checklist resta Bloccante, nessun declassamento silenzioso. |

**Un fatto che afferma più cose si riporta parte per parte.** T2 (Stripe rifiuta, la sessione resta completata), T5 (stessa richiesta, altro importo, richieste simultanee), T8 (esiti, ritiro, reintegro, eventi), T14 (stato aperto, fine senza rimborso, solo stati noti) e T16 (rimborso in attesa, rimborso fallito o annullato) mettono insieme più affermazioni. Per questi cinque il rapporto contiene anche l'elenco `parts`: per ogni parte dice se è `confirmed`, `contradicted` o `not_confirmable` e perché. La risposta del fatto è quella della parte **peggiore** (contraddetta, poi non verificabile, poi confermata): un fatto è `confirmed` **solo se tutto ciò che il suo titolo afferma è stato osservato**. Ciò che non è stato visto non viene mai dato per confermato: il fatto resta `not_confirmable` e il rapporto dice quali parti sono confermate e quali no.

**Un errore non è una prova.** Dove un fatto dipende da come Stripe *risponde* (T2, T5), vale **solo la risposta specifica** di cui il fatto parla. Un errore del server (5xx), una connessione caduta, un timeout, un limite di richieste, un permesso mancante, un oggetto non trovato **non dimostrano nulla**: la parte resta «non verificabile» — mai «confermata» e mai «contraddetta» — e il rapporto registra che cosa Stripe ha risposto. Anche l'**assenza** di una risposta, o di un rimborso nell'elenco, non è una contraddizione. Per riconoscere le risposte specifiche lo script usa solo i tipi e i codici che l'SDK di Stripe documenta (`idempotency_error`, `idempotency_key_in_use`, richiesta non valida con stato HTTP 400); non ne inventa nessuno.

## 2. Che cosa NON fa (garanzie)

- **Usa solo chiavi di prova.** Si rifiuta se la chiave non inizia con `sk_test_` o `rk_test_`, e si ferma subito se vede un oggetto in modalità reale (live).
- **Non legge nessun file di configurazione** (nessun `.env`): la chiave si legge **solo** dalla variabile `STRIPE_SECRET_KEY` della finestra del terminale in cui lo lanci.
- **Non stampa e non salva mai** la chiave, i «client secret», i link alle ricevute, gli indirizzi e-mail, i dati di carta, il segreto di firma dei webhook. Prima di scrivere il rapporto lo controlla; se trovasse qualcosa del genere **non lo scrive**.
- **Non esce dai limiti dichiarati** (sezione 6) e **non ripete nessuna chiamata da solo**.
- **Non cancella ciò che Stripe non fa cancellare** e non usa la cancellazione in blocco del Dashboard (sezione 7).
- Il rapporto viene scritto con permessi riservati a te (`0600`) in una cartella che scegli **fuori dal progetto**.

## 3. Che cosa serve

- Un account Stripe in **modalità test**. Meglio un account (o «sandbox») di prova **dedicato**, perché gli oggetti di prova non si possono tutti cancellare (sezione 7).
- Un computer con il progetto già installato (`npm install` fatto) e un terminale aperto nella cartella del progetto.
- La carta di prova di Stripe per il passo guidato: numero `4242 4242 4242 4242`, qualsiasi data futura, qualsiasi CVC, qualsiasi e-mail. (È una carta di prova pubblica di Stripe, non una carta vera.)
- Circa 20–30 minuti. Lo script non dura più di 20 minuti e ha un tetto di 170 chiamate.

## 4. Passo per passo

**Passo 1 — Crea una chiave di prova con limitazioni (consigliato).** Nel Dashboard di Stripe, con l'interruttore su **modalità test**: *Sviluppatori → Chiavi API → Crea chiave con limitazioni*. Dalle un nome come `makerworks-verifica`. I permessi che lo script usa sono (i nomi nel Dashboard possono variare): *Checkout Sessions* (scrittura), *PaymentIntents* (scrittura), *Charges and Refunds* (scrittura), *Disputes* (scrittura), *Webhook Endpoints* (scrittura), *Events* (lettura). Se un permesso manca, lo script **non si ferma**: segna «non verificabile» i fatti che ne hanno bisogno e scrive nel rapporto quale chiamata è stata rifiutata; abilita quel permesso e rilancia solo quei fatti (opzione `--only`, per esempio `--only T3,T5`). In alternativa puoi usare la chiave segreta di test normale (`sk_test_…`) di un account di prova. **Non avere fretta di salvarla in un file: serve solo per questa prova.**

**Passo 2 — Prova a secco, senza rete e senza chiave.** Scrivi:

```
npx tsx scripts/stripe-test-mode-verify.ts --dry-run
```

Vedrai l'elenco dei fatti, i limiti (sezione 6) e che cosa resta in Stripe. **Non viene aperta nessuna connessione.**

**Passo 3 — Inserisci la chiave senza mostrarla.** Nel terminale (macOS/Linux, bash o zsh):

```
read -s -p "Chiave di TEST di Stripe: " STRIPE_SECRET_KEY; echo; export STRIPE_SECRET_KEY
```

(In zsh: `read -s "STRIPE_SECRET_KEY?Chiave di TEST di Stripe: "; echo; export STRIPE_SECRET_KEY`.) Incolla la chiave e premi Invio: **non comparirà nulla**, è normale. Su Windows (PowerShell):

```
$s = Read-Host "Chiave di TEST di Stripe" -AsSecureString
$env:STRIPE_SECRET_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
```

La chiave esiste solo in questa finestra del terminale e sparisce quando la chiudi.

**Passo 4 — Avvia la prova vera.** Scegli una cartella **fuori dal progetto** per il rapporto, per esempio la tua cartella personale:

```
npx tsx scripts/stripe-test-mode-verify.ts --report-dir "$HOME/stripe-verify-reports"
```

Lo script mostra di nuovo il piano e i limiti e chiede di scrivere **`YES`** (in maiuscolo) per procedere. Qualsiasi altra risposta: non viene creato nulla.

**Passo 5 — Il passo guidato (T2).** A un certo punto lo script mostra un indirizzo di una pagina di pagamento **di prova**. Aprilo nel browser, paga con la carta di prova (`4242 4242 4242 4242`), poi torna al terminale e premi **Invio**. (Vuoi saltarlo? Scrivi `skip` e premi Invio, oppure avvia lo script con `--skip-guided`: il fatto T2 resterà «non verificabile».) Quell'indirizzo compare **solo sullo schermo**, non viene salvato.

**Passo 6 — A fine esecuzione.** Lo script scrive quante risposte ha avuto (confermate / contraddette / non verificabili) e dove ha salvato il rapporto. Poi:

1. Nella stessa finestra scrivi `unset STRIPE_SECRET_KEY` (PowerShell: `Remove-Item Env:STRIPE_SECRET_KEY`) e chiudi il terminale.
2. Nel Dashboard **revoca la chiave** che avevi creato per la prova.

**Passo 7 — Che cosa mandarmi.** **Solo** il file `stripe-test-mode-verify-<codice>.json` della cartella del rapporto. **Non** mandare la chiave, schermate del Dashboard con le chiavi, né altro. Il rapporto contiene gli identificativi degli oggetti di prova (non sono segreti) e le osservazioni, non dati personali.

## 5. Opzioni utili

| Opzione | Effetto |
|---|---|
| `--dry-run` | Mostra il piano e i limiti; nessuna rete, nessuna chiave necessaria. |
| `--report-dir <cartella>` | Dove scrivere il rapporto (obbligatoria nella prova vera; deve stare **fuori** dal progetto). |
| `--skip-guided` | Salta il passo guidato (T2 resta non verificabile). |
| `--only T3,T5` | Esegue solo i fatti indicati (e i passi che servono). |
| `--refund-test-pm pm_card_…` | Per T14/T16: il codice di un metodo di pagamento **di prova** che, secondo la documentazione di Stripe, produce rimborsi «in attesa» o «falliti». Senza, T14 e T16 restano non verificabili. |
| `--currency eur` | Valuta di prova (predefinita: `eur`). |
| `--run-id <codice>` | Il codice che marca gli oggetti creati (predefinito: casuale). |
| `--yes` | Salta la domanda `YES` (non consigliato la prima volta). |

## 6. Quanto crea al massimo

Questi sono i **massimi dichiarati**: lo script si ferma **prima** di superarli (e li ripete nel `--dry-run`). Sono gli stessi numeri scritti nel codice (`BUDGET`) e un test automatico controlla che questa tabella e il codice dicano la stessa cosa.

| Che cosa | Massimo |
|---|---|
| Denaro di prova | **1,00** per pagamento, **5** in totale (nella valuta di prova; in modalità test non si muove denaro vero) |
| Sessioni di Checkout (pagine di pagamento) | **2** |
| PaymentIntent (pagamenti) | **5** (compreso quello del passo guidato) |
| Rimborsi | **12** |
| Invii di prove per contestazioni | **2** |
| Endpoint webhook (creato e cancellato subito) | **1** |
| Chiamate all'API di Stripe | **170** |
| Durata | **20 minuti** |
| Clienti, prodotti, prezzi, fatture, link di pagamento | **mai creati** |
| Nuovi tentativi automatici di una chiamata | **nessuno** |

Ogni oggetto creato porta nei metadati `makerworksVerify=<codice>`: nel Dashboard puoi ritrovarlo cercando quel codice (che compare anche nel rapporto).

## 7. Che cosa resta in Stripe e che cosa si ripulisce

Stripe **non** elimina addebiti, rimborsi, contestazioni, transazioni di saldo ed eventi, e un pagamento riuscito non si annulla. Per questo conviene un account di prova dedicato. Lo script tenta **soltanto** la ripulitura che l'API consente e **scrive nel rapporto l'esito osservato per ogni oggetto**, con le parole: `deleted` (eliminato), `canceled` (annullato), `expired` (scaduto/chiuso), `voided` (fattura annullata), `detached` (metodo di pagamento scollegato), `remains` (resta). Quello che si prevede:

| Oggetto | Che cosa si può fare | Che cosa resta nella cronologia di Stripe |
|---|---|---|
| Pagina di Checkout **aperta** | Si chiude con `expire` → `expired`. | La sessione scaduta. |
| Pagina di Checkout **completata** (passo guidato) | Né chiudibile né eliminabile → `remains`. | La sessione con il suo pagamento. |
| PaymentIntent **non pagato** (se ne restasse uno) | Si annulla → `canceled`. | Il PaymentIntent annullato. |
| PaymentIntent **riuscito** e addebito con ricevuta | Né annullabili né eliminabili → `remains`. | Pagamento, addebito e ricevuta. |
| Metodo di pagamento di prova (codice `pm_card_…` di Stripe) | Non viene mai collegato a un cliente → `remains`. | L'oggetto non collegato. |
| Rimborso | Non eliminabile → `remains` (lo script non prova ad annullarlo, per non alterare ciò che osserva). | Il rimborso con il suo stato finale. |
| Contestazione di prova | Non eliminabile; si chiude con l'esito di prova (`won` / `lost`) → `remains`. | La contestazione e le sue transazioni di saldo. |
| Transazioni di saldo e pagamenti verso la banca di prova | Non eliminabili. | Restano nel saldo di prova. |
| Eventi | Non eliminabili. | Consultabili per un periodo limitato. |
| Endpoint webhook di prova (T13) | Si elimina subito → `deleted`. | Nulla (restano gli eventi di richiesta). |

L'unico modo di eliminare **in blocco** i dati di prova è l'opzione del Dashboard per cancellare o ripristinare i dati dell'account di prova (se esiste nel tuo account: **da verificare nel Dashboard**; è un'azione tua e irreversibile). **Lo script non la usa e non la richiede.**

## 8. I fatti da verificare (T1–T18) e che cosa cambia

| Fatto | Che cosa si verifica | Se è contraddetto / non verificabile |
|---|---|---|
| **T1** | Una pagina di pagamento **aperta** si chiude con `expire` e il suo pagamento non risulta riuscito. | Chiudere una pagina prima di una decisione non è affidabile: «nessun addebito» resta chiusa. |
| **T2** | Una pagina **già pagata** non si può chiudere (passo guidato: la paghi tu con la carta di prova). Due **parti**: «Stripe rifiuta la chiamata» (come richiesta non accettabile, HTTP 400) e «la sessione resta completata» (riletta dopo il tentativo). **`confirmed` solo se Stripe rifiuta davvero E la sessione risulta ancora completata.** Qualunque altra risposta — errore 5xx, connessione caduta, timeout, limite di richieste, permesso mancante, oggetto non trovato, oppure nessun errore — lascia il fatto **non verificabile**, e il rapporto scrive lo stato in cui la sessione è stata trovata. Se la sessione pagata risulta **cambiata di stato**, il fatto è **contraddetto** qualunque sia stata la risposta. | La decisione non si fonda mai sulla chiusura di una pagina che potrebbe essere pagata. |
| **T3** | Dopo un rimborso parziale e totale, `amount_refunded` cresce e il pagamento resta `succeeded`. | La regola dei rimborsi guarda anche lo stato del pagamento; ordine fermo dopo ogni rimborso. |
| **T4** | `refunds.list` restituisce **subito** il rimborso con i suoi metadati e il suo stato (10 letture ravvicinate). | La ricerca di un rimborso non ancora visibile può mancarlo per un po': l'operazione resta «non risolta» invece di essere conclusa (già previsto). |
| **T5** | La stessa richiesta con la stessa chiave di idempotenza due volte dà lo **stesso** rimborso; la stessa chiave con **un altro importo è rifiutata con l'errore di idempotenza di Stripe** (`idempotency_error`); due richieste insieme. Tre **parti** nel rapporto. **Solo l'errore di idempotenza prova il rifiuto**: qualunque altra risposta (5xx, connessione caduta, timeout, limite di richieste, permesso mancante, il conflitto «chiave già in uso») lascia quella parte «non verificabile». **Richieste simultanee**: la parte è confermata solo se le due risposte indicano **lo stesso rimborso**, oppure una fa il rimborso e l'altra riceve il conflitto documentato `idempotency_key_in_use`, **e** l'elenco dei rimborsi ne mostra **uno solo**; è contraddetta solo se esistono **due rimborsi** (nominati dalle risposte o contati nell'elenco); un errore diverso dal conflitto, nessuna risposta, o un elenco che non mostra ancora il rimborso **non concludono** (non verificabile). Se T5 resta non verificabile rilancia con `--only T5`. | Il reinvio automatico con la stessa chiave resta spento; un esito sconosciuto diventa «non risolto». |
| **T6** | Le chiavi di idempotenza durano 24 ore. **Non riproducibile in una prova: sempre «non verificabile»** (per costruzione). | Il margine di 20 ore resta; oltre non si reinvia nulla. |
| **T7** | Una carta che genera una contestazione dà `charge.disputed`, uno stato e le transazioni di saldo (ritiro e commissione a parte). | La posizione dei fondi va riscritta da ciò che si è visto; una contestazione persa resta «non verificabile». |
| **T8** | Esiti `won` e `lost` (prove di test), **ritiro** dei fondi sulla contestazione persa, **reintegro** dei fondi sulla vinta (entrambi dalle transazioni di saldo) **e gli eventi che le annunciano, ciascuno per la propria contestazione** (persa: `closed` e `funds_withdrawn`; vinta: `closed` e `funds_reinstated`). Il rapporto ha quattro **parti**: esiti, ritiro, reintegro, eventi. **`confirmed` solo se tutte e quattro sono state osservate.** Se i fondi sono come previsto ma gli eventi non si vedono (o l'elenco degli eventi non si può leggere, per esempio per un permesso mancante) il fatto è **`not_confirmable`** e il rapporto scrive «Confermato: esiti, ritiro, reintegro. NON confermato: eventi». Un evento visto per una contestazione non copre quello mancante dell'altra. | Esiti, ritiro o reintegro diversi dal previsto: la regola del reintegro si riscrive. Solo gli eventi non visti: il codice non ne dipende (una contestazione chiusa si apprende **leggendola**), ma gli eventi restano non confermati e la sottoscrizione dei nuovi tipi di evento va ricontrollata prima del lancio. Una vittoria resta incerta finché i fondi non risultano reintegrati. |
| **T9** | Che cosa dice `Charge.disputed` dopo la chiusura. | Il flag non si usa mai da solo. |
| **T10** | `expand` di `latest_charge.dispute` con le transazioni di saldo in linea. | Serve una seconda lettura della contestazione. |
| **T11** | Un rimborso di un addebito **contestato**: previsto rifiuto con codice `charge_disputed`. | Rimborso e contestazione potrebbero togliere entrambi denaro: la posizione dei fondi lo segnala e chiede una persona. |
| **T12** | La ricerca (`payment_intents.search`) serve a **scoprire** denaro, non a escluderlo (ritardo misurato). | La ricerca resta inutilizzata, come da progetto. |
| **T13** | Versione dell'API in uso e possibilità di sottoscrivere i nuovi tipi di evento (endpoint di prova, cancellato subito). | La chiusura di una contestazione si apprende solo leggendola. |
| **T14** | Gli stati del rimborso oltre `succeeded` — `pending`, `requires_action`, `failed`, `canceled` — e come si susseguono. Solo con `--refund-test-pm`. Un singolo rimborso attraversa **alcuni** di questi stati, mai tutti, e `failed` e `canceled` sono **due fini alternative** (un rimborso ne ha una sola): per questo il fatto è `confirmed` quando si è visto un rimborso **aperto** (`pending` o `requires_action`) **e** un rimborso che **finisce senza rimborsare** (`failed` oppure `canceled`), senza stati fuori dai cinque noti. **Il rapporto elenca sempre, uno per uno, gli stati osservati e quelli NON osservati**: uno stato che nessuno ha prodotto non viene mai dato per confermato, nemmeno quando il fatto nel suo insieme lo è. Se manca lo stato aperto o la fine senza rimborso (per esempio il rimborso è riuscito subito, o è rimasto in attesa) il fatto è **non verificabile**; uno stato sconosciuto al codice lo rende **contraddetto**. | Il codice resta prudente: ogni stato diverso da `succeeded` vale «non ancora rimborsato» e uno stato sconosciuto blocca. |
| **T15** | Un rimborso appena creato è visibile **subito** in `refunds.list` e in `amount_refunded` (10 letture). | Il ritardo viene misurato; il progetto non si fonda sull'assenza (già previsto). |
| **T16** | `amount_refunded` include un rimborso ancora in attesa? Scende se il rimborso fallisce o viene annullato? Solo con `--refund-test-pm`; è una **misura**, quindi non è mai `contradicted`. Ogni lettura legge **prima l'importo** e **poi lo stato del rimborso** e si usa solo se lo stato è lo stesso prima e dopo l'importo (se lo stato cambia mentre si legge l'importo, quella lettura si scarta). Due **parti**: «rimborso in attesa (`pending` o `requires_action`) osservato con il suo importo» e «rimborso fallito o annullato osservato con il suo importo». **`confirmed` solo se si sono visti entrambi i momenti**; se ne manca uno (il rimborso è diventato subito `succeeded`, è rimasto in attesa per tutta la finestra di lettura, ecc.) il fatto è **`not_confirmable`** e il rapporto dice quale metà ha visto. | Il codice aspetta lo stato finale e non conta mai un rimborso in attesa come rimborsato. |
| **T17** | Rinviare **esattamente la stessa richiesta** del primo rimborso (quella di T4: stessa chiave **e stessi parametri, `metadata` compresi**) per tre volte dà lo stesso rimborso e **nessun secondo**. «T17» è solo il nome del risultato nel rapporto, **non un parametro** inviato a Stripe: Stripe rifiuta una chiave riusata con parametri diversi (è ciò che T5 verifica con un importo diverso), quindi una ripetizione con parametri diversi non proverebbe nulla e farebbe perdere gli altri fatti sui rimborsi. | L'applicazione non ripete mai una richiesta che ha già una risposta. |
| **T18** | Che cosa si può ripulire e che cosa resta (tabella della sezione 7), con l'esito osservato per ogni oggetto. | Questa tabella viene corretta. |

## 9. Se qualcosa va storto

- **«Cannot start: …»** subito all'avvio: la chiave non è una chiave di prova, manca la variabile, la cartella del rapporto è dentro il progetto, o non hai scritto `YES`. Non è stato creato nulla.
- **Errore di permesso** su una chiamata: il fatto interessato diventa «non verificabile» e il rapporto dice quale chiamata (e il codice di errore). Abilita il permesso e rilancia con `--only`.
- **Interruzione** (Ctrl+C, rete caduta): gli oggetti già creati restano; si ritrovano nel Dashboard cercando `makerworksVerify` o il codice dell'esecuzione. Non c'è nessun pericolo: è denaro di prova. Rilancia con un nuovo `--run-id`.
- **«livemode»**: se lo script vede un oggetto in modalità reale si ferma subito e il rapporto lo dice. Non dovrebbe mai accadere con una chiave di prova; se accade, revoca la chiave e avvisami.

## 10. Che cosa è stato provato e che cosa no

- **Provato offline** (`tests/stripe-test-mode-verify.test.ts`, con un Stripe **finto**, senza rete e senza chiave): rifiuto delle chiavi non di prova; nessun file letto; nessuna connessione in `--dry-run`; i limiti di oggetti, denaro, chiamate e tempo; l'arresto immediato davanti a un oggetto reale; ogni oggetto marcato e ripulito solo dove consentito; il rapporto senza segreti, con permessi `0600` e fuori dal progetto; le tre risposte per ogni fatto, anche quando il finto si comporta in modo contrario alle ipotesi.
- **Correzione dopo la revisione di SP1** (provata offline, con la prova «rosso → verde» in `docs/VERIFICA-4.6.md` S6a.13). Quattro difetti dello script e del suo Stripe finto: (1) **T17** rinviava il primo rimborso cambiando un parametro (`metadata.step` da `T4` a `T17`) con la **stessa** chiave di idempotenza: Stripe rifiuta questo caso (`idempotency_error`), la chiamata avrebbe interrotto la sezione dei rimborsi e T3, T4, T5, T15 e T17 sarebbero diventati tutti «non verificabili». Ora la richiesta di T4 si costruisce una volta sola e T17 la rinvia **identica**; l'unica richiesta che a parità di chiave differisce di proposito è quella di T5 con un importo diverso, che **deve** essere rifiutata. (2) Il **Stripe finto** confrontava soltanto pagamento e importo quando una chiave tornava, per questo il difetto non si vedeva: ora confronta **tutti** i parametri (importo, motivo, `metadata`, pagamento, parametri in più) e tiene un registro delle richieste, e un test intercetta il difetto originale di T17. (3) **T16** risultava sempre «confermato», anche se il rimborso era riuscito subito: ora lo è solo se ha visto un rimborso in attesa **e** uno fallito o annullato, ciascuno con il proprio importo. (4) **T8** decideva solo dai fondi: ora conta anche gli eventi di **ciascuna** contestazione, e se mancano il fatto resta «non verificabile» e il rapporto dice che cosa è confermato e che cosa no. Nessuna di queste correzioni è stata verificata con Stripe vero.
- **Seconda verifica di SP1** (T5, T2, T14; provata offline, `docs/VERIFICA-4.6.md` S6a.14). Tre imprecisioni rimaste nel valutatore, tutte dello stesso tipo — una conferma che non era stata osservata: (1) **T5** considerava «rifiuto» qualunque errore alla richiesta con importo diverso (un 500 o una connessione caduta la confermavano) e confermava le richieste simultanee dal solo numero finale di rimborsi; ora conta solo l'errore di idempotenza di Stripe, e le richieste simultanee si leggono dalle risposte **e** dall'elenco insieme (un errore generico non conferma, l'assenza di risposte non contraddice, due rimborsi veri contraddicono). (2) **T2** considerava «rifiuto» qualunque errore di `expire`; ora serve un rifiuto vero (richiesta non accettabile, HTTP 400) **e** la sessione ancora completata, altrimenti il fatto è non verificabile e lo stato della sessione è registrato. (3) **T14** era confermato da un solo stato; ora serve uno stato aperto **e** una fine senza rimborso (`failed` o `canceled`, alternative), e gli stati osservati e non osservati sono sempre elencati. Insieme: uno stop dello script stesso (un oggetto in modalità reale, un tetto raggiunto) non viene più scambiato per una risposta di Stripe in questi punti. Il Stripe finto usa per questi errori le **classi dell'SDK** (nessun codice inventato; un codice che il finto aveva inventato per la chiusura di una sessione è stato tolto). Nessuna di queste correzioni è stata verificata con Stripe vero.
- **Non provato**: il comportamento di **Stripe vero** (per questo si esegue lo script), i nomi esatti dei permessi nel tuo Dashboard, i tempi reali della ricerca e delle contestazioni, e qualunque carta o metodo di prova diverso da quelli indicati. Tutti i risultati ottenuti con il Stripe finto sono **simulati**: non sono fatti verificati.
