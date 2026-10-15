# Verifica di sicurezza – attività 1.4

Esito: **tutti e sei i problemi (S1–S6) sono stati riprodotti**. Nessuna logica applicativa è stata modificata: sono stati aggiunti solo test (`tests/security/`) e lo script `npm run test:security`.

## Come sono stati eseguiti i test (ambiente isolato)

- Database PostgreSQL **locale** su `127.0.0.1:55432`, nome `mkw_sectest`, creato solo per le prove e con dati fittizi (`@sectest.invalid`).
- Cartella di archiviazione temporanea con file fittizi.
- Stripe sostituito da un client finto: nessuna chiamata di rete, chiave finta, **nessun pagamento reale possibile**.
- Protezione integrata: i test **si rifiutano di partire** se `SEC_TEST_DATABASE_URL` non punta a un database locale il cui nome finisce con `_sectest`.
- S1 è stato verificato anche con un **server reale locale** (`next start`) e `curl`.

Riesecuzione:

```bash
SEC_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55432/mkw_sectest" npm run test:security
```

I test dei problemi confermati sono marcati `todo` (node:test): descrivono il comportamento **sicuro** atteso e oggi falliscono, quindi la suite resta verde e la vulnerabilità resta visibile. Dopo la correzione si toglie `todo`: il test deve passare.

Risultato: 21 test = 6 controlli superati (verificano che il banco di prova funzioni) + 15 verifiche di vulnerabilità che falliscono come previsto.

Altri controlli eseguiti sull'originale con il database di prova: `test:api` 7/7, `test:contracts` 14/14. `npm test` invariato (203 superati, 2 falliti preesistenti).

## Risultati

| # | Problema | Stato | Gravità |
|---|---|---|---|
| S1 | `/files` senza autenticazione + uscita dalla cartella | **CORRETTO e verificato** (Fase 1B, vedi sotto) | Critica |
| S2 | Importo pagato non confrontato col totale | **In correzione** (S2/S3 Passi 1–3 di 7: verifica unica di importo/valuta su ogni percorso, vecchio checkout bloccato in produzione; interfaccia e rimozione del vecchio ramo: Passi 4–6) | Critica |
| S3 | Pagamento riuscito senza ordine | **In correzione** (come S2: ordine creato prima del pagamento, pagamento riconosciuto anche senza il browser; pagamenti senza ordine registrati ed elencabili) | Alta |
| S4 | Webhook non rielaborato dopo un errore | **CORRETTO e verificato** (Fase 1B, vedi sotto) | Alta |
| S5 | Ordini senza pagamento da ospiti | **CORRETTO e verificato** (Fase 1B, vedi sotto) | Alta |
| S6 | File dei clienti pubblici | **CORRETTO e verificato** (Fase 1B, vedi sotto) | Alta (privacy) |
| S7 (nuovo) | L'API dei dettagli del modello ignora la visibilità e restituisce anche l'e-mail del proprietario | **CORRETTO e verificato** (Fase 1B, vedi sotto) | Alta (privacy) |

### S1 – File accessibili a chiunque

- **Prova:** un visitatore anonimo ha ottenuto HTTP 200 e il contenuto di un file cliente, di un backup (`backups/.../db.sql`) e di una ricevuta, con `Cache-Control: public, max-age=31536000, immutable`. Via HTTP reale, `GET /files/models/..%2f..%2foutside-secret.txt` ha restituito un file **fuori** dalla cartella di archiviazione. Le varianti `../`, `%2e%2e`, doppia codifica e `%5c` sono bloccate da Next.js.
- **Causa:** `app/files/[...path]/route.ts` unisce il percorso richiesto a `STORAGE_DIR` senza alcun controllo di identità né verifica che il risultato resti nella cartella. Il proxy esclude esplicitamente `/api` e `/files/` dall'autenticazione.
- **Conseguenze:** furto dei modelli dei clienti, delle ricevute (dati personali) e dei backup del database (hash delle password, indirizzi, ordini). Dati copiabili anche da cache pubbliche/CDN.
- **Correzione consigliata (semplice e consolidata):**
  1. Eliminare il servizio generico per percorso. Servire i file solo da una route che parte dall'**identificativo nel database** (es. `/api/files/model/[id]`), controlla che l'utente sia il proprietario o un amministratore, e poi legge il percorso salvato.
  2. In ogni caso usare `path.resolve` e rifiutare ciò che non inizia con la cartella radice (più rifiuto di byte nulli e di collegamenti simbolici).
  3. Spostare i backup fuori dalla cartella servita (`BACKUP_DIR` separato) e bloccare i prefissi `backups/` e `orders/`.
  4. File privati con `Cache-Control: private, no-store`.
  5. Per la produzione, in seguito, archiviazione esterna con link firmati a scadenza (Fase 7). Non serve ora.

### S2 – Pagamento di 1,00, ordine di valore superiore

- **Prova:** con un PaymentIntent finto da 1,00 già "pagato" e un altro carrello, la conferma ha risposto 200 e creato un ordine da 2,28 con `paymentStatus=paid` e `status=queued` (entrato in coda di produzione). Inoltre un PaymentIntent legato a un altro checkout è stato accettato.
- **Causa:** al momento della conferma il codice legge il PaymentIntent da Stripe e controlla solo lo stato (`succeeded/processing/requires_capture`). Non confronta `amount`, `currency` né `metadata.checkoutId`, e non collega l'intento al carrello. L'identificativo arriva dal browser.
- **Conseguenze:** perdita economica: con un carrello a prezzo alto un cliente paga una frazione del dovuto. Nota: con la configurazione predefinita i prezzi sono molto bassi (costi di macchina/manodopera a zero), quindi la differenza qui è piccola ma il meccanismo è lo stesso con importi maggiori.
- **Correzione consigliata:** creare l'ordine **prima** del pagamento, in stato "in attesa di pagamento", con totale calcolato dal server. Passare a **Stripe Checkout ospitato** con l'identificativo dell'ordine nei metadati. Segnare l'ordine come pagato solo dal webhook, dopo aver verificato `amount_total`/`amount_received` e valuta contro il totale salvato. Questa soluzione risolve anche S3.

### S3 – Pagamento senza ordine

- **Prova:** evento `payment_intent.succeeded` firmato per un pagamento senza ordine locale → risposta 200, **0 ordini e 0 record**.
- **Causa:** l'ordine viene creato solo quando il browser chiama la conferma; il webhook aggiorna ordini esistenti (`updateMany`/`update`) ma non ne crea. Prima del pagamento il carrello non viene salvato.
- **Conseguenze:** se il cliente chiude la pagina, perde la rete o il telefono si spegne dopo aver pagato, i soldi sono incassati ma non esiste alcun ordine, e nessuno lo nota.
- **Correzione consigliata:** vedi S2 (ordine in attesa creato prima del pagamento; il webhook lo porta a "pagato"). In aggiunta, un controllo amministrativo che segnali i pagamenti riusciti senza ordine corrispondente.

### S4 – Evento webhook perso dopo un errore

