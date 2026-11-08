import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as actions from "../web/server/actions";
import { checkedDraft } from "../web/server/dns";
import { elements, mountWithoutDom } from "./support/hook-harness";

/** The DNS record dialog, driven as an operator would. The server checks its draft (`checkDnsRecord`), so the answer can
 * arrive after the operator changed a field: it then speaks for a draft no longer shown, and is dropped. The check is
 * held here until the test answers it; the command the dialog sends is recorded, never run. */

const real = { ...actions };
let standingIn = false;
const held: { input: unknown; answer: () => void }[] = [];
const sent: RuntimeCommand[] = [];
mock.module("../web/server/actions", () => ({
  ...real,
  checkDnsRecord(input: unknown) {
    if (!standingIn) return real.checkDnsRecord(input);
    return new Promise((resolve) =>
      held.push({
        input,
        answer: () => resolve({ ok: true, value: checkedDraft(input) }),
      }),
    );
  },
  async runCommand(command: RuntimeCommand) {
    if (!standingIn) return real.runCommand(command);
    sent.push(command);
    return { ok: true, value: { operationId: command.operationId } };
  },
}));
beforeAll(() => {
  standingIn = true;
});
afterAll(() => {
  standingIn = false;
});
const { RecordDialog } = await import("../web/components/dns-records");

function dialog() {
  held.length = 0;
  sent.length = 0;
  let closed = false;
  const mounted = mountWithoutDom(RecordDialog);
  mounted.render({ zone: "example.com", onClose: () => (closed = true) });
  const find = (match: (props: Record<string, unknown>) => boolean) =>
    elements(mounted.tree).find((each) => match(each.props))!;
  const type = (id: string, value: string) =>
    mounted.act(() =>
      (
        find((props) => props.id === id).props.onChange as (
          event: unknown,
        ) => void
      )({
        target: { value },
      }),
    );
  const save = () =>
    mounted.act(() =>
      (
        find((props) => typeof props.onSubmit === "function").props
          .onSubmit as (event: unknown) => void
      )({ preventDefault() {} }),
    );
  const issues = (id: string) =>
    find((props) => props.htmlFor === id).props.issues;
  /** Answers the oldest held check, then gives the event loop turns for the dialog to act on it. */
  const answer = async () => {
    held.shift()!.answer();
    for (let turn = 0; turn < 20; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      mounted.render();
    }
  };
  return { type, save, issues, answer, closed: () => closed };
}

test("a field changed while its draft is checked keeps its issue cleared", async () => {
  const page = dialog();
  page.type("dns-name", "app");
  page.type("dns-content", "1.2.3");
  page.save();
  expect(held).toHaveLength(1);
  page.type("dns-content", "203.0.113.5");
  await page.answer();
  expect(page.issues("dns-content")).toBeUndefined();
  expect(sent).toEqual([]);
  // Unchanged while checked, the same draft's issue is shown.
  page.type("dns-content", "1.2.3");
  page.save();
  await page.answer();
  expect(page.issues("dns-content")).toEqual([
    "It must be an IPv4 address such as 100.64.0.1.",
  ]);
});

test("a draft changed while it is checked is not sent; the draft shown is sent once it is checked", async () => {
  const page = dialog();
  page.type("dns-name", "app");
  page.type("dns-content", "203.0.113.5");
  page.save();
  page.type("dns-name", "api");
  await page.answer();
  expect(sent).toEqual([]);
  expect(page.closed()).toBe(false);
  page.save();
  await page.answer();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    action: "dns-create",
    dns: { zone: "example.com", record: { name: "api.example.com" } },
  });
  expect(page.closed()).toBe(true);
});
