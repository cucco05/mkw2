# Mappa delle dipendenze – attività 1.3

Analisi statica del commit `f83bee9` (529 file TypeScript/JS, ~60.600 righe in `app/`, `lib/`, `components/`).
Metodo: grafo degli import costruito con uno script esterno al repository + lettura mirata del codice.
**Nessun codice è stato modificato.** Le affermazioni sono basate sulla lettura del codice, **non** su prove eseguite, salvo dove indicato.

Legenda rischio: **Basso** = si può disattivare/eliminare senza toccare altro. **Medio** = servono piccole modifiche a file condivisi. **Alto** = parte del flusso di acquisto/autenticazione o utilità condivisa.

## 1. Nodi centrali (dove le funzioni si intrecciano)

| File | Righe | Moduli importati | Note |
|---|---|---|---|
| `app/api/checkout/route.ts` | 939 | 26 | Importa StockWorks, PrintLab, OrderWorks, PayPal, Discord, push, organizzazioni, ricevute, metriche |
| `app/api/models/[id]/route.ts` | 443 | 19 | Commenti, lineage, PrintLab, qualità creatore, anteprime |
| `app/api/upload/route.ts` | 708 | 17 | Discord, push, coda anteprime, model-intelligence |
| `lib/db.ts` / `lib/auth.ts` | – | usati da 178 / 80 file | Fondamenta: non toccare |

## 2. Funzioni ESSENZIALI (mantenere)

| Componente | File chiave | Rischio disattivazione | Note |
|---|---|---|---|
| Database, autenticazione, sicurezza richieste | `db`, `auth`, `proxy.ts`, `csrf`, `rate-limit`, `security-config` | Alto | Base di tutto |
| Upload, modelli, viewer 3D | `app/api/upload`, `stl`, `model-files`, `storage`, `ModelViewer`, `three`, `jszip`, `fast-xml-parser`, `busboy` | Alto | 3MF richiede `jszip` + `fast-xml-parser` |
| Prezzi | `pricing`, `cartPricing`, `currency`, `estimate-adjustments`, `printerProfiles` | Alto | Da adattare (EUR, stampanti da database) in Fase 3 |
| Ordini e checkout | `orders`, `order-status`, `app/api/checkout`, `stripe`, `stripe-payments`, `StripeEvent` | Alto | Da mettere in sicurezza (sezione 5) |
| Ricevute PDF | `lib/receipts/*` | Alto | Usato da `orders.ts` e `stripe-payments.ts` |
| Amministrazione base | `app/admin/*` (ordini, utenti, configurazione, env-check), `admin-audit` | Medio | Da alleggerire, non da rimuovere |
| Email | `mailer`, `emailVerification`, `nodemailer` | Medio | Necessaria per conferme |
| Backup/ripristino | `backups.js`, `scripts/backup*` | Medio | Da mantenere |
| Osservabilità leggera | `request-observability` (usato da 21 route), `observability-*`, `error-tracking` | Medio | Leggera; tenere |
| Controllo di stampabilità | `manufacturability-report`, `model-intelligence`, `feasibility-scorecard` | Medio | Utile per la "revisione manuale"; usata dal checkout |

## 3. Funzioni SUPERFLUE

| Gruppo | Dimensione | Chi lo importa dall'esterno | Disattivare (UI/config) | Eliminare codice | Raccomandazione |
|---|---|---|---|---|---|
| **PayPal** | 151 righe | 1 file (ramo in checkout) | Basso | Basso | Disattivare ora; eliminare con la ristrutturazione del checkout |
| **Discord** | 466 | 5 file (checkout, upload, register, invite) | Basso (già inattivo senza configurazione) | Basso-Medio | Disattivare; eliminare insieme a `tweetnacl` |
| **Notifiche push/PWA** | ~5 file | 10 file | Basso (inattivo senza chiavi VAPID) | Medio | Disattivare; eliminare più avanti con `web-push` |
| **Collezioni** | 5 file | 1 (`app/discover`) | Basso | Basso | Disattivare e poi eliminare |
| **Analisi flotta** (fleet, batch, material-optimization, demand-forecasting, failure-photo) | 1.586 | 6 (4 pagine admin + 2 lib) | Basso | Medio | Nascondere le pagine; `orientation-optimizer` e `assembly-grouping` sono usati da altri file |
| **Funzioni social** (commenti, like, achievement, profili pubblici, contributi, creator-quality, lineage, YouTube) | 1.642 | 30 file (route modelli, login, upload, download, admin) | Basso | **Medio** | Nascondere l'interfaccia ora; eliminare solo dopo aver tolto i riferimenti da 30 file |
| **Organizzazioni / workspace / approvazioni** | 1.625 | 13 file (checkout, `orders.ts`, presets) | Basso | **Medio** | Nascondere; eliminare dopo aver ripulito checkout e `orders.ts` |
| **Merch e prodotti da template** | – | 9 file | Basso | Medio | Nascondere |
| **StockWorks** (inventario esterno) | 4.185 | 19 file (checkout, models, admin ordini) | Basso (se non configurato, restituisce "non configurato") | **Medio** | Disattivare. Il checkout lo chiama anche via HTTP interno (vedi sezione 4) |
| **PrintLab** (controllo stampanti) | 1.502 | 16 file (checkout, models/[id], admin) | Basso | Medio | Disattivare; il checkout lo invoca in un blocco protetto da try/catch |
| **OrderWorks** (legacy) | 1.266 | 19 file | Basso | **Alto** | Vedi sezione 4: contiene utilità condivise |
| **Inviti utente** | 4 file | Discord, admin | Basso | Basso | Opzionale |

