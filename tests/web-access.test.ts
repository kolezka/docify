import { expect, test } from "bun:test";
import { KINDS, admittedBy, kindLabel, removeMessage, ruleDetail, signInNote, type RuleInfo } from "../src/web/lib/access.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const rule = (over: Partial<RuleInfo> = {}): RuleInfo => ({ id: 1, kind: "org", value: "acme", createdAt: "2026-11-14T10:00:00Z", createdBy: "boss", people: 0, bound: false, ...over });

test("the pop-up offers the three kinds, the organization first", () => {
  expect(KINDS.map((k) => k.kind)).toEqual(["org", "login", "email"]);
  expect(kindLabel("email")).toBe("Email");
  for (const k of KINDS) expect(k.placeholder && k.hint).toBeTruthy();
});

test("an entry says what it is, how many people it let in and who added it", () => {
  expect(ruleDetail(rule(), NOW)).toBe("Organization · Nobody signed in yet · Added 2 h ago by boss");
  expect(ruleDetail(rule({ kind: "login", value: "alice", people: 1, createdBy: null }), NOW)).toBe("GitHub login · Let in 1 person · Added 2 h ago");
  expect(ruleDetail(rule({ people: 12 }), NOW)).toContain("Let in 12 people");
});

test("removing an entry is explained by what happens to the people it let in and to newcomers", () => {
  expect(removeMessage(rule(), "pending")).toBe("Nobody has signed in through this entry. From now on the people it covered wait for approval.");
  expect(removeMessage(rule({ people: 1 }), "refuse")).toBe(
    "1 person it let in is signed out, that person's MCP keys end, and the account waits for your approval. From now on other people it covered are refused.",
  );
  expect(removeMessage(rule({ people: 3 }), "pending")).toBe(
    "3 people it let in are signed out, their MCP keys end, and the accounts wait for your approval. From now on other people it covered wait for approval.",
  );
});

test("an account shows the entry that let it in", () => {
  expect(admittedBy({ kind: "org", value: "acme" })).toBe("Let in by organization acme");
  expect(admittedBy({ kind: "login", value: "alice" })).toBe("Let in by GitHub login alice");
  expect(admittedBy({ kind: "email", value: "a@example.com" })).toBe("Let in by email a@example.com");
});

test("the sign-in page says what GitHub will be asked for, and nothing more", () => {
  expect(signInNote(undefined)).toBe("Docify reads only your public GitHub profile: your login and name.");
  expect(signInNote({ orgs: false, emails: false })).toBe(signInNote(null));
  expect(signInNote({ orgs: true, emails: false })).toContain("your organization memberships as well as");
  expect(signInNote({ orgs: false, emails: true })).toContain("your email addresses as well as");
  expect(signInNote({ orgs: true, emails: true })).toContain("your organization memberships and your email addresses");
});
