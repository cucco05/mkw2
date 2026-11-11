// R1-3 / KLOSS, P3 - the P0 controls ("green today and after every phase") once more, with CHECKOUT_OWNER_GUARD=on AND CHECKOUT_REPEAT_GUARD=on: what was right before the repeat gate is right with it -
// a paid order with its one page, a cancelled order whose page is provably closed, a session alone told nothing after a paid purchase, an account a day later and another customer never asked anything,
// independent guests, invalid cookies, the legacy locks - and the limit E2 is STILL a limit (not closed by P3).
// Nothing is defined here: the flags are set for this file's process and the controls are loaded as they are (kloss-controls.sec.ts runs them with both off, kloss-controls-on.sec.ts with the owner guard on).
process.env.CHECKOUT_OWNER_GUARD = 'on'
process.env.CHECKOUT_REPEAT_GUARD = 'on'
require('./kloss-controls.sec')
