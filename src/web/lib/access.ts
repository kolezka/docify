import { ago } from "./format.ts";

export type RuleKind = "org" | "login" | "email";
export type Outsiders = "pending" | "refuse";

export interface RuleInfo {
  id: number;
  kind: RuleKind;
  value: string;
  createdAt: string;
  createdBy: string | null;
  // Accounts this entry let in.
  people: number;
  // A login entry is tied to the first GitHub account that signed in with it.
  bound: boolean;
}

export interface AccessInfo {
  outsiders: Outsiders;
  rules: RuleInfo[];
  maxOrgs: number;
  maxRules: number;
}

// The kinds in the order of the pop-up; the organization comes first because it covers the most people.
export const KINDS: { kind: RuleKind; label: string; placeholder: string; hint: string }[] = [
  { kind: "org", label: "Organization", placeholder: "acme", hint: "The organization's name at GitHub, as in github.com/acme. Every member gets in." },
  { kind: "login", label: "GitHub login", placeholder: "octocat", hint: "One person's GitHub login." },
  { kind: "email", label: "Email", placeholder: "name@example.com", hint: "An address the person has verified at GitHub." },
];

export const kindLabel = (kind: RuleKind): string => KINDS.find((k) => k.kind === kind)?.label ?? kind;

const count = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;

export function ruleDetail(rule: RuleInfo, now = Date.now()): string {
  const used = rule.people ? `Let in ${count(rule.people)}` : "Nobody signed in yet";
  return [kindLabel(rule.kind), used, `Added ${ago(rule.createdAt, now)}${rule.createdBy ? ` by ${rule.createdBy}` : ""}`].join(" · ");
}

// What removing an entry does, said before it happens.
export function removeMessage(rule: RuleInfo, outsiders: Outsiders): string {
  const later = outsiders === "refuse" ? "are refused" : "wait for approval";
  if (!rule.people) return `Nobody has signed in through this entry. From now on the people it covered ${later}.`;
  const one = rule.people === 1;
  return `${count(rule.people)} it let in ${one ? "is" : "are"} signed out, ${one ? "that person's" : "their"} MCP keys end, and ${one ? "the account waits" : "the accounts wait"} for your approval. From now on other people it covered ${later}.`;
}

// Shown under an account that an entry let in.
const IN_SENTENCE: Record<RuleKind, string> = { org: "organization", login: "GitHub login", email: "email" };
export const admittedBy = (rule: { kind: RuleKind; value: string }): string => `Let in by ${IN_SENTENCE[rule.kind] ?? rule.kind} ${rule.value}`;

// What the person shares with this server at GitHub, said on the sign-in page before they go there.
export function signInNote(asks: { orgs: boolean; emails: boolean } | null | undefined): string {
  const extra = [asks?.orgs && "your organization memberships", asks?.emails && "your email addresses"].filter(Boolean);
  if (!extra.length) return "Docify reads only your public GitHub profile: your login and name.";
  return `GitHub will ask to share ${extra.join(" and ")} as well as your public profile. Docify checks them against this server's access list and keeps neither.`;
}
