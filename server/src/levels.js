import { daysLeft } from './util.js';

// NDRRMC-style tiered alert levels
export const LEVELS = ['Advisory', 'Watch', 'Warning', 'Critical'];
export function levelFor(days, cfg) {
  if (days < 0) return 'Critical';
  if (days <= cfg.warn_days) return 'Warning';
  if (days <= cfg.watch_days) return 'Watch';
  return 'Advisory';
}
export const COLOR = { Advisory: 'green', Watch: 'yellow', Warning: 'orange', Critical: 'red' };
export const LABEL = { Advisory: 'Fresh', Watch: 'Use soon', Warning: 'Use today', Critical: 'Expired' };

export function describe(item, level) {
  const d = daysLeft(item.expires);
  if (level === 'Critical') return `Critical: ${item.name} has expired. Discard it to avoid waste and health risk.`;
  if (level === 'Warning') return `Warning: ${item.name} expires ${d <= 0 ? 'today' : 'tomorrow'}. Use it now.`;
  return `Watch: ${item.name} expires in ${d} days. Cook it soon.`;
}
export function decorate(item, cfg) {
  const daysLeftN = daysLeft(item.expires);
  const level = levelFor(daysLeftN, cfg);
  return { ...item, predicted: !!item.predicted, daysLeft: daysLeftN, level, color: COLOR[level], label: LABEL[level] };
}
