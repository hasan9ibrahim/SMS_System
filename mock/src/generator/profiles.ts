/**
 * Volume profiles. `full` is the production-like volume every screen must be
 * fast at (CLAUDE.md rule 4); `small` is for quick local runs and tests.
 */
export interface Profile {
  name: string;
  businessCompanies: number;
  users: number;
  accountManagers: number;
  enterprises: number;
  /** months of history for rates, invoices and AM handovers */
  historyMonths: number;
  /** fraction of the MCCMNC master a wholesale vendor covers */
  wholesaleCoverage: [number, number];
  /** destinations in a customer rate table */
  customerTableSize: [number, number];
  /** customer rate tables per customer trunk (some are shared) */
  customerTablesPerTrunk: number;
  routeRules: number;
  translationRules: number;
  hlrRules: number;
  numberLists: number;
  /** MO reference book entries (§6.1) */
  moNumbers: number;
  edrs: number;
  edrDays: number;
}

export const PROFILES: Record<string, Profile> = {
  small: {
    name: "small",
    businessCompanies: 2,
    users: 40,
    accountManagers: 10,
    enterprises: 80,
    historyMonths: 12,
    wholesaleCoverage: [0.15, 0.35],
    customerTableSize: [30, 250],
    customerTablesPerTrunk: 0.7,
    routeRules: 300,
    translationRules: 80,
    hlrRules: 30,
    numberLists: 12,
    moNumbers: 60,
    edrs: 200_000,
    edrDays: 3,
  },
  full: {
    name: "full",
    businessCompanies: 3,
    users: 140,
    accountManagers: 30,
    enterprises: 600,
    historyMonths: 18,
    wholesaleCoverage: [0.25, 0.85],
    customerTableSize: [60, 1400],
    customerTablesPerTrunk: 0.6,
    routeRules: 3000,
    translationRules: 800,
    hlrRules: 150,
    numberLists: 60,
    moNumbers: 600,
    edrs: 5_000_000,
    edrDays: 30,
  },
};
