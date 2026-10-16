# Verifica del Passo 4.3 – pagina di ritorno da Stripe e consultazione degli ordini

Ramo `claude/stampa3d-fase1`. Descrizione del lavoro: `docs/CHECKOUT-S2-S3.md`, «Passo 4.3». Questo documento riporta **che cosa è stato provato, con quale mezzo, con quali cifre e che cosa non è stato provato**. Nulla qui sotto è una prova con Stripe reale o con telefoni veri: quelle verifiche restano «da eseguire» in `docs/CHECKLIST-PRELANCIO.md` (righe 1.26–1.29).

## 1. Ambiente delle prove

PostgreSQL 16 locale (`mkw_sectest`, porta 55432), `next start` in produzione (build con `NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR`), SDK Stripe vero con la rete simulata a livello HTTP (`tests/real-run/fake-stripe-http-preload.js`), Chromium con emulazione (1280×720 desktop, 393×851 `mobile` con tocco, 360×640 `mobile-small`). Dati fittizi.

## 2. Risultati

| Verifica | Mezzo | Esito |
|---|---|---|
| Tipi (`tsc --noEmit`) e `eslint` (0 avvisi) | locale | OK |
| `next build` | locale | OK |
| Unitari nuovi: `order-status-client` (8), `customer-order-labels` (4), `order-status-copy` (4) | `node --test` | 16/16 |
| Sicurezza nuova: `tests/security/s2s3-step43.sec.ts` (5, uno su database vero) | `node --test` | 5/5 |
| Suite completa `npm test` | `node --test` | 297/299 — i 2 fallimenti sono **preesistenti** e non riguardano questo passo (`global layout includes r3Dr parent-company branding`, `resolveSiblingRepoPath resolves suite repos beside MakerWorks`) |
| `npm run test:api` / `test:contracts` | `node --test` | 7/7 / 14/14 |
| `npm run test:security` (serie) | `node --test --test-concurrency=1` | 356/356 (0 `todo`) |
| e2e pagina di ritorno: `checkout-success.responsive.spec.ts`, 13 scenari × 3 formati | Playwright | 39/39 |
| e2e area cliente: `customer-orders.responsive.spec.ts`, 4 scenari × 3 formati (con seme `seed-customer-orders.ts`) | Playwright | 12/12 |
| Intera suite e2e (`npx playwright test`, build finale, 3 formati: pagina di ritorno, area cliente, `cart`, `checkout`, `printer-machines`, `buyer-journey`) | Playwright | 112 passati, 2 saltati (la prova da tastiera del checkout è solo per desktop e salta i due formati telefono), 1 fallito (`buyer-journey`, vedi riga seguente) |
| e2e preesistente `buyer-journey.spec.ts` | Playwright | **fallisce** alla riga 17 (cerca un pulsante «Add» sulla pagina del modello; il pulsante è nell'elenco *Discover*). Pagina non toccata da questo passo; **non rieseguito sul commit precedente**, quindi non posso dimostrare che fallisse già prima. Registrato in checklist 1.34 |
| Percorso reale `tests/real-run/checkout-return.ts` | `next start` + finto Stripe + Chromium desktop e telefono | 54/54 |
| Matrice `tests/real-run/checkout-matrix.ts` (18 scenari + 13 casi stampante; `STRICT_CART=1`) | come sopra | 62/62, 0 differenze preventivo/ordine/Stripe, 0 differenze carrello/preventivo |
| Guardie di produzione `tests/real-run/production-guards.ts` | `next start` | 8/8 |

## 3. Che cosa dimostrano i test nuovi

- **Il browser non dichiara il pagamento:** la pagina legge solo `order` dall'indirizzo; una risposta del server diversa da quella dell'endpoint è un errore; «Pagamento ricevuto» solo con `paid` del server; la scheda nascosta non viene interrogata; l'errore di rete non dice «fallito». (Unitari, sicurezza statica, e2e.)
- **Percorsi reali (54 verifiche):** ospite che torna con il webhook in ritardo → `paid` letto dal server; Stripe irraggiungibile → «in conferma» e poi `paid`, con al massimo 8 richieste e arresto delle richieste; sessione scaduta → `canceled`, carrello intatto; indirizzo di un vecchio ordine → carrello nuovo intatto; cliente registrato → collegamenti all'area cliente, elenco e dettaglio con le etichette giuste; estraneo → messaggio neutro.
- **Area cliente (database vero):** ordini propri sì, altrui no; abbandonato nello storico; denaro e dubbi mai nello storico; le etichette non modificano i dati.
- **Layout:** nessuno scorrimento orizzontale e bersagli ≥ 44 px su 3 formati; durante la prova a 360 px sono stati trovati e corretti due difetti reali (titoli lunghi che allargavano l'elenco, campo file del modulo di revisione).

## 4. Mutazioni (si rompe una cosa alla volta e si verifica che almeno un test fallisca)

**35 su 35 rilevate.**

- *Sul codice, 31* (unitari + sicurezza statica/su database): stato qualunque accettato; `final` o valuta non controllati; 404 trattato da errore; nuova richiesta dopo risposta finale o mentre `pending`; richieste che non si fermano mai; indicazione del server ignorata; `pending` o `canceled` che svuotano il carrello; marcatore qualunque accettato; id malformato inviato al server; `Retry-After` senza tetto; `no-store` tolto; `429` non riconosciuto; abbandonato che ignora `paidAt`, motivo di verifica, pagamento o pagamento in corso; denaro dopo annullamento non segnalato; non pagato mostrato come produzione; storico mai usato / usato per tutti gli annullati; preventivo di ristampa mostrato come produzione; pagina che legge `session_id`; pagina indicizzabile; `referrer` che perde l'id; stato `paid` costruito dalla pagina o dall'indirizzo; lettura del `localStorage`; stato inventato nel gancio; titolo di «non completato» che dice «Pagamento ricevuto».
- *Su build vere, 4:* (1) carrello svuotato senza controllare il marcatore → rilevata da e2e (3 formati) e dal percorso reale; (2) marcatore non scritto da `HostedCheckout` → rilevata dal percorso reale (6 controlli); (3) ordine non pagato con blocco di produzione → rilevata da e2e (3 formati) e dal percorso reale; (4) scheda nascosta ancora interrogata → rilevata da e2e (3 formati). La (4) **non** veniva rilevata al primo tentativo: la pagina ha due protezioni indipendenti (il timer scattato in scheda nascosta viene rimandato **e** il timer viene fermato al cambio di visibilità); togliendole entrambe il test fallisce. È una ridondanza voluta, non un buco.

## 5. Non provato

- **Stripe reale in modalità test** e il vero ritorno da `checkout.stripe.com` (1.26); parametri `success_url`/`cancel_url` accettati da Stripe reale.
- **iPhone/Safari e Android veri** (1.27–1.29): il cookie ospite `mw_checkout` (`HttpOnly`, `SameSite=Lax`, `Secure`) con prevenzione del tracciamento, navigazione privata, tasto Indietro, browser interni delle app. Chromium con emulazione **non è Safari**.
- Lettori di schermo reali (VoiceOver/TalkBack): è verificata solo la struttura (una regione `aria-live`).
- Dietro il proxy/CDN di produzione, con più istanze, con traffico reale sui limiti (1.17, 2.x).
- Il test `buyer-journey` (sopra) sul commit precedente.

## 6. Rischi residui

1. Un ospite con cookie scaduto (72 h) o in un altro browser non rivede l'ordine: messaggio neutro e assistenza (1.10); recupero via e-mail verificata solo predisposto, non implementato.
2. Fino a circa 2 minuti di «in conferma» se né il webhook né la lettura di Stripe riescono; poi la pagina smette di interrogare e dice che si può chiudere (il pagamento viene registrato comunque, ma una persona deve riaprire la pagina o l'area cliente). Il recupero automatico degli effetti in secondo piano è il Passo 5.
3. Nessuna notifica agli amministratori per le richieste di preventivo manuale (obbligatoria prima del lancio, anche solo via e-mail: 1.25).
4. Incoerenze commerciali già note e **bloccanti per il lancio**, non toccate perché richiedono autorizzazione: minimo per pezzo non applicato dopo il ridimensionamento (scenario 06: 1,35 € contro 5,00 €: 1.30); la riga della A1 mini include ancora TPU (1.23); colori dipendenti da StockWorks (1.31); importo minimo del negozio da scegliere (1.24).
5. Pagine dell'area cliente ancora in inglese (fase di traduzione); la barra fissa in alto a 360 px sborda di 13 px per gli utenti registrati (preesistente, 1.33).
6. Il carrello viene svuotato in base alla memoria della scheda del browser (`sessionStorage`): se il cliente completa il pagamento in un'altra scheda o in un altro browser, il carrello della scheda di partenza resta pieno. Il pagamento è comunque registrato dal server; il carrello rimasto pieno potrebbe però essere pagato una seconda volta per errore (per i clienti registrati la finestra anti-duplicati restituisce lo stesso ordine ancora aperto; per gli ospiti la protezione è la chiave di pagamento della scheda). Da osservare con Stripe reale (1.26).

## 7. Come rifare le prove

```
# build (la valuta va nota alla build)
NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run build

# unitari e sicurezza
DATABASE_URL=… JWT_SECRET=… npm test
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security

# percorso reale e matrice (avviano loro `next start`)
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/checkout-return.ts
SEC_TEST_DATABASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium STRICT_CART=1 node --import tsx tests/real-run/checkout-matrix.ts

# e2e su 3 formati (server già avviato su 3097; il seme crea clienti, ordini e un amministratore fittizi)
SEC_TEST_DATABASE_URL=… node --import tsx tests/e2e/seed-customer-orders.ts   # scrive E2E_FIXTURE
E2E_FIXTURE=… E2E_ADMIN_TOKEN=<adminToken del seme> E2E_BASE_URL=http://127.0.0.1:3097 E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test
```
