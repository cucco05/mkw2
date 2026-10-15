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

## 8. Aggiornamento – S2/S3 Passo 1

Il calcolo prezzi non è più dentro `app/api/checkout/route.ts` (ora 556 righe, prima 939): vive in `lib/checkout-quote.ts` (contesto → righe → totali), insieme a `lib/tax.ts` (imposte) e a `toCents` / EUR in `lib/currency.ts`. Dipendenze nuove: nessun pacchetto npm; nuova tabella `PaymentAttempt` collegata a `PrintOrder`. `lib/checkout-quote.ts` importa gli stessi moduli che prima importava la route per i prezzi (modelli, sconti, regolazioni, tempi di consegna, visibilità, Stripe per la tariffa di spedizione). La tariffa di spedizione da Stripe (`STRIPE_SHIPPING_RATE_ID`) resta fino al Passo 2.

### Passo 2

Nuovi moduli (nessun pacchetto npm nuovo): `lib/checkout-orders.ts` (ordine in attesa, chiave e impronta), `lib/checkout-sessions.ts` (prenotazione + sessione Stripe), `lib/checkout-guards.ts`, `lib/checkout-api.ts`, `lib/guest-order-access.ts`, `lib/shipping.ts`, `lib/public-url.ts`; `lib/orders.ts` espone `buildOrderCreateData` (usata anche da `recordCustomerOrder`); `lib/rate-limit.ts` ha un contatore atomico per il checkout. Nuove route: `app/api/checkout/quote` e `app/api/checkout/session`. `lib/stripe-payments.ts` ha perso l'helper `buildStripeCheckoutSessionParams` (non usato, con paesi US/CA), sostituito dal costruttore di `lib/checkout-sessions.ts`. Dopo la rimozione del vecchio checkout (Passo 6) `@stripe/stripe-js` e `@stripe/react-stripe-js` non servono più al browser.

### Passo 3

Nuovi moduli (nessun pacchetto npm nuovo): `lib/payment-verification.ts` (verifica unica, pura, nessuna importazione di database o rete), `lib/payment-sync.ts` (permesso per ordine, lettura da Stripe, applicazione; importa `payment-verification`, `order-effects`, `stripe-metadata`, `checkout-sessions` per la finestra di unione dei tentativi, `shipping` per i paesi), `lib/order-effects.ts` (ricevuta, rapporto di producibilità, inventario StockWorks, PrintLab, Discord/push: gli stessi servizi di prima, ora chiamati dopo il pagamento verificato e non dentro la route), `lib/order-metadata.ts`, `lib/stripe-metadata.ts` (funzioni pure spostate). `lib/stripe-webhook.ts` si riduce a classificare l'evento e chiamare `syncPayment`; `lib/stripe-payments.ts` (225 righe) conserva solo la creazione del PaymentIntent, le fatture e i rimborsi e rimanda a `syncPayment`. `lib/receipts/order-receipts.ts` scrive i metadati tramite `updateOrderMetadata`. `app/api/checkout/route.ts` (574 righe) usa `verifyPaymentIntent` e `isLegacyCardCheckoutEnabled` (`lib/checkout-guards.ts`). Chi importa `payment-sync`: `stripe-webhook`, `stripe-payments`, `lib/orders.ts` (riconciliazione alla creazione dell'ordine del vecchio flusso). Migrazione `20261017120000_payment_sync_lease` (tre colonne su `PrintOrder`). Da ricordare per le semplificazioni future: nel **nuovo** flusso StockWorks (consumo inventario), PrintLab, Discord e push sono chiamati da `lib/order-effects.ts` (si disattivano modificando `effectHooks`); il vecchio checkout (`app/api/checkout/route.ts`) e le route admin esistenti li chiamano ancora direttamente fino al Passo 6.

### Passo 4.0