- **Prova:** prima consegna con Stripe "temporaneamente non disponibile" → HTTP 500; secondo invio dello **stesso evento** → risposta `duplicate: true` e ordine rimasto `pending`.
- **Causa:** `handleStripeWebhookEvent` registra l'evento in `StripeEvent` **prima** di elaborarlo. Se l'elaborazione fallisce, il nuovo tentativo viene riconosciuto come duplicato e ignorato.
- **Conseguenze:** ordine pagato che resta "non pagato" fino a un intervento manuale.
- **Correzione consigliata:** registrare l'evento come elaborato solo a elaborazione riuscita (oppure eliminare il record in caso di errore, prima di rilanciare), mantenendo l'elaborazione idempotente (già lo è: rilegge lo stato da Stripe) e restituendo errore a Stripe così da riprovare.

### S5 – Ordini senza pagamento da ospiti

- **Prova (utente non autenticato):** `cash` → ordine creato con `status=queued` (**già in coda di produzione**), `paymentStatus=pending`; `po` e `invoice` → ordine creato in `awaiting_payment`. `comped` correttamente rifiutato (403). `quote` crea un ordine `awaiting_review`/`quote` (comportamento coerente con la revisione manuale).
- **Causa:** `paymentMethod` accetta sette valori e solo `comped` ha un controllo di ruolo; inoltre l'ordine `cash` salta direttamente in coda.
- **Conseguenze:** chiunque può riempire la coda di produzione con ordini non pagati, o creare ordini spazzatura.
- **Correzione consigliata:** elenco di metodi consentiti in base al ruolo: ospiti e clienti solo `card` (e `quote` per la revisione manuale); `cash`, `po`, `invoice`, `comped` solo per amministratori. Lo stato `queued` solo con `paymentStatus=paid`. PayPal resta disattivato.

### S6 – Caricamenti dei clienti pubblici

- **Prova:** `resolveUploadVisibility` assegna sempre `public` a chi non è admin/staff (anche se chiede `private`); un modello con quella visibilità compare nel catalogo anonimo `GET /api/models`.
- **Causa:** `lib/upload-visibility.ts` (`if (!canChoose) return 'public'`), usato da `app/api/upload/route.ts` riga 357. Il progetto nasce come catalogo pubblico.
- **Conseguenze:** i modelli 3D dei clienti (proprietà intellettuale) sono pubblicati senza consenso.
- **Correzione consigliata:** i caricamenti dei clienti sono sempre `private` (visibili a proprietario e amministratori); solo l'amministratore può pubblicare un elemento. In un'installazione con dati esistenti serve anche una migrazione che riporti a `private` i modelli dei non-admin.

---

## Correzione S1 (Fase 1B) – stato: corretto e verificato

### Cosa è stato cambiato

| File | Modifica |
|---|---|
| `lib/file-access.ts` (nuovo) | Politica di accesso ai file, **negato per impostazione predefinita**; validazione del percorso; controllo del percorso reale (anti collegamenti simbolici); `canAccessModelFiles` per i modelli |
| `app/files/[...path]/route.ts` | Riscritta: valida il percorso → decide l'accesso → solo dopo legge il disco. Anonimo: 401; utente loggato non autorizzato: 404; intestazioni di cache e `nosniff` |
| `app/api/models/[id]/download.zip/route.ts` | Stessa regola di accesso (prima non controllava nulla: un anonimo poteva scaricare i file originali di **qualsiasi** modello, anche privato) |
| `lib/storage.ts`, `lib/public-path.ts`, `.env.example`, wiki | Eliminata la modalità CDN (`FILES_BASE_URL`): reindirizzava **prima** di qualsiasi controllo, aggirando la protezione |
| `tests/security/s1-files-access.sec.ts` | I test della vulnerabilità sono diventati 19 test di regressione (senza `todo`) |

### Regole di accesso

