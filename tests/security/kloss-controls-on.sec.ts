// R1-3 / KLOSS, P2 - the P0 controls ("green today and after every phase") once more, with CHECKOUT_OWNER_GUARD=on: what was right before the guard is right with it - a paid order with its one
// page, a cancelled order whose page is provably closed, independent guests, invalid cookies, the legacy locks - and the limit E2 is STILL a limit (not closed by P2).
// Nothing is defined here: the flag is set for this file's process and the controls are loaded as they are (tests/security/kloss-controls.sec.ts runs them with the guard off).
process.env.CHECKOUT_OWNER_GUARD = 'on'
require('./kloss-controls.sec')
