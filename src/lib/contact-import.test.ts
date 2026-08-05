import { describe, it, expect } from "vitest";
import {
  IMPORT_ATTESTATION_TEXT,
  autoDetectMapping,
  buildInsertNotes,
  buildMergePatch,
  dedupeWithinFile,
  mapRows,
  parseCsv,
  summaryHeadline,
  validateMapping,
  type ColumnMapping,
} from "./contact-import";

const CSV = `First Name,Surname,Company,Mobile,E-Mail,Comments,Subscribed
Jane,Doe,Doe Roofing,(501) 555-0142,JANE@doe.test,Repeat customer,Yes
Bob,Smith,,5015550143,bob@smith.test,,Yes
NoPhone,Person,,,nophone@x.test,orphan,Yes
Dup,Doe,,+15015550142,,second sighting,No
Bad,Number,,12,bad@x.test,,Yes
`;

describe("parseCsv", () => {
  it("reads headers and drops blank trailing rows", () => {
    const p = parseCsv(CSV);
    expect(p.headers).toEqual(["First Name", "Surname", "Company", "Mobile", "E-Mail", "Comments", "Subscribed"]);
    expect(p.rows).toHaveLength(5);
  });

  it("handles quotes, embedded commas and newlines", () => {
    const p = parseCsv('a,b\n"x, y","say ""hi""\nnext"\n');
    expect(p.rows[0]).toEqual(["x, y", 'say "hi"\nnext']);
  });
});

describe("autoDetectMapping", () => {
  it("matches common export header variants and never maps consent columns", () => {
    const p = parseCsv(CSV);
    const m = autoDetectMapping(p.headers);
    expect(m[0]).toBe("first_name");
    expect(m[1]).toBe("last_name");
    expect(m[2]).toBe("business_name");
    expect(m[3]).toBe("phone");
    expect(m[4]).toBe("email");
    expect(m[5]).toBe("notes");
    expect(m[6]).toBe(""); // "Subscribed" is ignored by design
  });
});

describe("validateMapping", () => {
  it("requires phone", () => {
    const r = validateMapping({ 0: "first_name" });
    expect(r.ok).toBe(false);
  });
  it("rejects duplicate targets", () => {
    const r = validateMapping({ 0: "phone", 1: "phone" });
    expect(r.ok).toBe(false);
  });
  it("accepts a valid mapping", () => {
    expect(validateMapping({ 0: "first_name", 3: "phone" }).ok).toBe(true);
  });
});

describe("mapRows", () => {
  const p = parseCsv(CSV);
  const mapping: ColumnMapping = autoDetectMapping(p.headers);
  const rows = mapRows(p, mapping);

  it("normalizes phone to E.164 and lowercases email", () => {
    expect(rows[0]!.phone).toBe("+15015550142");
    expect(rows[0]!.email).toBe("jane@doe.test");
    expect(rows[0]!.error).toBeNull();
  });

  it("flags missing and invalid phones instead of throwing", () => {
    expect(rows[2]!.error).toBe("Missing phone number");
    expect(rows[4]!.error).toMatch(/Invalid phone number/);
  });

  it("carries no consent field of any kind", () => {
    expect(Object.keys(rows[0]!)).not.toContain("opt_in_consent");
    expect(JSON.stringify(rows)).not.toMatch(/subscribed/i);
  });
});

describe("dedupeWithinFile", () => {
  it("collapses repeat phones, filling blanks from later rows", () => {
    const p = parseCsv(CSV);
    const rows = mapRows(p, autoDetectMapping(p.headers));
    const { rows: out, collapsed } = dedupeWithinFile(rows);
    expect(collapsed).toBe(1);
    expect(out).toHaveLength(4);
    const jane = out.find((r) => r.phone === "+15015550142")!;
    expect(jane.first_name).toBe("Jane"); // first row wins
    expect(jane.notes).toBe("Repeat customer");
  });
});

describe("buildMergePatch", () => {
  const row = mapRows(parseCsv("first,last,email,phone,notes\nNew,Name,new@x.test,5015550199,fresh note\n"), {
    0: "first_name",
    1: "last_name",
    2: "email",
    3: "phone",
    4: "notes",
  })[0]!;

  it("never overwrites existing real data", () => {
    const patch = buildMergePatch(
      { id: "1", first_name: "Real", last_name: "Person", email: "real@x.test", notes: "kept" },
      row,
    );
    expect(patch).toEqual({});
  });

  it("fills only blank fields", () => {
    const patch = buildMergePatch(
      { id: "1", first_name: "Real", last_name: null, email: "   ", notes: null },
      row,
    );
    expect(patch).toEqual({ last_name: "Name", email: "new@x.test", notes: "fresh note" });
    expect(patch).not.toHaveProperty("first_name");
  });

  it("never emits consent columns", () => {
    const patch = buildMergePatch({ id: "1", first_name: null, last_name: null, email: null, notes: null }, row);
    expect(Object.keys(patch)).not.toContain("opt_in_consent");
    expect(Object.keys(patch)).not.toContain("consent_form_signed");
  });
});

describe("buildInsertNotes", () => {
  it("folds business name into notes", () => {
    const rows = mapRows(parseCsv("c,p,n\nDoe Roofing,5015550142,hello\n"), { 0: "business_name", 1: "phone", 2: "notes" });
    expect(buildInsertNotes(rows[0]!)).toBe("Business: Doe Roofing — hello");
  });
});

describe("summaryHeadline", () => {
  it("reads like the required summary", () => {
    const line = summaryHeadline({
      totalRows: 150,
      imported: 142,
      updated: 0,
      matchedExisting: 0,
      skipped: 8,
      collapsedDuplicates: 0,
      skippedReasons: Array.from({ length: 8 }, (_, i) => ({ rowNumber: i, reason: "Missing phone number" })),
    });
    expect(line).toBe("142 imported, 8 skipped — missing phone number");
  });
});

describe("attestation text", () => {
  it("is exactly the required wording", () => {
    expect(IMPORT_ATTESTATION_TEXT).toBe(
      "I confirm these contacts have previously interacted with my business and I have a legitimate basis to add them to Temaro.",
    );
  });
});