| Risorsa | Chi può leggerla |
|---|---|
| `<idUtente>/…` (modelli, caricamenti grezzi, avatar, immagini dei commenti) | Il proprietario; staff e admin |
| Copertina, galleria e file del viewer di un modello **pubblico o "non in elenco"** (cartelle `models`, `thumbnails`, `gallery`) | Tutti (cache pubblica di 1 ora). Caricamenti grezzi e avatar non sono mai pubblici |
| `orders/<idOrdine>/…` (ricevute, report) | Il cliente dell'ordine; staff e admin. Gli ordini ospite: solo staff/admin |
| Miniature/file collegati alle righe dei propri ordini | Il cliente dell'ordine |
| `merch/…` | Tutti (immagini del negozio caricate dall'admin) |
| `failure-photos/…`, `zips/…` e cartelle sconosciute | Solo staff/admin |
| `backups/…` | **Solo admin** (nemmeno lo staff) |
| Tutto il resto | Nessuno |

Percorsi rifiutati prima di toccare il disco: segmenti vuoti, `.`/`..`, nomi che iniziano con `.`, barre e controbarre dentro un segmento, caratteri di controllo, più di 12 livelli. Dopo la decisione, il percorso reale (collegamenti simbolici risolti) deve restare dentro la cartella di archiviazione.

File privati: `Cache-Control: private, no-store` e `Vary: Cookie`; tutti: `X-Content-Type-Options: nosniff`; i tipi sconosciuti sono scaricati come allegato.

### Verificato (con prove eseguite)

- 19 test di regressione S1 passano con la correzione; **contro il codice originale 14 su 19 falliscono**, quindi i test rilevano davvero il problema (i 5 che passano sono controlli e casi di accesso legittimo).
- Anonimo, altro cliente, proprietario, staff, admin: matrice completa sui file privati, modelli pubblici/non in elenco, ricevute, ordini ospite, backup, cartelle interne.
- Traversal: `../`, `%2e%2e`, `..%2f` (la variante che raggiungeva il file fuori cartella), doppia codifica, controbarra, file nascosti, byte nullo, collegamento simbolico verso l'esterno.
- Nessun "oracolo di esistenza": un percorso inesistente e uno vietato danno la stessa risposta all'anonimo.
- La variabile `FILES_BASE_URL` impostata non produce più reindirizzamenti né URL esterni.
- `download.zip`: modello privato → 404 ad anonimo e altri clienti; 200 a proprietario e staff; i modelli pubblici restano scaricabili.
- **Server reale** (`next start`, build di produzione, database di prova, cookie di sessione firmati) con `curl`: tutte le righe della matrice come previsto; `/files/models/..%2f..%2f…` ora dà 404 anche all'admin.
- **Browser reale** (Chromium): il viewer 3D carica il modello pubblico da anonimo (200) e quello privato dal proprietario (200); all'anonimo sul modello privato viene negato (401). Le copertine dei modelli pubblici si vedono nell'elenco `/discover` da anonimo e da loggato.
- `npm run lint`, `npm run typecheck`, `npm run build`: OK. `npm test`: 203 superati e gli stessi 2 fallimenti preesistenti (nessuno nuovo). `test:api` 7/7, `test:contracts` 14/14.

### Non verificato / richiede ulteriori controlli

- Le altre aree (S2–S7) restano aperte; i loro test sono ancora marcati `todo`.
- Navigazione completa a mano di tutte le pagine (profilo, ordini cliente, amministrazione) con file reali: provate solo `/models/<id>` e `/discover`. Le pagine che mostrano avatar o immagini dei commenti di altri utenti non li mostreranno più agli altri (funzioni social, da disattivare comunque).
- Eventuale app mobile (iOS): non ho trovato supporto per autenticazione senza cookie su `/files`; se esiste un client che scarica file senza cookie di sessione, smetterà di funzionare. Non verificato.
- Percorsi salvati nel database con controbarre (installazioni Windows) non verranno riconosciuti come pubblici: nessun impatto su Linux.
- Download di un backup dall'interfaccia amministrativa: la regola è provata con test e `curl`, non con un clic nell'interfaccia.
- Intervalli di byte (`Range`) e richieste `HEAD` non provati.

### Rischi residui

1. **S7 – l'API dei dettagli del modello** (`GET /api/models/[id]`) restituisce a chiunque i dati di un modello privato, il percorso del file e **l'e-mail del proprietario**. Il test S6c lo dimostra. Non corretto qui: da trattare con S6 (visibilità).
2. **Modelli pubblici e "non in elenco"**: i file originali sono pubblici per scelta di progetto del catalogo originale (anche tramite `download.zip`). Dopo S6 saranno pubblici solo i modelli pubblicati dall'admin.
3. **Backup dentro `STORAGE_DIR/backups`** per impostazione predefinita. Ora solo l'admin li legge, ma conviene spostarli fuori con `BACKUP_DIR` (decisione operativa per la Fase 7).
4. Lo staff può leggere tutti i file dei clienti (serve alla produzione). Se non desiderato, restringere in seguito.
5. I file privati non sono memorizzati dal browser (`no-store`): ogni apertura del viewer riscarica il modello. È la scelta più sicura; se pesa, si può usare un controllo con ETag.
6. Piccolo costo prestazionale: 1–3 interrogazioni al database per file richiesto. Trascurabile ai volumi attesi; da rimisurare se le gallerie crescono.
7. Gli ordini ospite non potranno aprire la propria ricevuta via `/files` (nessuna identità): servirà un link sicuro, da progettare con S2/S3.

---

## Correzione S6 e S7 (Fase 1B) – stato: corretto e verificato

Principio: **il servizio è una stampa su commissione, non un marketplace.** Il progetto di un cliente è privato; solo i modelli che appartengono a un account del negozio (admin/staff) possono essere mostrati ad altri.

### La regola (un solo posto: `lib/model-access.ts`)

| Chi / cosa | Può vedere un modello |
|---|---|
| Modello di un **cliente** (qualunque valore salvato in `visibility`, compreso "public" o "unlisted") | Proprietario, staff, admin |
| Modello di un account **del negozio**, `public` o `unlisted` | Tutti |
| Modello di un account del negozio, `private` | Proprietario, staff, admin |

- Il consenso: nessun progetto di un cliente può diventare pubblico senza il suo consenso esplicito. **Non esiste alcun meccanismo di consenso** (il catalogo pubblico verrà eliminato), quindi oggi **nessuno, nemmeno l'amministratore, può pubblicarlo**: il server risponde 409. Se un giorno servisse, andrà progettata una funzione esplicita richiesta dal proprietario.
- I record già nel database marcati "public" restano protetti **subito**, perché la regola non si fida del valore salvato per i modelli dei clienti. Nessun dato viene cambiato o cancellato.
- S1 (`lib/file-access.ts`) usa questa stessa regola, senza duplicarla.

### Cosa è stato cambiato

| Area | Modifica |
|---|---|
| `lib/viewer.ts`, `lib/model-access.ts` (nuovi) | Utente della richiesta e politica centrale (funzioni e filtri Prisma) |
| `lib/model-detail.ts` (nuovo) | Caricamento dei dettagli del modello per l'utente corrente. **L'autorizzazione viene prima di qualsiasi lettura/scrittura.** Non vengono mai restituiti: e-mail del proprietario (solo staff), revisioni (solo proprietario/staff), dati di produzione di altri clienti e modelli GCODE (solo staff) |
| `app/api/models/[id]/route.ts` | GET sottile sopra il caricatore; risposta `private, no-store`; PATCH: 404 uniforme |
| `app/models/[id]/page.tsx` | **Non richiama più la propria API** lato server (senza cookie e con cache dati condivisa): usa il caricatore direttamente con l'utente della richiesta |
| Upload | Tutto è **privato** per impostazione predefinita (form e server). **Il caricamento senza account non è più possibile** (vedi decisioni aperte). |
| `quote`, `manufacturability-report`, `comments`, `like`, `download.zip` | Controllo di visibilità; un modello privato risponde 404 identico a un ID inesistente |
| `revisions`, `images`, `images/[imageId]`, `cover`, PATCH modello | Prima: "403 Vietato" per un modello altrui e "404" per uno inesistente (permetteva di scoprire quali ID esistono). Ora 404 identico |
| Elenchi: `/api/models`, `thumbs`, `featured`, home, collezioni, prodotti, profilo `/u/<slug>`, "mi piace", discendenza/remix | Mostrano solo modelli pubblicati del negozio (un profilo mostra tutto solo al proprietario/staff). L'e-mail non è più usata come nome visibile |
| Checkout | Un modello di un cliente è ordinabile solo dal suo proprietario; il negozio resta ordinabile da tutti |
| Admin `PATCH /api/admin/models/[id]` | Rifiuta (409) di rendere pubblico/non in elenco un modello di un cliente |
| `scripts/privatize-customer-models.js` (`npm run privacy:privatize-models`) | Pulizia dei record esistenti, vedi sotto |

### Record già presenti nel database

La protezione è già attiva senza toccare i dati. Per allineare il database a ciò che la regola impone:

```bash
node scripts/privatize-customer-models.js            # PROVA: riepiloga, non modifica nulla (e-mail mascherate)
node scripts/privatize-customer-models.js --apply    # scrive il registro delle modifiche, poi imposta 'private'
```

- Cambia **solo** la colonna `visibility` dei modelli di clienti, **solo** in `private`. Nessuna cancellazione. I modelli del negozio non vengono toccati.
- Prima di applicare salva un file JSON con l'elenco (`id`, proprietario, valore precedente) in `$BACKUP_DIR` oppure `$STORAGE_DIR/backups` (cartella leggibile solo dall'admin).
- Ripetibile (se non c'è nulla da fare lo dice).
- Verificato con un test sul database di prova (prova, applicazione, registro, nessuna cancellazione, ripetizione). **Non è stato eseguito su un database reale** (non ne ho accesso): prima di usarlo in produzione fare un backup e lanciare la modalità prova.

### Verificato (con prove eseguite)

- **Test di regressione** (15 per S6/S7 + 20 per S1): matrice anonimo / proprietario / altro cliente / staff / admin su dettagli, elenchi, miniature, in evidenza, prodotti, discendenza, preventivo, report, commenti, `download.zip`, checkout e file. Includono i record "vecchi pubblici" di clienti e il confronto "ID privato = ID inesistente". **Contro il codice precedente 12 di 14 test S6/S7 falliscono** (e 14 di 19 quelli S1).
- **Server reale** (build di produzione, database di prova, sessioni firmate, `curl`): 
  - dettagli modello: anonimo/altro → 404 identico all'ID inesistente; proprietario e admin → 200; modello del negozio → 200 a tutti;
  - nessuna e-mail nelle risposte per anonimo, altro cliente e proprietario (solo l'admin la vede);
  - elenchi pubblici: 0 modelli di clienti;
  - pagine `/models/<id>` e `/u/<slug>`: nessun titolo di modelli privati a anonimi e altri clienti;
  - gestione (PATCH, immagini, revisioni) da altro cliente: stesso 404 dell'ID inesistente;
  - regola amministratore: 409 per pubblico e non in elenco su un modello di un cliente; 200 per privato e per il modello del negozio;
  - **upload reale**: anonimo → 401; cliente che chiede `visibility=public` → modello salvato `private`, 404 per altri, 401 sul file per l'anonimo, 200 per il proprietario;
  - ordine (richiesta di preventivo) del **proprio modello privato** → 200; altro cliente/anonimo sul modello privato → 404; modello del negozio → 200.
- **Browser reale** (Chromium): il proprietario apre il proprio modello privato, il **viewer 3D** carica il file (200) e il **configuratore** ottiene il preventivo (200); altro cliente e anonimo non vedono nulla; da anonimo il modello del negozio mostra viewer e preventivo.
- `npm run lint`, `typecheck`, `build`: OK. Test `test:api` 7/7, `test:contracts` 14/14. S1 ancora corretta (20/20 e prove su server reale).
- Test esistenti aggiornati di proposito (descrivevano il vecchio catalogo pubblico): forma del filtro nelle miniature, `model-visibility` (2 test), `upload-visibility`. Restano i 2 fallimenti già presenti nell'originale; nessun fallimento nuovo.

### Non verificato / richiede ulteriori controlli

- **Aggiunta al carrello con browser**: nel mio ambiente il pulsante "Save to cart" resta disattivato (richiede la scelta di un colore, la cui tavolozza viene da un servizio di inventario non configurato). Succede **in modo identico** sul modello del negozio da anonimo, quindi non dipende da questa modifica, ma il percorso carrello → checkout con colori reali non è stato provato. Ho verificato invece, via API, l'ordine del proprio modello privato.
- Percorsi felici di scrittura con file reali (nuova revisione, immagini, cambio copertina, commenti, "mi piace") per il proprietario: ho modificato solo il controllo di accesso; verificati i casi negativi (altro cliente → 404) e la lettura del proprietario, non ogni scrittura.
- Dati di produzione reali: non esaminati.
- Altre pagine dell'area cliente e dell'amministrazione non percorse una per una.

### Rischi residui e decisioni aperte

1. **Caricamento senza account disattivato (decisione da confermare).** Prima tutti i caricamenti anonimi finivano in un unico utente condiviso (`anonymous@local`) a cui nessuno può accedere: con modelli privati chi caricava senza registrarsi non avrebbe più potuto rivedere il proprio modello. Per sicurezza ora serve l'accesso. Se si vuole mantenere il percorso "carica subito, registrati dopo", va progettato un account ospite (Fase 2); fino ad allora è bloccato. I modelli già caricati dall'utente anonimo restano privati (visibili a staff/admin) e non vengono cancellati.
2. **Il consenso alla pubblicazione non esiste**: scelta voluta; nessun modello di cliente è pubblicabile.
3. **Funzioni social ancora presenti** (profili `/u/<slug>`, commenti, "mi piace", achievement): ora filtrate dalla regola, ma i profili restano visibili agli utenti registrati (nome e recapiti che l'utente stesso ha inserito). Da eliminare nella fase di semplificazione.
4. L'interfaccia amministrativa offre ancora "public/unlisted" per i modelli dei clienti: il server rifiuta con un messaggio (409), ma l'opzione è solo cosmetica da nascondere.
5. **Staff e admin vedono tutti i modelli e le e-mail dei clienti** (serve alla produzione).
6. Il percorso del file di un modello pubblicato del negozio è relativo e resta nella risposta (serve al viewer); è protetto da S1 e riguarda solo modelli del negozio.
7. Prestazioni: la regola aggiunge 1–3 interrogazioni per richiesta su un modello; la pagina modello non usa più la cache dati condivisa (ogni visita legge dal database ma si evita una richiesta HTTP interna). Da rimisurare con dati reali.
8. Il percorso `POST /api/models/[id]/gcodes` (servizio PrintLab, protetto da segreto) distingue "modello inesistente" da "trovato": accessibile solo a chi possiede il segreto di servizio.

---

## Correzione S5 (Fase 1B) – stato: corretto e verificato

### Regole

1. **Metodi di pagamento per ruolo** (decisi dal server in base alla sessione, mai dalla richiesta):
   - ospiti, clienti **e staff**: solo **carta (Stripe)** o **richiesta di preventivo**;
   - solo gli **amministratori**: `cash`, `invoice`, `po`, `comped` (senza addebito) e PayPal (disattivato in pratica).
   Un metodo non consentito riceve 403 con l'elenco dei metodi permessi. Valori "simili" (`CASH`, ` cash`) sono rifiutati dalla validazione (400).
2. **Cancello di produzione.** Un ordine entra in produzione (`queued`, `printing`, `post_process`, `shipped`, `completed`) solo se il pagamento è **verificato in modo rigoroso** – `paid` (confermato da Stripe) oppure `free` (ordine senza addebito creato da un admin) – **oppure** se un **amministratore** lo ha **autorizzato esplicitamente**. `processing`, `requires_capture`, `pending`, `failed`, `quote`… non bastano.
3. **L'autorizzazione** è registrata nell'ordine (`metadata.productionAuthorization`: chi, quando, motivo) e nel registro di audit. Non cambia lo stato di pagamento: l'ordine resta "non pagato" in contabilità.
4. **Preventivi**: una richiesta di preventivo (`quote`) resta `awaiting_review`, non è un ordine pagato e non avvia la produzione, nemmeno se lo stato di pagamento fosse forgiato. L'approvazione di un preventivo da parte di un'organizzazione porta l'ordine a `awaiting_payment`, non in produzione.

Modulo unico: `lib/order-payment-policy.ts`. Nessuna dipendenza nuova.

### Dove è applicato (tutte le transizioni)

| Transizione | Comportamento |
|---|---|
| Checkout (creazione ordine) | Metodi per ruolo; stato iniziale dal pagamento verificato: carta confermata → `queued`; carta in elaborazione / autorizzata → `awaiting_payment`; `cash`/`po`/`invoice` → `awaiting_payment`; `quote` → `awaiting_review`. Totale zero di un non-admin (es. sconto 100%) → 400 |
| Webhook Stripe (sincronizzazione del PaymentIntent) | Un ordine `awaiting_payment` passa a `queued` **solo** quando Stripe conferma `paid` (prima non succedeva) |
| Admin: cambio stato (`PATCH /api/admin/orders/[id]/status`) | Verso uno stato di produzione senza pagamento verificato → **409** `PAYMENT_NOT_VERIFIED`. Con `authorizeUnpaid` solo un **admin** (staff: 403), con motivo; campi forgiati nel corpo (`paymentStatus`, `metadata`) sono ignorati. L'interfaccia mostra una finestra di conferma esplicita |
| Admin: creazione ordine (`POST /api/admin/orders`) | Stesso cancello; un ordine a zero o con autorizzazione solo da admin; l'interfaccia ha una casella "Authorize production without a verified payment" |
| Approvazione preventivo di organizzazione | Porta a `awaiting_payment` se non pagato |
| Sincronizzazione OrderWorks (servizio esterno) | Non può spostare un ordine non idoneo in produzione |
| Callback PrintLab (servizio esterno) | Può riportare lo stato di avanzamento ma non avviare la produzione di un ordine non idoneo |
| Assegnazione stampante (manuale) | 409 se l'ordine non è idoneo |
| Auto-coda stampanti | Considera solo ordini idonei (difesa in profondità per righe vecchie) |
| Invio a PrintLab | Rifiutato (409) se l'ordine non è idoneo |
| Interfaccia di checkout | Cliente: solo carta e preventivo; admin: tutti i metodi (staff non vede più "senza addebito", che il server già rifiutava) |

Per poter testare le route amministrative, `requireRole` usa ora la stessa funzione `viewerGuards` (stesse regole di ruolo di prima). Nel checkout l'identità dell'utente arriva dalla stessa funzione.

### Ordini già presenti nel database

La protezione vale subito per le nuove transizioni e per l'auto-coda. Per riportare "in attesa di pagamento" gli ordini rimasti in coda senza pagamento (es. i vecchi `cash`):

```bash
node scripts/hold-unpaid-orders.js            # PROVA: elenca, non modifica nulla
node scripts/hold-unpaid-orders.js --apply    # scrive il registro delle modifiche, poi 'queued' -> 'awaiting_payment'
```

Sposta **solo** gli ordini ancora `queued` senza pagamento verificato né autorizzazione. Quelli già in stampa/spediti/completati senza pagamento vengono **solo segnalati** (serve una decisione umana). Non cancella e non annulla nulla. Verificato su database di prova; **non** eseguito su dati reali.

### Verificato (con prove eseguite)

- **31 test di regressione S5** (e 7 per l'ordine di stato iniziale): politica; checkout per ospite / cliente / staff / admin con 5 metodi vietati ciascuno (403, nessun ordine creato); tentativi di aggiramento (campi `isAdmin`, `role`, `paymentStatus`, `status`, `adminFreeCheckout`, autorizzazione forgiata, varianti del nome del metodo); carta confermata / in elaborazione / autorizzata; preventivi; totale zero; cambio stato admin su tutti gli stati di produzione (ospite 401, cliente 403, staff 409, admin 409, autorizzazione dello staff 403, autorizzazione dell'admin con registrazione); creazione ordine admin; webhook (elaborazione / pagamento fallito / riuscito); sincronizzazione OrderWorks; callback PrintLab; assegnazione stampante; auto-coda; invio a PrintLab; script sui dati esistenti. **Contro il codice precedente 26 su 31 falliscono** (alcuni anche perché le route admin non erano testabili).
- **Server reale** (build di produzione, sessioni firmate, database di prova): ospite/cliente/staff → 403 su `cash`, `po`, `invoice`, `comped` (anche con campi forgiati); preventivo → `awaiting_review/quote`; admin → ordine a zero esplicito; cambio stato come da tabella (409 / 403 / 200 con autorizzazione registrata, motivo incluso); approvazione preventivo → `awaiting_payment`.
- **Browser reale (Chromium)**: il cliente vede solo carta e preventivo (anteprima del preventivo 200, nessun errore); l'admin vede tutti i metodi; sul pannello admin, spostare un ordine non pagato in "Printing" mostra la finestra di conferma e, accettando, registra l'autorizzazione.
- `lint`, `typecheck`, `build`: OK. `npm test` 205/207 (solo i 2 fallimenti preesistenti); `test:api` 7/7; `test:contracts` 14/14. Suite di sicurezza: 72 test, 68 superati, 4 `todo` (S2, S3, S4 ancora aperti). S1, S6, S7 ancora corretti (test passano).
- Test esistenti aggiornati di proposito: `order-status-selection` (descriveva "cash a ritiro entra in coda").

### Non verificato / richiede ulteriori controlli

- **Carta reale con Stripe**: tutto è provato con Stripe simulato. Il comportamento con le chiavi vere di prova va riprovato in S2/S3.
- Pagina di checkout **con ospite**: la pagina richiede il login (reindirizza), quindi non ho potuto aprirla da ospite; l'API per gli ospiti è invece coperta da test e prove HTTP.
- Il percorso completo "aggiungi al carrello → checkout → conferma" con colori reali non è stato eseguito (la tavolozza dei colori richiede un servizio non configurato).
- **Ordini già presenti in produzione reale**: non esaminati; usare lo script in modalità prova.
- Rimborsi/contestazioni dopo l'ingresso in produzione: un ordine pagato che viene poi rimborsato **non** torna indietro automaticamente (fuori ambito S5).
- Il percorso PayPal è stato solo limitato agli admin, non analizzato.

### Rischi residui e scoperte

1. **Il checkout di un amministratore è sempre un ordine "senza addebito"** (comportamento già esistente): qualunque metodo scelga, il totale è 0, lo stato è `free` e l'ordine entra in produzione. È un'azione esplicita dell'admin e l'ordine lo riporta (`adminFreeCheckout`), ma significa che per un ordine **a pagamento** inserito da un admin si usa la creazione ordine (`/api/admin/orders`), che richiede l'autorizzazione esplicita.
2. **Scoperta preesistente (non corretta qui):** `PATCH /api/admin/orders/[id]/status` risponde **400 "StockWorks is not configured"** per `shipped`/`completed` quando StockWorks non è configurato, **dopo** aver già salvato lo stato. Il consumo di inventario non è opzionale. Da sistemare nella semplificazione, perché il negozio non userà StockWorks.
3. Gli ordini con totale 0 creati da un admin, e quelli autorizzati, non hanno un pagamento: la contabilità deve distinguerli dallo stato `paid`.
4. La promozione `awaiting_payment` → `queued` nel webhook Stripe riguarda il flusso toccato da S4 (affidabilità del webhook): verrà riesaminata lì.
5. Lo staff non può autorizzare produzione senza pagamento né usare metodi privilegiati, per scelta ("amministratori autorizzati"). Se si vuole concedere allo staff la sola autorizzazione, è una modifica di una riga.

---

## Correzione S4 (Fase 1B) – stato: corretto e verificato

### Il difetto

Il gestore registrava l'evento in `StripeEvent` **prima** di elaborarlo. Se l'elaborazione falliva (Stripe non raggiungibile, errore del database…), il nuovo tentativo di Stripe trovava l'evento già registrato, veniva giudicato "duplicato" e scartato: l'ordine pagato restava "non pagato". Inoltre non c'era alcuna protezione se due richieste identiche arrivavano insieme, né se due eventi diversi dello stesso pagamento arrivavano fuori ordine.

### La regola che lo risolve (solo PostgreSQL, nessuna coda, nessuna dipendenza)

**La registrazione dell'evento e l'aggiornamento degli ordini vengono scritti nella STESSA transazione.**

| Situazione | Cosa succede |
|---|---|
| L'elaborazione fallisce | Rollback totale: nessuna traccia, risposta 500, Stripe riprova e il nuovo tentativo **elabora davvero** l'evento |
| L'elaborazione riesce | Registrazione + ordini vengono confermati insieme; ogni invio successivo è un duplicato innocuo (200) |
| Due richieste identiche contemporanee | La seconda `INSERT ... ON CONFLICT DO NOTHING` **attende** la prima: se questa conferma → duplicato (nessun lavoro doppio, una sola lettura da Stripe); se questa fallisce → la seconda esegue il lavoro |
| Due eventi diversi dello stesso pagamento, in contemporanea o fuori ordine | Le righe d'ordine sono bloccate (`SELECT … FOR UPDATE`) **prima** di leggere da Stripe lo stato *attuale*: gli eventi si applicano uno dopo l'altro e l'ultimo scrive lo stato più recente. Un evento vecchio arrivato in ritardo non può far regredire un ordine |
| Effetti esterni | La lettura da Stripe è di sola lettura (con timeout di 10 s). Le ricevute PDF si generano **dopo** il commit, sono idempotenti e non influenzano l'esito |

### Risposte a Stripe

| Caso | HTTP |
|---|---|
| Elaborato / già elaborato in precedenza / evento non pertinente | **200** (`outcome`: `processed` / `duplicate` / `ignored`) |
| Firma assente, errata o corpo manomesso | **400** (nulla viene usato né salvato) |
| Elaborazione fallita (recuperabile) | **500** `{"received":false,"error":"processing_failed","retry":true}` — senza dettagli interni; l'errore completo va nel log e nelle metriche |

Verifiche sull'evento: firma su corpo grezzo (come prima); gli identificativi usati (`pi_…`, `in_…`) sono controllati nel formato; gli eventi test su chiave live (o viceversa) sono ignorati; i tipi non gestiti sono riconosciuti (200) ma **non salvati** e senza chiamate a Stripe.

**Eventi da attivare nell'endpoint Stripe** (gli altri sono ignorati ma inutili): `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `invoice.sent`, `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`.

### File

| File | Modifica |
|---|---|
| `lib/stripe-webhook.ts` (nuovo) | Gestore idempotente: classificazione e validazione dell'evento, transazione, esiti, log e metriche (`stripe_webhook_events_total`, `stripe_webhook_failures_total`) |
| `lib/stripe-payments.ts` | La sincronizzazione ordini–Stripe ora lavora dentro una transazione con blocco delle righe (`applyPaymentIntentToOrders`, `applyInvoiceToOrders`); le funzioni usate dagli strumenti admin e dai rimborsi (`syncStripePaymentIntent`, `syncStripeInvoice`) sono transazionali anch'esse. Il cancello S5 (solo pagamento verificato libera la produzione) è invariato |
| `app/api/stripe/webhook/route.ts` | Risposte HTTP come da tabella; errore generico, dettagli solo nel log |
| `lib/orders.ts` | **Unica modifica fuori dal webhook** (vedi sotto): riconciliazione con Stripe subito dopo la creazione dell'ordine |

### Perché si tocca `lib/orders.ts` (dipendenza tecnica indispensabile)

Il webhook di Stripe spesso arriva *prima* che il browser abbia creato l'ordine (l'ordine nasce solo alla conferma del browser: è il problema S3, ancora aperto). In quel caso l'evento non trova ordini da aggiornare e viene correttamente riconosciuto (200). Ma se in quel brevissimo intervallo lo stato del pagamento cambia (es. `processing` → `succeeded`), l'ordine verrebbe creato con lo stato vecchio e nessun altro evento lo correggerebbe. Per chiudere il buco, subito dopo la creazione dell'ordine si rilegge lo stato da Stripe (best-effort: se fallisce non blocca l'ordine, e i nuovi tentativi del webhook coprono il resto). Costo: una lettura Stripe in più per ordine con carta. Verrà assorbita dalla migrazione a Stripe Checkout (S2/S3).

### Verificato (con prove eseguite)

- **18 test di regressione S4** (Stripe simulato, database isolato): firma mancante/errata/manomessa; eventi non pertinenti, id malformati (anche tentativo di iniezione), evento live su chiave test; elaborazione atomica; duplicati ripetuti (nessuna nuova lettura, ordine non toccato); **fallimento → nessuna traccia → il nuovo tentativo dello stesso evento elabora davvero** (il difetto S4); rollback totale dopo scritture parziali; fallimenti ripetuti; **5 richieste identiche contemporanee → 1 elaborazione, 4 duplicati, 1 sola lettura da Stripe**; **vincitore che fallisce → la richiesta in attesa subentra**; eventi diversi contemporanei che convergono sullo stato più recente; evento vecchio in ritardo che non fa regredire; rimborsi e contestazioni; fatture (aperta non libera, pagata libera, fallimento + nuovo tentativo, duplicato); cancello S5 (processing / fallito / annullato / solo autorizzato non liberano la produzione); evento che arriva prima dell'ordine + riconciliazione alla creazione; riconciliazione che non blocca la creazione se Stripe non risponde; strumenti admin transazionali. **Contro il codice precedente 12 su 18 falliscono.**
- **Server reale** (build di produzione, database di prova, API di Stripe simulata a livello HTTP): firma assente/errata → 400; evento non pertinente → 200 ignorato; errore temporaneo → **500 senza dettagli interni**, 0 eventi registrati, ordine invariato; nuovo tentativo dello stesso evento → elaborato (ordine `queued`+`paid`), invio ulteriore → duplicato; **6 richieste identiche contemporanee → 6×200 (1 elaborato + 5 duplicati), 1 lettura da Stripe, 1 evento registrato**; prima richiesta che fallisce → `200,500`, ordine pagato, 2 letture, 1 evento; evento `processing` → ordine in attesa, poi `succeeded` → in coda. Log: nessun deadlock né timeout; i soli 2 errori sono i fallimenti simulati.
- `lint`, `typecheck`, `build`: OK. `npm test` 205/207 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14. Suite di sicurezza: 89 test, 86 superati, 3 `todo` (S2, S2b, S3: ancora aperti). S1, S5, S6, S7 ancora corretti.
- Test aggiornato: S5 "carta confermata" ora accetta `authorized` o `requires_capture` (due nomi dello stesso stato non verificato: dopo la riconciliazione l'ordine riporta il nome usato dalla sincronizzazione Stripe).

### Non verificato / richiede ulteriori controlli

- **Stripe reale**: tutto è provato con Stripe simulato (anche l'API a livello HTTP). Va riprovato con le chiavi di prova vere e con `stripe listen`/`stripe trigger` prima del lancio (S2/S3 e Fase 7).
- **Eventi registrati dal vecchio codice**: le righe di `StripeEvent` create prima di S4 possono corrispondere a eventi la cui elaborazione era fallita (e che oggi risulterebbero "duplicati"). Rimedio per un ordine sospetto: lo strumento admin `stripe-sync` (ora transazionale) oppure cancellare quella riga e usare "Resend" nel pannello Stripe. Non esaminati dati reali.
- **Pagamenti senza ordine** (browser chiuso dopo il pagamento): il webhook li riconosce (200) e scrive un avviso nel log (`processed_no_matching_order`), ma non esiste ancora una segnalazione o un ordine: è S3.
- **Eventi di Checkout Session** (`checkout.session.*`): non gestiti, arrivano con la migrazione S2/S3.

### Rischi residui

1. Durante l'elaborazione la transazione tiene una connessione al database e le righe d'ordine bloccate per la durata della lettura da Stripe (timeout 10 s, transazione al massimo 30 s). Richieste identiche in attesa occupano ciascuna una connessione: irrilevante ai volumi attesi, da tenere presente se il database ha pochissime connessioni.
2. Per ogni ordine con carta c'è una lettura Stripe in più alla creazione (riconciliazione). Se Stripe è lento, la creazione dell'ordine rallenta (non fallisce).
3. `StripeEvent` conserva il corpo di ogni evento gestito: tabella destinata a crescere; prevedere una politica di conservazione (es. 90 giorni) in Fase 6/7.
4. Rimborsi o contestazioni dopo l'ingresso in produzione non riportano l'ordine indietro (già annotato in S5).
5. Il campo `payment_intent` delle fatture dipende dalla versione dell'API Stripe configurata; invariato rispetto a prima.

## Correzione S2 + S3 (Fase 1B) – stato: IN CORSO, Passi 1, 2 e 3 di 7 completati

S2 (importo pagato non confrontato col totale) e S3 (pagamento senza ordine) **non sono ancora dichiarati corretti**: il nuovo percorso li chiude e il vecchio è bloccato in produzione (Passo 3), ma l'interfaccia usa ancora il vecchio e il vecchio ramo non è rimosso (Passi 4–6). I test `S2`, `S2b` e `S3` non sono più `todo`: dal Passo 3 sono test di regressione che passano. La causa e la soluzione sono nella sezione S2/S3 sopra; l'architettura approvata, le precisazioni dell'utente e il piano a passi sono in `docs/CHECKOUT-S2-S3.md`.

**Passo 1 – fondamenta, nessun cambio di comportamento** (commit sul ramo `claude/stampa3d-fase1`):

- Migrazione additiva (tabella `PaymentAttempt`, colonne su `PrintOrder` e `StripeEvent`), supporto EUR, estrazione del calcolo prezzi in `lib/checkout-quote.ts`, modulo imposte `lib/tax.ts`.
- **Verificato con prove eseguite:** snapshot di 72 scenari del checkout registrato dal codice prima della modifica e confrontato col nuovo (identici); il test sa fallire (due errori introdotti di proposito vengono rilevati); migrazione provata su un database con ordini esistenti (dati intatti, nessuna conversione); `lint`, `typecheck`, `build`; `npm test` 218/220 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; suite di sicurezza 101 test: 98 superati, 3 `todo` (S2, S2b, S3); S1, S4, S5, S6, S7 ancora verdi; prova su server reale con EUR e IVA "inclusive".
- **Non verificato:** migrazione su una copia di dati reali, Stripe reale, interfaccia con EUR nel browser.
- **Nota di sicurezza:** nessuna protezione esistente è stata indebolita; il percorso carta attuale (che accetta un `paymentIntentId` dal browser) è **ancora attivo e ancora vulnerabile a S2/S2b** fino al Passo 6.

**Passo 2 – ordine prima del pagamento e sessione Stripe** (dettagli e tabella dei casi in `docs/CHECKOUT-S2-S3.md`):

- Nuovi endpoint `POST /api/checkout/quote` e `POST /api/checkout/session`: totale calcolato e congelato dal server, ordine `awaiting_payment` creato prima della sessione Stripe, quattro livelli contro i duplicati (chiave del checkout univoca nel database, ordine unico per cliente e carrello, prenotazione del tentativo prima della chiamata, chiave di idempotenza di Stripe), nessuna transazione aperta durante la chiamata a Stripe, spedizione mai gratuita per dimenticanza, guardia fiscale e interruttore in produzione, limitazione delle richieste, token ospite con solo l'hash nel database.
- **Verificato con prove eseguite:** 43 test nuovi, controllati con 11 mutazioni (rompere di proposito una protezione fa fallire almeno un test) più una chiamata a Stripe dentro una transazione (rilevata); prova su server vero con lo SDK Stripe reale e la rete simulata (richieste simultanee, ripetizioni, campi forzati, altra origine); `lint`, `typecheck`, `build`; `npm test` 217/219 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; suite di sicurezza 144 test: 141 superati, 0 falliti, 3 `todo` (S2, S2b, S3). S1, S4, S5, S6, S7 ancora verdi; il confronto con lo snapshot del vecchio checkout è rimasto identico.
- **Trovato e chiuso nei nuovi endpoint:** con `BASE_URL` assente il server avrebbe usato l'intestazione `Host` come indirizzo per una chiamata interna (tavolozza colori) e per gli indirizzi di ritorno (SSRF / reindirizzamento). Nei nuovi endpoint tutto viene da `BASE_URL` (in produzione solo https). Il vecchio checkout conserva il difetto fino al Passo 6.
- **Non verificato:** Stripe reale (pagina ospitata, scadenza, carte, wallet); il riconoscimento del pagamento (webhook delle sessioni: Passo 3); le pagine del cliente e l'endpoint di stato (Passo 4).
- **Rischi residui di questo passo:** un ordine pagato non diventa ancora "pagato" (per questo l'interruttore `HOSTED_CHECKOUT_ENABLED` è spento in produzione); gli ordini non pagati si accumulano finché non li chiudono i Passi 3 e 5; per gli ospiti vale solo la chiave del browser contro i duplicati; l'indirizzo IP per la limitazione dipende dalla configurazione del proxy.

**Passo 3 – riconoscimento del pagamento e verifica unica** (dettagli in `docs/CHECKOUT-S2-S3.md`):

- Una sola verifica (`lib/payment-verification.ts`) per sessioni Checkout, PaymentIntent e fatture: pagato solo se il PaymentIntent è `succeeded`, legato a quell'ordine e a quel tentativo, con `amount` **e** `amount_received` uguali al totale e stessa valuta; ogni altra cosa lascia l'ordine non pagato e non rilasciato, con `paymentReviewReason`. L'ordine entra in produzione una volta sola (da `awaiting_payment`, senza motivo di controllo, con indirizzo di consegna accettabile).
- Il webhook è un indizio: lo stato si rilegge da Stripe fuori da ogni transazione; un **permesso per ordine** (45 s, con controllo di proprietà all'applicazione) impedisce che una lettura più vecchia sovrascriva una più recente senza supporre che gli stati vadano solo avanti. Eventi duplicati, simultanei e fuori ordine, errori di Stripe e di PostgreSQL: nessun pagamento perso, nessuna doppia produzione.
- Effetti dopo il pagamento (ricevuta, rapporto, inventario, PrintLab, notifiche) fuori dalla transazione, con segno per effetto, una sola esecuzione e riprova possibile.
- Il vecchio checkout con carta è bloccato in produzione (`LEGACY_CARD_CHECKOUT_ENABLED`), verifica importo e valuta e rifiuta un PaymentIntent già usato; S2, S2b e S3 sono regressioni. Cookie ospite con elenco fino a 5 ordini.
- **Verificato con prove eseguite:** 45 test nuovi + 11 di regressione (S2/S2b/S3) + fixture S4/S5 resi realistici (importo incassato); 24 mutazioni (rompere di proposito una protezione) tutte rilevate da almeno un test, con sorgenti ripristinati e confrontati; prova su **server reale** (`next start`, produzione, SDK Stripe reale con rete simulata a livello HTTP, webhook firmati): 53 verifiche superate; `lint`, `typecheck`, `build`; `npm test` 217/219 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; suite di sicurezza 195 test, 195 superati, 0 `todo`. S1, S4, S5, S6, S7 ancora verdi; snapshot del vecchio checkout identico.
- **Trovato e corretto nel passo:** (1) il percorso `payment_intent.*` di S4 promuoveva a `queued` senza confrontare l'importo (S2 valeva anche per il webhook); (2) il cookie ospite di un secondo ordine cancellava l'accesso al primo; (3) la scrittura dei metadati dell'ordine nel modo "leggi e riscrivi" (ricevute) poteva perdere modifiche concorrenti: ora passa da un blocco di riga (`lib/order-metadata.ts`). Rimane non protetta quella di `autoSubmitOrderToPrintLab` (preesistente).
- **Non verificato:** Stripe reale (carte, wallet, scadenza, firma con il segreto reale, rimborsi e contestazioni veri); più processi del server insieme; il recupero automatico degli effetti falliti (script del Passo 5).
- **Rischi residui:** vedi `docs/CHECKOUT-S2-S3.md` ("Non verificato / limiti", Passo 3) e `docs/PROGETTO.md` (punto 13 dell'elenco "prima del lancio").

**Passo 4.0 – interventi prioritari prima dell'interfaccia** (dettagli in `docs/CHECKOUT-S2-S3.md`, "Passo 4.0"):

- **Trovati e corretti (due modi di aggirare S5):** (1) la **ristampa** del cliente copiava tutti i metadati dell'ordine di origine, compresa una `productionAuthorization` dell'amministratore, e creava un ordine `queued` con il vecchio totale: ora è una richiesta di preventivo (`awaiting_review`, `quote`, nessuna eredità), la ristampa gratuita richiede un'autorizzazione dell'amministratore con motivo scritto; (2) il **webhook OrderWorks in ingresso** accettava come vero lo stato di pagamento, l'importo e i metadati (anche una `productionAuthorization`) dichiarati dal mittente, con il segreto anche nell'indirizzo: ora è spento in produzione per impostazione predefinita, il segreto è solo nelle intestazioni, gli ordini che crea non entrano mai in produzione da soli e non possono portare i nostri marcatori.
- **Rinforzato:** il permesso di sincronizzazione dei pagamenti usa l'orologio del database, ha un limite complessivo di lettura ed è provato con **processi veri** (esclusione, processo ucciso, processo congelato che si risveglia, raffica); l'API ordini del cliente restituisce solo un elenco consentito di campi (niente id Stripe, hash dell'accesso ospite, permesso di sincronizzazione, `metadata`).
- **Verificato con prove eseguite:** 25 test nuovi e 32 mutazioni (12 ristampa, 10 OrderWorks, 6 permesso, 4 API ordini) tutte rilevate; suite di sicurezza 220/220; `npm test` 217/219 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; `lint`, `typecheck`, `build`; server reale con due istanze: 21/21.
- **Non verificato:** Stripe reale, più macchine, dispositivi veri: elencati in `docs/CHECKLIST-PRELANCIO.md`, tutti "da eseguire".
- **Rischi residui:** vedi "Rischi residui" del Passo 4.0 (segreto condiviso tra tre integrazioni; scheda segnata pagata da un amministratore non registrata come autorizzazione; viste di produzione che mostrano `awaiting_review` come "in coda"; 11 punti che riscrivono i metadati dell'ordine senza blocco di riga).

**Passo 4.1 – stato dell'ordine per le pagine di pagamento** (dettagli in `docs/CHECKOUT-S2-S3.md`, "Passo 4.1"):

- Nuovo `GET /api/checkout/status`: lo stato di un ordine lo vede **solo** il proprietario o l'ospite con il token di quell'ordine; l'id dell'ordine, la raggiungibilità della pagina di conferma, un altro cliente, staff/amministratore, token di altri ordini, falsi o scaduti non bastano; ogni rifiuto è lo stesso 404; la risposta contiene solo numero ordine, stato, totale e valuta (mai dati personali, indirizzi, file, identificativi di pagamento, motivi di verifica), non è memorizzabile da nessuna cache (`no-store, private`, `Vary: Cookie`, `Referrer-Policy: no-referrer`) e il browser non può dichiarare un pagamento. Webhook in ritardo gestito chiedendo a Stripe (con freni e limiti propri); Stripe irraggiungibile non produce errori. Nel proxy è pubblico solo il percorso esatto `/checkout/success`.
- **Verificato con prove eseguite:** 13 test di sicurezza + 7 unitari + 1 sul proxy; 18 mutazioni tutte rilevate (due dopo aver rinforzato i test); suite di sicurezza 233/233; `npm test` 225/227 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; `lint`, `typecheck`, `build`; server reale con dati fittizi 36/36.
- **Non verificato:** Stripe reale, telefoni e browser veri, comportamento dietro il proxy/CDN di produzione, più istanze (checklist 1.5, 2.8, 2.9).
- **Rischi residui:** vedi "Non verificato / limiti (Passo 4.1)" in `docs/CHECKOUT-S2-S3.md` (in sintesi: l'IP per il limite è falsificabile ma esistono limiti per ordine e globale; fino a 4 s di "non completato" dopo il pagamento; effetti in secondo piano da recuperare al Passo 5).

## Non verificato / limiti (verifica 1.4)

- Il client Stripe è finto: i campi del PaymentIntent reale sono quelli documentati da Stripe, ma il comportamento reale va rivalutato con la modalità test di Stripe quando avremo le chiavi.
- Percorso PayPal non analizzato (resterà disattivato).
- L'upload è provato tramite la funzione che assegna la visibilità e il catalogo, non con un invio multipart completo.
- Non sono stati valutati: limitazione delle richieste, protezione CSRF sulle route di pagamento, sicurezza delle altre route admin. Rientrano nella revisione di Fase 6.