Nuovi moduli (nessun pacchetto npm nuovo): `lib/reprint.ts` (regole pure della ristampa; importato da `lib/orders.ts` e dalle pagine ordini del cliente), `lib/orderworks-inbound.ts` (interruttore del webhook OrderWorks in ingresso; importato solo da `app/api/makerworks/jobs/route.ts` e dal controllo ambiente admin), `lib/customer-order-view.ts` (elenco consentito dei campi dell'ordine per le API del cliente; importato da `app/api/customer/orders/*`). `lib/order-payment-policy.ts` espone ora `RESERVED_ORDER_METADATA_KEYS`/`sanitizeExternalMetadata` (usati da `lib/orders.ts`) e il motivo obbligatorio per le ristampe in `checkManualTransition`. `lib/payment-sync.ts` espone `syncHooks` (solo prove) e `PaymentSyncReadTimeoutError`. `lib/orderworks-link.ts`/`orderworks-sync.ts` considerano `paymentReviewReason`. Le rotte `app/api/customer/orders/*` usano `viewerGuards` (come le rotte admin) e quindi sono provabili senza cookie. Aiuti di prova: `tests/security/_payment-sync-child.ts` (processo separato lanciato da `payment-sync-multiprocess.sec.ts`). Le funzioni condivise di OrderWorks (`orderworks-status`, `orderworks-sync`, `orderworks-link`, `recordOrderWorksJob`, `createOrderFromJobForm`) **non sono state rimosse**.

### Passo 4.1

Nuovi moduli (nessun pacchetto npm nuovo): `lib/checkout-status.ts` (regole pure di accesso e di stato; importa solo `lib/guest-order-access.ts`), `lib/checkout-copy.ts` (testi italiani delle nuove pagine, centralizzati; importa solo il tipo degli stati), `app/api/checkout/status/route.ts` (importa `lib/viewer`, `lib/checkout-api` per i limiti, `lib/payment-sync` per la lettura da Stripe, `lib/checkout-status`). `lib/payment-sync.ts`: `syncPayment` accetta `effects: 'background'` e `maxWaitMs`. `lib/checkout-api.ts`: `enforceStatusRateLimit`, `allowStripeRefresh`, `leadTimeHours` nel preventivo. `lib/rate-limit.ts`: due nuove categorie di limite (`status`, `status_global`). `proxy.ts`: percorso pubblico `/checkout/success`. Nessuna dipendenza nuova verso OrderWorks, PrintLab o StockWorks.

### Passo 4.2

Nuovi moduli (nessun pacchetto npm nuovo): `lib/client-ip.ts` (indirizzo del cliente fidato solo dal proxy; importato da `lib/rate-limit.ts` → `getRequestIp`, da `lib/admin-audit.ts`, da `lib/checkout-api.ts` (`UNKNOWN_IP`), da `app/api/login/route.ts` (`lastLoginIp`) e da `app/api/admin/env-check/route.ts`), `lib/price-multiplier.ts` (tabella delle tolleranze e moltiplicatore dei prodotti; importato da `lib/checkout-quote.ts` e da `components/InstantQuoteConfigurator.tsx`), `lib/checkout-client.ts` (lato browser: richiesta, chiave di ripetizione, classificazione degli errori; importa solo `lib/cartPricing.ts` e tipi), `components/checkout/{HostedCheckout,QuoteSummary,useServerQuote}`, `app/checkout/page.tsx` (pagina del server) e `app/checkout/billing/page.tsx`. `components/checkout/LegacyCheckout.tsx` è la vecchia pagina `/checkout` spostata (importa ancora `CheckoutForm`, `OrderSummary`, `PayPalCheckoutButton` e `@stripe/stripe-js/pure`; **nessuna di queste importazioni è usata da `HostedCheckout`**, quindi il percorso degli ospiti non carica Stripe nel browser).

Modificati: `lib/checkout-quote.ts` (carica i prodotti, errori con codice e dettagli), `lib/checkout-api.ts` (`shippingOffer`, tipo `QuoteResponse`, limiti con indirizzo ignoto), `lib/checkout-copy.ts` (testi del checkout), `components/cart/CartProvider.tsx` (`ready`; la scrittura nel browser avviene solo dopo la lettura), `components/AppSidebar.tsx` (voce Cart per gli ospiti), `proxy.ts` (`/cart` e `/checkout` pubblici, percorsi esatti), `app/globals.css` (voci di menu alte 44 px), `playwright.config.ts` (progetti `mobile` e `mobile-small`), `tests/e2e/*`. Il controllo `LEGACY_CARD_CHECKOUT_ENABLED` e i pacchetti `@stripe/react-stripe-js` / `@stripe/stripe-js` restano (Passo 6).
