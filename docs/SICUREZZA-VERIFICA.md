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
| S1 | `/files` senza autenticazione + uscita dalla cartella | **Confermato** (anche via HTTP) | Critica |
| S2 | Importo pagato non confrontato col totale | **Confermato** | Critica |
| S3 | Pagamento riuscito senza ordine | **Confermato** | Alta |
| S4 | Webhook non rielaborato dopo un errore | **Confermato** | Alta |
| S5 | Ordini senza pagamento da ospiti | **Confermato** | Alta |
| S6 | File dei clienti pubblici | **Confermato** | Alta (privacy) |

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

## Non verificato / limiti

- Il client Stripe è finto: i campi del PaymentIntent reale sono quelli documentati da Stripe, ma il comportamento reale va rivalutato con la modalità test di Stripe quando avremo le chiavi.
- Percorso PayPal non analizzato (resterà disattivato).
- L'upload è provato tramite la funzione che assegna la visibilità e il catalogo, non con un invio multipart completo.
- Non sono stati valutati: limitazione delle richieste, protezione CSRF sulle route di pagamento, sicurezza delle altre route admin. Rientrano nella revisione di Fase 6.
