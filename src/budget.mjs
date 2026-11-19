import Big from 'big.js';
import {json} from './io.mjs';

const VISUAL = 'visual-v5.1';
const positive = value => Number.isFinite(value) && value > 0;

// Keep the numeric keys readable by the previous implementation. Decimal totals
// prevent rounding noise accumulating across debits and credits. If an older
// writer changed the numeric mirror, adopt its ledger total on the next write.
async function dailyTotal(tx, day) {
  const numeric = (await tx.get('day:' + day)) ?? 0;
  const exact = await tx.get('day-decimal:' + day);
  return new Big(exact !== undefined && Number(exact) === numeric ? exact : numeric);
}

function dailyEntries(day, total) {
  return {['day:' + day]: total.toNumber(), ['day-decimal:' + day]: total.toString()};
}

function amounts(outcome, reserved, cost) {
  let retained = new Big(reserved);
  if (outcome === 'unsubmitted') retained = new Big(0);
  if (outcome === 'completed') {
    const cents = new Big(cost).round(2, Big.roundUp);
    if (cents.lt(retained)) retained = cents;
  }
  const refund = new Big(reserved).minus(retained);
  return {retained, refund};
}

export function matchesSettlement(receipt, id, authorized, outcome, cost) {
  if (!receipt || receipt.id !== id) return false;
  if (receipt.status === 'not_reserved') return outcome === 'unsubmitted' &&
    receipt.reserved === 0 && receipt.settled_usd === 0 && receipt.refunded_usd === 0;
  if (receipt.reserved !== authorized) return false;
  if (receipt.status === 'legacy_retained')
    return receipt.settled_usd === authorized && receipt.refunded_usd === 0;
  if (receipt.status !== 'confirmed' || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.day)) return false;
  const {retained, refund} = amounts(outcome, authorized, cost);
  return receipt.settled_usd === retained.toNumber() && receipt.refunded_usd === refund.toNumber();
}

export class EditorialBudgetCore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/reserve', '/release'].includes(path))
      return json({error:'Unknown budget operation'}, 404);
    const body = await request.json();
    if (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id) || !positive(body.amount))
      return json({error:'Invalid reservation identity or amount'}, 400);
    return this.ctx.storage.transaction(tx => path === '/reserve'
      ? this.reserve(tx, body) : this.release(tx, body));
  }

  async reserve(tx, {id, amount, kind}) {
    const prior = await tx.get('job:' + id);
    if (prior != null) return json({reserved:prior});
    const visualKey = 'visual-budget:' + id;
    if (await tx.get(visualKey)) return json({error:'Reservation already closed'}, 409);
    const day = new Date().toISOString().slice(0, 10);
    const limit = Number(this.env.EDITORIAL_DAILY_USD || 10);
    if (!positive(limit)) return json({error:'Invalid daily budget configuration'}, 400);
    const total = (await dailyTotal(tx, day)).plus(amount);
    if (total.gt(limit)) return json({error:'Daily editorial budget reservation limit reached. No inference started.'}, 409);
    const entries = {...dailyEntries(day, total), ['job:' + id]:amount};
    if (kind === VISUAL) entries[visualKey] = {day, authorized:amount, settlement:null};
    await tx.put(entries);
    return json({reserved:amount});
  }

  async release(tx, {id, amount, kind, outcome, estimated_cost_usd:cost}) {
    if (kind !== VISUAL || !['completed','unsubmitted','uncertain'].includes(outcome) ||
        (outcome === 'completed' && (!Number.isFinite(cost) || cost < 0)))
      return json({error:'Invalid settlement request'}, 400);
    const key = 'visual-budget:' + id;
    const record = await tx.get(key);
    const reserved = await tx.get('job:' + id);
    if (!record) {
      // Numeric-only records predate visual settlement or belong to whole-work
      // jobs. Their original day cannot be inferred from today's date.
      if (reserved != null && reserved !== amount) return json({error:'Reservation amount mismatch'}, 409);
      if (reserved != null)
        return json({id, status:'legacy_retained', reserved, settled_usd:reserved, refunded_usd:0});
      if (outcome !== 'unsubmitted') return json({error:'Unknown reservation'}, 409);
      // A lost reserve response can race recovery. Close the ID atomically so
      // a delayed reserve cannot charge after this no-reservation receipt.
      const settlement = {id, status:'not_reserved', reserved:0, settled_usd:0, refunded_usd:0};
      await tx.put(key, {day:null, authorized:amount, outcome, settlement});
      return json(settlement);
    }
    if (record.authorized !== amount) return json({error:'Reservation amount mismatch'}, 409);
    if (record.settlement) {
      if (record.outcome !== outcome || (outcome === 'completed' && record.cost !== cost))
        return json({error:'Conflicting settlement'}, 409);
      return json(record.settlement);
    }
    if (reserved !== amount) return json({error:'Ledger mismatch'}, 409);
    const {retained, refund} = amounts(outcome, reserved, cost);
    const total = (await dailyTotal(tx, record.day)).minus(refund);
    if (total.lt(0)) return json({error:'Inconsistent daily ledger'}, 409);
    const settlement = {id, status:'confirmed', day:record.day, reserved,
      settled_usd:retained.toNumber(), refunded_usd:refund.toNumber()};
    await tx.put({...dailyEntries(record.day, total),
      [key]:{...record, outcome, cost:outcome === 'completed' ? cost : null, settlement}});
    return json(settlement);
  }
}