## 4. Elementi CONDIVISI da non rimuovere alla cieca

1. **`lib/orderworks-status.ts` (14 file, tra cui checkout e `stripe-payments`)** contiene `normalizePaymentStatus`, che serve ai pagamenti. Va spostato in un modulo neutro *prima* di eliminare OrderWorks.
2. **`app/api/jobs/_helpers.ts`** è importato da `lib/admin/queries.ts` ma sta dentro una route legacy.
3. **Checkout → StockWorks via HTTP:** `fetch(.../api/stockworks/filament-colors)` a ogni checkout. Se StockWorks è spento restituisce `null` e la validazione dei colori viene saltata (comportamento accettabile, ma è una chiamata inutile per richiesta).
4. **`stockworks-consumption`** è chiamato dalla route admin di cambio stato ordine; **`stockworks-client`** da `lead-time-estimator`; **`material-availability`** da `api/models`.
5. **Coda di elaborazione (`processing-jobs`, `model-preview-queue`, `image-queue`)**: usata da upload, modelli, revisioni, admin (15 file). BullMQ/Redis sono "opzionali" nella documentazione, ma il codice è intrecciato con l'upload. Non toccare prima di aver testato l'upload.
6. **`lib/production.ts` (34 KB, 11 importatori)** e la tabella `Printer`: servono alla flotta di stampanti (A1 mini). Da adattare, non eliminare.
7. **Schema Prisma:** le tabelle dei gruppi superflui (commenti, like, achievement, collezioni, organizzazioni, merch, push, ecc.) **vanno lasciate** finché non c'è una migrazione verificata. Nessuna modifica al database in Fase 1.

## 5. Dipendenze npm

| Pacchetto | Usato da | Azione possibile | Quando |
|---|---|---|---|
| `web-push` | `lib/push.ts` | Eliminare | Dopo rimozione push |
| `tweetnacl` | route Discord interactions | Eliminare | Dopo rimozione Discord |
| `@stripe/react-stripe-js`, `@stripe/stripe-js` | 2 file checkout | Eliminare se si passa a Stripe Checkout ospitato | Fase 4 |
| `archiver` | download ZIP dei modelli | Eliminare se non servono download pubblici | Con social |
| `heic-convert`, `exifr` | `image-processing` (immagini di profilo/commenti) | Valutare | Con social |
| `ioredis` | nessun import diretto (arriva con `bullmq`) | Probabilmente ridondante come dipendenza esplicita | Da verificare |
| `jsonwebtoken` + `jose` | due librerie JWT (`auth.ts` e `proxy.ts`) | Unificare su `jose` | Fase di sicurezza; rischio medio |
| `zxcvbn` | pagina account | Valutare (pacchetto voluminoso) | Dopo |
| `bullmq` | processing | Mantenere finché la coda esiste | Da decidere |
| `@lhci/cli` (dev) | Lighthouse | Eliminabile (solo sviluppo) | Opzionale |
| `jszip`, `fast-xml-parser`, `sharp`, `three`, `busboy`, `unzipper`, `nodemailer`, `qrcode`, `stripe`, `zod`, `bcryptjs`, `jose` | funzioni essenziali | **Mantenere** | – |

Le dimensioni reali dei pacchetti **non sono state misurate**: il vantaggio in peso va verificato prima di decidere.

## 6. Problemi di SICUREZZA emersi (da lettura del codice; NON ancora riprodotti con test)

| # | Problema | Gravità | Dove |
|---|---|---|---|
| S1 | `/files/[...path]` serve qualunque file in `STORAGE_DIR` **senza nessuna autenticazione**, con cache pubblica di un anno. Il percorso viene unito senza verificare che resti dentro la cartella (possibile path traversal: da testare). I backup, per impostazione predefinita, stanno in `STORAGE_DIR/backups` e le ricevute in `STORAGE_DIR/orders/...` | **Critica** | `app/files/[...path]/route.ts` |
| S2 | Alla conferma del checkout il PaymentIntent viene letto da Stripe, ma **non si confronta l'importo pagato né i metadati** con il totale ricalcolato. Possibile pagare un carrello economico e confermarne uno costoso con lo stesso `paymentIntentId` | **Critica** | `app/api/checkout/route.ts` (~righe 598-640) |
| S3 | L'ordine viene creato **solo quando il browser chiama la conferma**; il webhook aggiorna ordini esistenti ma non ne crea. Se il cliente chiude la pagina dopo aver pagato: pagamento senza ordine | Alta | `checkout/route.ts`, `stripe-payments.ts` |
| S4 | Webhook: l'evento è registrato prima dell'elaborazione; se questa fallisce, il nuovo tentativo di Stripe viene scartato come duplicato | Alta | `stripe-payments.ts` |
| S5 | Metodi `cash`, `po`, `invoice`, `quote`: ho trovato un blocco solo per `comped` (admin). Non ho verificato se un cliente comune può creare ordini senza pagare | Da verificare (potenzialmente alta) | `checkout/route.ts` |
| S6 | Il test esistente "upload visibility falls back to public for invalid or non-admin input" indica che **i file caricati da clienti non-admin sono pubblici per impostazione predefinita**. Da confermare leggendo il codice | Da verificare (potenzialmente alta) | `lib/upload-visibility.ts` |

## 7. Stato

- Attività 1.3 completata (solo analisi).
- Prossimi passi proposti: vedi `docs/PROGETTO.md`.
