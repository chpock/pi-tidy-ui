import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerUsage, renderFooter } from "../src/footer.ts";

const theme = { fg: (_role: string, text: string) => text };
const data = { usage: footerUsage([]), auto: true, subscription: false };
const stats = "[··········] CH—";
const status = [["a", "CUSTOM"]] as const;
const rows = (gap: number, sessionName: string | undefined, statuses: readonly (readonly [string, string])[] = status) =>
  renderFooter(visibleWidth(stats) + gap + (statuses === status ? 6 : 0), { ...data, sessionName }, statuses, theme).map(stripVTControlCharacters);

test("footer session name uses only spare first-row columns and exact full-name gap boundaries", () => {
  assert.deepEqual(rows(15, "SESSION"), [stats + " • SESSION     CUSTOM"]);
  assert.deepEqual(rows(13, "SESSION"), [stats + " • SESSION • CUSTOM"]);
  assert.deepEqual(rows(12, "SESSION"), [stats + " • SESSI… • CUSTOM"]);
  assert.deepEqual(rows(11, "SESSION"), rows(11, undefined), "four-column prefix plus ellipsis is noise");
  assert.deepEqual(rows(11, "ABCDE"), [stats + " • ABCDE • CUSTOM"], "complete five-column name needs no ellipsis");
  assert.deepEqual(rows(10, "ABCDE"), rows(10, undefined));
});

test("footer session name omits trailing separator without a first-row custom status", () => {
  assert.deepEqual(rows(10, "SESSION", []), [stats + " • SESSION"]);
  assert.deepEqual(rows(9, "SESSION", []), [stats + " • SESSI…"]);
  assert.deepEqual(rows(8, "SESSION", []), [stats]);
  assert.deepEqual(rows(8, "ABCDE", []), [stats + " • ABCDE"]);
  assert.deepEqual(rows(7, "ABCDE", []), [stats]);
  const overflow = [["a", "STATUS_WIDER_THAN_THE_FIRST_ROW_SPARE_SPACE"]] as const;
  const baseline = rows(10, undefined, overflow);
  const named = rows(10, "SESSION", overflow);
  assert.equal(named[0], stats + " • SESSION");
  assert.deepEqual(named.slice(1), baseline.slice(1));
});

test("footer session name allows genuinely short complete names but never short fragments", () => {
  for (const name of ["X", "QA", "abc", "four", "界", "é", "👨‍👩‍👧‍👦"]) {
    const width = visibleWidth(name);
    assert.deepEqual(rows(width + 6, name), [stats + " • " + name + " • CUSTOM"]);
    assert.deepEqual(rows(width + 5, name), rows(width + 5, undefined));
    assert.deepEqual(rows(width + 3, name, []), [stats + " • " + name]);
    assert.deepEqual(rows(width + 2, name, []), [stats]);
  }
});

test("footer session name measures actual retained graphemes excluding ellipsis", () => {
  assert.deepEqual(rows(12, "界界界界"), rows(12, undefined), "five-column budget retains only four CJK columns");
  assert.deepEqual(rows(13, "界界界界"), [stats + " • 界界界… • CUSTOM"]);
  assert.deepEqual(rows(12, "Aé👨‍👩‍👧‍👦Bxyz"), [stats + " • Aé👨‍👩‍👧‍👦B… • CUSTOM"]);
  assert.deepEqual(rows(12, "ABC界界XYZ"), [stats + " • ABC界… • CUSTOM"]);
});

test("footer session name sanitizes presentation and adds nothing for empty names", () => {
  for (const name of [undefined, "", " \n\t ", "\x1b[31m\x1b[0m", "\u202e\u200b"]) assert.deepEqual(rows(30, name), rows(30, undefined));
  assert.deepEqual(rows(13, "\x1b[31mAB\n\tCD\u202e\x1b[0m"), [stats + " • AB CD     CUSTOM"]);
  assert.deepEqual(rows(9, "A \u202e B"), [stats + " • A B • CUSTOM"]);
  assert.deepEqual(rows(10, "SESSION", [["empty", "\x1b[31m\x1b[0m"]]), [stats + " • SESSION"]);
});

test("footer session name never repacks opaque statuses or changes later rows at any width", () => {
  const statuses = [["z", "LAST"], ["a", "\x1b[31mFIRST\x1b[0m"], ["b", "界é".repeat(30)]] as const;
  for (let width = 0; width <= 140; width++) {
    const baseline = renderFooter(width, data, statuses, theme);
    for (const sessionName of ["A", "SESSION", "界界界界", "👨‍👩‍👧‍👦".repeat(100)]) {
      const named = renderFooter(width, { ...data, sessionName }, statuses, theme);
      assert.equal(named.length, baseline.length);
      assert.deepEqual(named.slice(1), baseline.slice(1), `later rows at ${width}`);
      for (const row of named) assert.ok(visibleWidth(row) <= width);
      const original = stripVTControlCharacters(baseline[0] ?? "");
      const current = stripVTControlCharacters(named[0] ?? "");
      if (original.includes("FIRST")) assert.equal(visibleWidth(current.slice(0, current.indexOf("FIRST"))), visibleWidth(original.slice(0, original.indexOf("FIRST"))));
      assert.ok(!/^\s*•|•\s*$/u.test(current));
    }
  }
});

test("footer session name and ellipsis use muted while separators stay dim", () => {
  for (const [name, gap, expected] of [["SESSION", 13, "SESSION"], ["SESSION", 12, "SESSI…"], ["X", 7, "X"]] as const) {
    const paints: { role: string; text: string }[] = [];
    const paintTheme = { fg(role: string, text: string) { paints.push({ role, text }); return text; } };
    const rendered = renderFooter(visibleWidth(stats) + gap + 6, { ...data, sessionName: name }, status, paintTheme);
    assert.ok(rendered.map(stripVTControlCharacters).join(" ").includes(expected));
    assert.deepEqual(paints.filter(({ text }) => text === expected), [{ role: "muted", text: expected }]);
    assert.deepEqual(paints.filter(({ text }) => text === " • "), [{ role: "dim", text: " • " }]);
  }
});
